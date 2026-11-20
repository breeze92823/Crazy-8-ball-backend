import assert from "assert";

import { ABILITY_MAX, BAG_MAX, BAG_READY_MAX_MS, CUE_COUNT_MAX, CUES_MAX, CURRENCY_MAX, HOTBAR_MAX, RANK_LEVELS_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers and flags", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({
      cash: 1e40, wins: -5, streak: 3.7, xp: NaN, rankClaimed: 999, ability: 250, tutorialDone: "yes", abilityHintDone: true, hack: "x",
    })!;
    assert.strictEqual(out.cash, CURRENCY_MAX);
    assert.strictEqual(out.wins, 0);
    assert.strictEqual(out.streak, 3);
    assert.strictEqual(out.xp, undefined);
    assert.strictEqual(out.rankClaimed, RANK_LEVELS_MAX);
    assert.strictEqual(out.ability, ABILITY_MAX);
    assert.strictEqual(sanitizeProgress({ ability: 42.5 })!.ability, 42.5);
    assert.strictEqual(sanitizeProgress({ ability: -1 })!.ability, 0);
    assert.strictEqual(out.tutorialDone, undefined);
    assert.strictEqual(out.abilityHintDone, true);
    assert.ok(!("hack" in out));
  });

  it("never carries the old game's or the server-owned fields", () => {
    const out = sanitizeProgress({ trophies: 1, gems: 2, boats: ["raft"], pets: [], spins: 9, dailyDay: 7, trackDays: 28, giftSecs: 9999, giftsClaimed: [0], giftDay: 1 })!;
    assert.deepStrictEqual(out, {});
  });

  it("only keeps a capitals-and-spaces chat tag", () => {
    assert.strictEqual(sanitizeProgress({ tag: "VIP" })!.tag, "VIP");
    assert.strictEqual(sanitizeProgress({ tag: "" })!.tag, "");
    assert.strictEqual(sanitizeProgress({ tag: "vip" })!.tag, undefined);
    assert.strictEqual(sanitizeProgress({ tag: "A".repeat(17) })!.tag, undefined);
  });

  it("keeps whole cue counts and only equips an owned cue", () => {
    const out = sanitizeProgress({ cues: { oak: 2.9, gold: 0, "Bad Id!": 1, neg: -3, inf: Infinity, big: 1e12, s: "1" }, cue: "oak" })!;
    assert.deepStrictEqual(out.cues, { oak: 2, big: CUE_COUNT_MAX });
    assert.strictEqual(out.cue, "oak");
    assert.strictEqual(sanitizeProgress({ cues: { oak: 1 }, cue: "gold" })!.cue, undefined, "not owned");
    assert.strictEqual(sanitizeProgress({ cue: "gold" })!.cue, "gold", "no cues in this save: shape only");
    assert.strictEqual(sanitizeProgress({ cue: "" })!.cue, "");
    assert.strictEqual(sanitizeProgress({ cue: "Bad Id!" })!.cue, undefined);
    const many = Object.fromEntries(Array.from({ length: CUES_MAX + 10 }, (_, i) => [`c${i}`, 1]));
    assert.strictEqual(Object.keys(sanitizeProgress({ cues: many })!.cues!).length, CUES_MAX);
  });

  it("bounds the lucky-block bag and the hotbar", () => {
    const now = Date.now();
    const out = sanitizeProgress({
      bag: [
        { uid: "a1", kind: "common", readyAt: 5 },
        { uid: "a1", kind: "rare", readyAt: 5 },
        { uid: "b2", kind: "rare", readyAt: now + 1e12 },
        { uid: "c3", kind: "rare", readyAt: -9 },
        { uid: "bad uid", kind: "rare", readyAt: 0 },
        { uid: "d4", kind: "Bad Id!", readyAt: 0 },
        { uid: "e5", kind: "rare" },
        "x",
      ],
      hotbar: ["a1", "a1", "zz", "c3", 7],
    })!;
    assert.deepStrictEqual(out.bag!.map((b) => b.uid), ["a1", "b2", "c3"]);
    assert.strictEqual(out.bag![0].kind, "common");
    assert.ok(out.bag![1].readyAt <= Date.now() + BAG_READY_MAX_MS && out.bag![1].readyAt >= now + BAG_READY_MAX_MS);
    assert.strictEqual(out.bag![2].readyAt, 0);
    assert.deepStrictEqual(out.hotbar, ["a1", "c3"], "unique, and only uids in the bag");
    assert.deepStrictEqual(sanitizeProgress({ hotbar: ["zz", "yy"] })!.hotbar, ["zz", "yy"], "no bag in this save: shape only");
    const big = sanitizeProgress({
      bag: Array.from({ length: BAG_MAX + 5 }, (_, i) => ({ uid: `u${i}`, kind: "k", readyAt: 0 })),
      hotbar: Array.from({ length: 20 }, (_, i) => `u${i}`),
    })!;
    assert.strictEqual(big.bag!.length, BAG_MAX);
    assert.strictEqual(big.hotbar!.length, HOTBAR_MAX);
  });

  it("keeps well-formed perk ids", () => {
    assert.deepStrictEqual(sanitizeProgress({ perks: ["starterCue", "starterCue", "Bad Id!", 3] })!.perks, ["starterCue"]);
  });
});
