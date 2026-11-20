import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { testServer } from "./server.js";
import { fakePlayers, sleep } from "./fakePlayers.js";

import { ABILITY_CODES, ABILITY_DEFAULT, ABILITY_IDS, ABILITY_PITY, ABILITY_START_SPINS, abilitiesFrom, abilityActions, freshAbilities, rollAbility } from "../src/abilities.js";

describe("ability spin rules", () => {
  it("starts a new player with Fire Shot in slot 1 and the starter spin", () => {
    const s = abilitiesFrom(undefined);
    assert.deepStrictEqual(s.slots, [ABILITY_DEFAULT, "", ""]);
    assert.strictEqual(s.unlocked, 1);
    assert.strictEqual(s.spins, ABILITY_START_SPINS);
  });

  it("cleans a forged / broken stored state", () => {
    const s = abilitiesFrom({ slots: ["hack", "blackHole", "magnet"], unlocked: 9, locked: [true, 1, true], equipped: 7, spins: -4, pity: 500, codes: ["FREESPINS", "NOPE", 3] });
    assert.strictEqual(s.unlocked, 3);
    assert.deepStrictEqual(s.slots, [ABILITY_DEFAULT, "blackHole", "magnet"]);
    assert.deepStrictEqual(s.locked, [true, false, true]);
    assert.strictEqual(s.equipped, 2);
    assert.strictEqual(s.spins, 0);
    assert.strictEqual(s.pity, ABILITY_PITY - 1);
    assert.deepStrictEqual(s.codes, ["FREESPINS"]);
    // slots past the unlocked count are dropped
    assert.deepStrictEqual(abilitiesFrom({ slots: ["magnet", "rewind"], unlocked: 1 }).slots, ["magnet", "", ""]);
  });

  it("rolls by rarity chance, and only Epic or better when forced", () => {
    assert.strictEqual(rollAbility(false, () => 0).id, "eaglesEye");
    assert.strictEqual(rollAbility(false, () => 0.9999999).id, "guangdongTiger");
    for (let i = 0; i < 200; i++) {
      const a = rollAbility(true);
      assert.ok(a.rank >= 3, `${a.id} is Epic or better`);
    }
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(rollAbility().id);
    for (const id of ["eaglesEye", "fireShot", "superBounce", "magnet", "rewind", "portals", "verity"]) assert.ok(seen.has(id), id);
    for (const id of seen) assert.ok(ABILITY_IDS.includes(id));
  });

  it("spins into the equipped slot, refuses a locked slot or no spins", () => {
    const s = freshAbilities();
    s.spins = 2;
    const r = abilityActions.spin(s, () => 0.5) as any;
    assert.ok(r.ok);
    assert.strictEqual(s.slots[0], r.id);
    assert.strictEqual(s.spins, 1);
    s.locked[0] = true;
    assert.deepStrictEqual(abilityActions.spin(s), { ok: false, reason: "locked" });
    assert.strictEqual(s.spins, 1);
    s.locked[0] = false;
    abilityActions.spin(s);
    assert.deepStrictEqual(abilityActions.spin(s), { ok: false, reason: "none" });
  });

  it("guarantees an Epic or better on the pity spin and resets the counter", () => {
    const s = freshAbilities();
    s.spins = ABILITY_PITY;
    for (let i = 0; i < ABILITY_PITY - 1; i++) {
      abilityActions.spin(s, () => 0); // always the commonest
      assert.strictEqual(s.pity, i + 1);
    }
    const r = abilityActions.spin(s, () => 0) as any;
    assert.ok(r.forced);
    assert.ok(["catchABall", "timeStop", "chainLightning", "steelBall", "blackFlash", "blackHole", "guangdongTiger"].includes(r.id));
    assert.strictEqual(s.pity, 0);
  });

  it("redeems each code once, any case", () => {
    const s = freshAbilities();
    const r = abilityActions.redeem(s, "  freespins ") as any;
    assert.ok(r.ok);
    assert.strictEqual(s.spins, ABILITY_START_SPINS + ABILITY_CODES.FREESPINS);
    assert.deepStrictEqual(abilityActions.redeem(s, "FREESPINS"), { ok: false, reason: "used" });
    assert.deepStrictEqual(abilityActions.redeem(s, "toString"), { ok: false, reason: "invalid" });
    assert.deepStrictEqual(abilityActions.redeem(s, 42), { ok: false, reason: "invalid" });
  });

  it("sells packs, unlocks slots in order, equips and locks only unlocked slots", () => {
    const s = freshAbilities();
    assert.ok(abilityActions.buy(s, 3).ok);
    assert.strictEqual(s.spins, ABILITY_START_SPINS + 50);
    assert.deepStrictEqual(abilityActions.buy(s, 9), { ok: false, reason: "pack" });
    assert.deepStrictEqual(abilityActions.unlockSlot(s, 2), { ok: false, reason: "slot" });
    assert.deepStrictEqual(abilityActions.equip(s, 1), { ok: false, reason: "slot" });
    assert.ok(abilityActions.unlockSlot(s, 1).ok);
    assert.strictEqual(s.unlocked, 2);
    assert.strictEqual(s.equipped, 1, "a new slot is equipped so the next spin fills it");
    assert.ok(abilityActions.lock(s, 0, true).ok);
    assert.ok(abilityActions.equip(s, 0).ok);
    assert.strictEqual(s.locked[0], true);
  });
});

describe("ability spin room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  async function join(userId: string, seed: any[] = []) {
    const fake = fakePlayers(seed);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId });
    const got: any = { view: null, results: [] as any[] };
    for (const t of ["progress", "noProgress", "spins", "gifts", "daily", "leaderboard"]) c.onMessage(t, () => {});
    c.onMessage("abilities", (m: any) => (got.view = m));
    c.onMessage("abilityResult", (m: any) => got.results.push(m));
    fake.release();
    await sleep(150);
    return { fake, c, got };
  }

  it("loads a signed-in player's abilities, spins on the server and stores them", async () => {
    const { fake, c, got } = await join("a1", [{ _id: "a1", cash: 9, abilities: { slots: ["magnet"], unlocked: 1, spins: 2, pity: 4, codes: [] }, version: 1, updatedAt: new Date() } as any]);
    assert.deepStrictEqual(got.view.slots, ["magnet", "", ""]);
    assert.strictEqual(got.view.spins, 2);

    c.send("abilitySpin");
    await sleep(150);
    const r = got.results[0];
    assert.ok(r.ok);
    assert.strictEqual(r.action, "abilitySpin");
    assert.ok(ABILITY_IDS.includes(r.id));
    assert.strictEqual(r.state.spins, 1);
    const doc = fake.docs.get("a1") as any;
    assert.strictEqual(doc.abilities.spins, 1);
    assert.strictEqual(doc.abilities.slots[0], r.id);
    assert.strictEqual(doc.cash, 9, "the rest of the save is untouched");

    c.send("abilityRedeem", { code: "freespins" });
    await sleep(120);
    c.send("abilityRedeem", { code: "FREESPINS" });
    await sleep(150);
    assert.ok(got.results[1].ok);
    assert.deepStrictEqual([got.results[2].ok, got.results[2].reason], [false, "used"]);
    assert.strictEqual((fake.docs.get("a1") as any).abilities.spins, 1 + ABILITY_CODES.FREESPINS);

    // A client save can't hand itself abilities or spins.
    c.send("saveProgress", { abilities: { spins: 999, slots: ["blackHole"] } });
    await sleep(150);
    assert.strictEqual((fake.docs.get("a1") as any).abilities.spins, 1 + ABILITY_CODES.FREESPINS);
  });

  it("refuses a guest's actions (its client runs the rules locally)", async () => {
    // (a guest's load answers before the test can listen: only the refusal is checked)
    const { fake, c, got } = await join("guest-z");
    c.send("abilitySpin");
    await sleep(150);
    assert.deepStrictEqual([got.results[0].ok, got.results[0].reason], [false, "guest"]);
    assert.strictEqual(fake.docs.size, 0);
  });
});
