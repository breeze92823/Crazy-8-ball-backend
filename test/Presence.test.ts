import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { AVATAR_MAX_LEN, EMOTE_GAP_MS, POSE_BOUNDS, RANK_BADGE_MAX } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("presence", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("takes the pose, gear and look from the join options", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {
      userId: "guest-a",
      pose: { x: 3, y: 0.5, z: -12, yaw: Math.PI, speed: 4 },
      loadout: { cue: "dragonCue", tag: "VIP" },
      avatar: '{"equipped":{}}',
    });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.x, p.y, p.z, p.speed], [3, 0.5, -12, 4]);
    assert.ok(Math.abs(Math.abs(p.yaw) - Math.PI) < 1e-5);
    assert.deepStrictEqual([p.cue, p.tag], ["dragonCue", "VIP"]);
    assert.strictEqual(p.avatar, '{"equipped":{}}');
  });

  it("bounds poses and gear and relays them to the others", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    a.send("pose", { x: 1e9, y: "high", z: -1e12, yaw: 7, speed: -3 });
    a.send("loadout", { cue: "oak", tag: "PRO" });
    a.send("loadout", { cue: "Bad Id!", tag: "lower" });
    a.send("setAvatar", { avatar: "x".repeat(AVATAR_MAX_LEN + 1) });
    await sleep(100);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.x, POSE_BOUNDS.xy);
    assert.strictEqual(p.y, 0, "a non-number is ignored");
    assert.strictEqual(p.z, -POSE_BOUNDS.z);
    assert.ok(Math.abs(p.yaw - Math.atan2(Math.sin(7), Math.cos(7))) < 1e-5, "yaw wrapped to -PI..PI");
    assert.strictEqual(p.speed, 0);
    assert.deepStrictEqual([p.cue, p.tag], ["oak", "PRO"], "a malformed cue / tag is ignored");
    assert.strictEqual(p.avatar, "", "an oversized look is ignored");

    // b's synced copy of the roster sees a's presence.
    const seen = (b.state as any).players.get(a.sessionId);
    assert.strictEqual(seen.cue, "oak");
    assert.strictEqual(seen.x, POSE_BOUNDS.xy);
  });
  it("takes the players-list stats from the join options and bounds `stats`", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", stats: { wins: 12, cash: 700.9, rank: 2, flag: "LK", streak: 4 } });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.wins, p.cash, p.rank, p.flag, p.streak], [12, 700, 2, "LK", 4]);

    a.send("stats", { wins: -5, cash: 1e20, rank: 99, flag: "lk", streak: -2 });
    await sleep(150);
    assert.deepStrictEqual([p.wins, p.cash, p.rank, p.flag, p.streak], [0, 1e15, RANK_BADGE_MAX, "LK", 0], "clamped; a malformed flag is ignored");
    a.send("stats", { wins: 3.7, cash: "lots", flag: "" });
    await sleep(150);
    assert.deepStrictEqual([p.wins, p.cash, p.flag], [3, 1e15, ""], "whole wins; a non-number is ignored");
    const seen = (b.state as any).players.get(a.sessionId);
    assert.strictEqual(seen.wins, 3, "relayed to the others");
    a.send("stats", { streak: 2.9 });
    await sleep(150);
    assert.strictEqual(seen.streak, 2, "the win streak reaches the others (their name-tag flame)");
  });

  it("relays emotes with a sequence number, rate-limited, and stops them", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    a.send("emote", { id: "" });
    a.send("emote", { id: "Not An Id!" });
    await sleep(150);
    assert.deepStrictEqual([p.emote, p.emoteSeq], ["", 0], "nothing to stop / a malformed id is ignored");

    a.send("emote", { id: "wave" });
    a.send("emote", { id: "cheer" }); // inside EMOTE_GAP_MS: dropped
    await sleep(150);
    assert.deepStrictEqual([p.emote, p.emoteSeq], ["wave", 1]);
    await sleep(EMOTE_GAP_MS);
    a.send("emote", { id: "wave" }); // the same emote again restarts it
    await sleep(150);
    assert.deepStrictEqual([p.emote, p.emoteSeq], ["wave", 2]);
    a.send("emote", { id: "" }); // a stop is never rate-limited
    await sleep(150);
    assert.deepStrictEqual([p.emote, p.emoteSeq], ["", 3]);
    const seen = (b.state as any).players.get(a.sessionId);
    assert.strictEqual(seen.emoteSeq, 3, "relayed to the others");
  });
});
