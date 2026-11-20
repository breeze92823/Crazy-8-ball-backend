import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { GIFT_MINUTES } from "../src/constants.js";
import { DAY_MS, utcDay } from "../src/daily.js";
import { advanceGifts, claimGift, readGifts } from "../src/gifts.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("playtime gift rules", () => {
  it("keeps today's counters and resets another day's", () => {
    const now = 100 * DAY_MS + 5000;
    assert.deepStrictEqual(readGifts({ giftDay: 100, giftSecs: 400.5, giftsClaimed: [1, 1, 0, 9, -1] as number[] }, now), { day: 100, secs: 400.5, claimed: [0, 1] });
    assert.deepStrictEqual(readGifts({ giftDay: 99, giftSecs: 4000, giftsClaimed: [0] }, now), { day: 100, secs: 0, claimed: [] });
    assert.deepStrictEqual(readGifts(null, now), { day: 100, secs: 0, claimed: [] });
  });

  it("counts connected time and starts over at UTC midnight", () => {
    const s = readGifts(null, 100 * DAY_MS);
    assert.ok(!advanceGifts(s, 100 * DAY_MS, 100 * DAY_MS + 60_000));
    assert.strictEqual(s.secs, 60);
    advanceGifts(s, 100 * DAY_MS + 60_000, 100 * DAY_MS + 120_000, false);
    assert.strictEqual(s.secs, 60, "disconnected time does not count");
    s.claimed = [0];
    // Online across midnight: only the time after it counts towards the new day.
    assert.ok(advanceGifts(s, 101 * DAY_MS - 10_000, 101 * DAY_MS + 3000));
    assert.deepStrictEqual(s, { day: 101, secs: 3, claimed: [] });
  });

  it("only claims a reached, unclaimed gift", () => {
    const s = readGifts(null, 0);
    s.secs = GIFT_MINUTES[1] * 60;
    assert.strictEqual(claimGift(s, 2), "locked");
    assert.strictEqual(claimGift(s, 1), null);
    assert.strictEqual(claimGift(s, 1), "claimed");
    assert.strictEqual(claimGift(s, GIFT_MINUTES.length), "locked");
    assert.strictEqual(claimGift(s, "0"), "locked");
    assert.deepStrictEqual(s.claimed, [1]);
  });
});

describe("playtime gifts room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends today's gifts after the load, claims on the server's count and stores it", async () => {
    const today = utcDay();
    const fake = fakePlayers([{ _id: "g1", wins: 1, giftDay: today, giftSecs: 250, giftsClaimed: [], version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "g1" });
    let gifts: any = null;
    const results: any[] = [];
    c.onMessage("progress", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("gifts", (m: any) => (gifts = m));
    c.onMessage("giftResult", (m: any) => results.push(m));
    c.send("claimGift", { i: 0 });
    await sleep(50);
    assert.deepStrictEqual([results[0]?.ok, results[0]?.reason], [false, "loading"]);
    fake.release();
    await sleep(150);
    assert.strictEqual(gifts?.secs, 250);
    assert.deepStrictEqual([gifts?.claimed, gifts?.day, gifts?.nextResetAt], [[], today, (today + 1) * DAY_MS]);
    assert.ok(typeof gifts?.serverTime === "number");

    c.send("claimGift", { i: 0 }); // 250 s < 5 min
    await sleep(150);
    assert.deepStrictEqual([results[1].ok, results[1].i, results[1].reason], [false, 0, "locked"]);

    (room as any).__addGiftSecsForTest(c.sessionId, 60);
    c.send("claimGift", { i: 0 });
    c.send("claimGift", { i: 0 });
    await sleep(150);
    assert.deepStrictEqual(results.slice(2).map((r) => [r.ok, r.reason]).sort(), [[false, "claimed"], [true, undefined]].sort());
    const ok = results.find((r) => r.ok);
    assert.ok(ok.secs >= 310);
    assert.deepStrictEqual(ok.claimed, [0]);
    const doc = fake.docs.get("g1") as any;
    assert.deepStrictEqual([doc.giftDay, doc.giftsClaimed], [today, [0]]);
    assert.ok(doc.giftSecs >= 310);

    // saveProgress can't touch them.
    c.send("saveProgress", { wins: 2, giftDay: 0, giftSecs: 99999, giftsClaimed: [0, 1, 2, 3, 4] });
    await sleep(150);
    const after = fake.docs.get("g1") as any;
    assert.strictEqual(after.wins, 2);
    assert.deepStrictEqual([after.giftDay, after.giftsClaimed], [today, [0]]);
    assert.ok(after.giftSecs < 99999);
  });

  it("resets at UTC midnight and tells the client", async () => {
    const today = utcDay();
    const fake = fakePlayers([{ _id: "g2", giftDay: today, giftSecs: 4000, giftsClaimed: [0, 1], version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "g2" });
    const sent: any[] = [];
    c.onMessage("progress", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("gifts", (m: any) => sent.push(m));
    fake.release();
    await sleep(150);
    assert.strictEqual(sent.length, 1);
    (room as any).tickGifts((today + 1) * DAY_MS + 2000);
    await sleep(100);
    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual([sent[1].day, sent[1].secs, sent[1].claimed], [today + 1, 2, []]);
    const doc = fake.docs.get("g2") as any;
    assert.deepStrictEqual([doc.giftDay, doc.giftsClaimed], [today + 1, []], "the reset is stored");
  });

  it("stores the gift clock when the player leaves", async () => {
    const today = utcDay();
    const fake = fakePlayers([{ _id: "g3", giftDay: today, giftSecs: 10, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "g3" });
    c.onMessage("progress", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("gifts", () => {});
    await sleep(150);
    (room as any).__addGiftSecsForTest(c.sessionId, 100);
    await c.leave();
    await sleep(150);
    const doc = fake.docs.get("g3") as any;
    assert.ok(doc.giftSecs >= 110);
    assert.ok(typeof doc.lastSeen === "number");
  });

  it("keeps a guest's gifts in memory for the connection", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-g" });
    let result: any = null;
    c.onMessage("noProgress", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("gifts", () => {});
    c.onMessage("giftResult", (m: any) => (result = m));
    await sleep(150);
    (room as any).__addGiftSecsForTest(c.sessionId, GIFT_MINUTES[4] * 60);
    c.send("claimGift", { i: 4 });
    await sleep(150);
    assert.strictEqual(result?.ok, true);
    assert.deepStrictEqual(result?.claimed, [4]);
    assert.strictEqual(fake.docs.size, 0, "a guest is never written");
  });
});
