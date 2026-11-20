import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { DAILY_DAYS, TRACK_DAYS, TRACK_MILESTONES } from "../src/constants.js";
import { claimDaily, claimTrack, readDaily, rollDaily, unlockAllDaily, utcDay } from "../src/daily.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("daily reward rules", () => {
  it("unlocks one day per new UTC day and starts over once every day is claimed", () => {
    const s = readDaily(null);
    assert.ok(rollDaily(s, 100));
    assert.deepStrictEqual(s, { day: 1, last: 100, claimed: [], trackDays: 0, trackClaimed: [] });
    assert.ok(!rollDaily(s, 100), "once per day");
    assert.ok(rollDaily(s, 105), "days need not be consecutive");
    assert.strictEqual(s.day, 2);
    for (let d = 106; d < 120; d++) rollDaily(s, d);
    assert.strictEqual(s.day, DAILY_DAYS, "capped while days are unclaimed");
    for (let i = 0; i < DAILY_DAYS; i++) assert.ok(claimDaily(s, i));
    assert.ok(rollDaily(s, 120));
    assert.deepStrictEqual(s, { day: 1, last: 120, claimed: [], trackDays: DAILY_DAYS, trackClaimed: [] });
  });

  it("only claims unlocked, unclaimed days and bounds a stored state", () => {
    const s = readDaily({ dailyDay: 2, dailyLast: 7, dailyClaimed: [0, 0, 5, -1, 1.5] as number[] });
    assert.deepStrictEqual(s.claimed, [0]);
    assert.ok(!claimDaily(s, 0), "already claimed");
    assert.ok(!claimDaily(s, 2), "not unlocked yet");
    assert.ok(!claimDaily(s, "1"));
    assert.ok(claimDaily(s, 1));
    assert.ok(!rollDaily(s, 6), "a clock going back unlocks nothing");
    assert.strictEqual(readDaily({ dailyDay: 99 }).day, DAILY_DAYS);
    assert.strictEqual(readDaily({ trackDays: 99 }).trackDays, TRACK_DAYS);
    assert.deepStrictEqual(readDaily({ trackClaimed: [3, 3, 0, 4, -1] as number[] }).trackClaimed, [0, 3]);
  });

  it("unlocks the whole cycle at once", () => {
    const s = readDaily(null);
    rollDaily(s, 100);
    assert.ok(unlockAllDaily(s));
    assert.strictEqual(s.day, DAILY_DAYS);
    assert.ok(!unlockAllDaily(s), "already all unlocked");
    for (let i = 0; i < DAILY_DAYS; i++) assert.ok(claimDaily(s, i));
    assert.ok(rollDaily(s, 101));
    assert.strictEqual(s.day, 1, "all claimed: a new cycle the next day");
  });

  it("moves the streak track one step per claimed daily and claims milestones once reached", () => {
    const s = readDaily({ dailyDay: DAILY_DAYS, trackDays: TRACK_MILESTONES[0] - 1 });
    assert.strictEqual(claimTrack(s, 0), "locked");
    assert.ok(claimDaily(s, 0));
    assert.strictEqual(s.trackDays, TRACK_MILESTONES[0]);
    assert.strictEqual(claimTrack(s, 0), null);
    assert.strictEqual(claimTrack(s, 0), "claimed");
    assert.strictEqual(claimTrack(s, 1), "locked");
    assert.strictEqual(claimTrack(s, 9), "locked", "no such milestone");
    assert.strictEqual(claimTrack(s, "1"), "locked");

    // Capped at TRACK_DAYS; once every milestone is claimed the next daily restarts the track.
    const t = readDaily({ dailyDay: DAILY_DAYS, trackDays: TRACK_DAYS });
    assert.ok(claimDaily(t, 0));
    assert.strictEqual(t.trackDays, TRACK_DAYS);
    for (let i = 0; i < TRACK_MILESTONES.length; i++) assert.strictEqual(claimTrack(t, i), null);
    assert.ok(claimDaily(t, 1));
    assert.deepStrictEqual([t.trackDays, t.trackClaimed], [1, []]);
  });
});

describe("daily reward room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("unlocks today on join, stores claims and refuses a second claim", async () => {
    const today = utcDay();
    const fake = fakePlayers([{ _id: "d1", dailyDay: 1, dailyLast: today - 1, dailyClaimed: [0], version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "d1" });
    let daily: any = null;
    const results: any[] = [];
    c.onMessage("progress", () => {});
    c.onMessage("daily", (m: any) => (daily = m));
    c.onMessage("dailyResult", (m: any) => results.push(m));
    fake.release();
    await sleep(150);
    assert.strictEqual(daily?.unlocked, 2);
    assert.deepStrictEqual(daily?.claimed, [0]);
    assert.strictEqual(daily?.nextAt, (today + 1) * 86_400_000);
    assert.deepStrictEqual(daily?.track, { days: 0, claimed: [] });
    assert.strictEqual((fake.docs.get("d1") as any).dailyLast, today);

    c.send("claimDaily", { day: 1 });
    c.send("claimDaily", { day: 1 });
    c.send("claimDaily", { day: 2 });
    await sleep(150);
    // The good claim answers after its write, so the refusals may come first.
    assert.strictEqual(results.length, 3);
    assert.deepStrictEqual(results.filter((r) => r.ok).map((r) => r.day), [1]);
    assert.deepStrictEqual((fake.docs.get("d1") as any).dailyClaimed, [0, 1]);
    assert.strictEqual((fake.docs.get("d1") as any).trackDays, 1, "the track moved in the same write");
    assert.deepStrictEqual(results.find((r) => r.ok).track, { days: 1, claimed: [] });

    // saveProgress can't touch the server-owned fields.
    c.send("saveProgress", { wins: 1, dailyDay: 7, dailyClaimed: [], trackDays: 28, trackClaimed: [0, 1, 2, 3] });
    await sleep(150);
    assert.strictEqual((fake.docs.get("d1") as any).dailyDay, 2);
    assert.deepStrictEqual((fake.docs.get("d1") as any).dailyClaimed, [0, 1]);
    assert.strictEqual((fake.docs.get("d1") as any).trackDays, 1);
    assert.deepStrictEqual((fake.docs.get("d1") as any).trackClaimed, []);
  });

  it("unlocks every day for the cycle and stores it", async () => {
    const today = utcDay();
    const fake = fakePlayers([{ _id: "d2", dailyDay: 1, dailyLast: today, dailyClaimed: [0], version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "d2" });
    const results: any[] = [];
    c.onMessage("progress", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("dailyResult", () => {});
    c.onMessage("dailyUnlockResult", (m: any) => results.push(m));
    c.send("dailyUnlockAll", {});
    await sleep(50);
    assert.deepStrictEqual([results[0]?.ok, results[0]?.reason], [false, "loading"]);
    fake.release();
    await sleep(150);
    c.send("dailyUnlockAll", {});
    await sleep(150);
    assert.strictEqual(results[1]?.ok, true);
    assert.strictEqual(results[1]?.unlocked, DAILY_DAYS);
    assert.strictEqual((fake.docs.get("d2") as any).dailyDay, DAILY_DAYS);
    c.send("dailyUnlockAll", {});
    c.send("claimDaily", { day: 6 });
    await sleep(150);
    assert.deepStrictEqual([results[2]?.ok, results[2]?.reason], [false, "done"]);
    assert.deepStrictEqual((fake.docs.get("d2") as any).dailyClaimed, [0, 6]);
  });

  it("claims a reached track milestone once, stored", async () => {
    const today = utcDay();
    const fake = fakePlayers([{ _id: "d3", dailyDay: 3, dailyLast: today, dailyClaimed: [], trackDays: 13, trackClaimed: [0], version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "d3" });
    const results: any[] = [];
    c.onMessage("progress", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("dailyResult", () => {});
    c.onMessage("trackResult", (m: any) => results.push(m));
    fake.release();
    await sleep(150);
    c.send("claimTrack", { i: 1 });
    c.send("claimTrack", { i: 0 });
    await sleep(150);
    assert.deepStrictEqual(results.map((r) => [r.ok, r.i, r.reason]), [[false, 1, "locked"], [false, 0, "claimed"]]);
    c.send("claimDaily", { day: 0 }); // 13 -> 14 = milestone 1
    await sleep(150);
    c.send("claimTrack", { i: 1 });
    await sleep(150);
    assert.deepStrictEqual([results[2].ok, results[2].i], [true, 1]);
    assert.deepStrictEqual(results[2].track, { days: 14, claimed: [0, 1] });
    assert.deepStrictEqual((fake.docs.get("d3") as any).trackClaimed, [0, 1]);
  });

  it("reports a track claim that could not be stored and keeps it unclaimed", async () => {
    const today = utcDay();
    const fake = fakePlayers([{ _id: "d4", dailyDay: 1, dailyLast: today, trackDays: 8, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "d4" });
    let result: any = null;
    c.onMessage("progress", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("trackResult", (m: any) => (result = m));
    fake.release();
    await sleep(150);
    (fake as any).updateOne = async () => {
      throw new Error("down");
    };
    c.send("claimTrack", { i: 0 });
    await sleep(150);
    assert.deepStrictEqual([result?.ok, result?.reason], [false, "save"]);
    assert.deepStrictEqual(result?.track, { days: 8, claimed: [] });
  });

  it("gives a guest a session-only calendar", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-q" });
    let result: any = null;
    c.onMessage("noProgress", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("dailyResult", (m: any) => (result = m));
    await sleep(150);
    c.send("claimDaily", { day: 0 });
    await sleep(150);
    assert.strictEqual(result?.ok, true);
    assert.deepStrictEqual(result?.track, { days: 1, claimed: [] }, "the track lives in memory too");
    assert.strictEqual(fake.docs.size, 0, "a guest is never written");
  });
});
