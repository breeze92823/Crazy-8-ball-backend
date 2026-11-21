import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import type { WorldRoom } from "../src/rooms/WorldRoom.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { TABLE_TEAMS, TURN_MS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const ONE_V_ONE = TABLE_TEAMS.indexOf(1);
const TWO_V_TWO = TABLE_TEAMS.indexOf(2);
const balls = (dx = 0) => Array.from({ length: 48 }, (_, i) => (i % 3 === 2 ? 1 : i * 10 + dx));

// Collects every message of `types` a client receives.
function inbox(client: { onMessage: (type: string, fn: (m: any) => void) => void }, types: string[]) {
  const got: Record<string, any[]> = {};
  for (const type of types) {
    got[type] = [];
    client.onMessage(type, (m) => got[type].push(m));
  }
  return got;
}
const TYPES = ["matchStart", "mAim", "mShot", "mBalls", "mTurn", "mTeams"];

describe("pool tables (real-player matches)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("seats two players, counts down, starts a match and relays the shooter's turn", async () => {
    const room = (await colyseus.createRoom<WorldState>("world", {})) as unknown as WorldRoom;
    const a = await colyseus.connectTo(room as any, { userId: "guest-a", username: "Ann" });
    const b = await colyseus.connectTo(room as any, { userId: "guest-b", username: "Bo" });
    const ia = inbox(a, TYPES);
    const ib = inbox(b, TYPES);
    const t = room.state.tables.get(String(ONE_V_ONE))!;

    a.send("padJoin", { table: ONE_V_ONE });
    await sleep(50);
    assert.strictEqual(t.state, "waiting");
    assert.strictEqual(t.team0, a.sessionId);
    b.send("padJoin", { table: ONE_V_ONE });
    await sleep(50);
    assert.strictEqual(t.state, "countdown");
    assert.strictEqual(t.team1, b.sessionId);

    room.tables.tick(Date.now() + 5000);
    await sleep(50);
    assert.strictEqual(t.state, "match");
    assert.strictEqual(ia.matchStart.length, 1);
    const start = ib.matchStart[0];
    assert.deepStrictEqual(start.teams, [[a.sessionId], [b.sessionId]]);
    const shooter = start.shooter === a.sessionId ? a : b;
    const other = shooter === a ? b : a;
    const io = other === a ? ia : ib;

    // the other player can't shoot; the shooter's messages reach the other one
    other.send("mShot", { seq: start.seq, a: 0, s: 5 });
    shooter.send("mAim", { seq: start.seq, a: 1.5, p: 0.4, k: 3 });
    shooter.send("mAim", { seq: start.seq, a: 1.5, p: 0.4, k: 9 });
    shooter.send("mShot", { seq: start.seq, a: 1.5, s: 5, ab: "fireShot", x: 0.1, z: 0 });
    shooter.send("mBalls", { seq: start.seq, b: balls(), ev: [3, 4, 100, 1, 2] });
    await sleep(80);
    assert.strictEqual(io.mAim.length, 2);
    assert.strictEqual(io.mAim[0].k, 3, "the called pocket is relayed");
    assert.strictEqual(io.mAim[1].k, -1, "a bad pocket is dropped");
    assert.strictEqual(io.mShot.length, 1, "only the shooter's shot is relayed");
    assert.strictEqual(io.mShot[0].ab, "fireShot");
    assert.strictEqual(io.mBalls.length, 1);
    assert.deepStrictEqual(io.mBalls[0].ev, [3, 4, 100, 1, 2]);

    // the turn passes: the other player shoots next
    shooter.send("mEnd", { seq: start.seq, balls: balls(5), turn: 1 - start.turn, groups: ["solids", "stripes"], bih: true, foul: "Scratched", note: "kitchen", winner: -1 });
    await sleep(80);
    assert.strictEqual(ia.mTurn.length, 1);
    const turn = ib.mTurn[0];
    assert.strictEqual(turn.shooter, other.sessionId);
    assert.strictEqual(turn.seq, start.seq + 1);
    assert.strictEqual(turn.bih, true);
    assert.strictEqual(turn.note, "kitchen");
    assert.deepStrictEqual(turn.groups, ["solids", "stripes"]);
    assert.strictEqual(turn.balls[0], 5);

    // a stale seq is ignored
    shooter.send("mEnd", { seq: start.seq, balls: balls(), turn: 0, winner: 0 });
    await sleep(50);
    assert.strictEqual(t.state, "match");

    // the new shooter wins
    other.send("mEnd", { seq: turn.seq, balls: balls(), turn: turn.turn, winner: turn.turn, why: "Sank the 8 ball!" });
    await sleep(80);
    assert.strictEqual(t.state, "cooldown");
    const last = ia.mTurn[ia.mTurn.length - 1];
    assert.strictEqual(last.winner, turn.turn);
    assert.strictEqual(last.why, "Sank the 8 ball!");
    room.tables.tick(Date.now() + 10_000);
    assert.strictEqual(t.state, "open");
    assert.strictEqual(t.team0, "");
  });

  it("a silent shooter fouls, and a team that leaves forfeits", async () => {
    const room = (await colyseus.createRoom<WorldState>("world", {})) as unknown as WorldRoom;
    const a = await colyseus.connectTo(room as any, { userId: "guest-a", username: "Ann" });
    const b = await colyseus.connectTo(room as any, { userId: "guest-b", username: "Bo" });
    const ia = inbox(a, TYPES);
    a.send("padJoin", { table: ONE_V_ONE });
    b.send("padJoin", { table: ONE_V_ONE });
    await sleep(50);
    room.tables.tick(Date.now() + 5000);
    await sleep(50);
    const t = room.state.tables.get(String(ONE_V_ONE))!;
    const first = t.shooter;
    room.tables.tick(Date.now() + 5000 + TURN_MS + 1000);
    await sleep(50);
    assert.notStrictEqual(t.shooter, first, "the turn passed");
    assert.strictEqual(ia.mTurn[0].foul, "Ran out of time");

    // stepping off a pad mid-match does nothing; forfeiting ends it for the other team
    b.send("padLeave", {});
    await sleep(50);
    assert.strictEqual(t.team1, b.sessionId);
    b.send("mForfeit", {});
    await sleep(80);
    assert.strictEqual(t.state, "cooldown");
    const last = ia.mTurn[ia.mTurn.length - 1];
    assert.strictEqual(last.winner, 0);
    assert.match(last.why, /Bo left/);
  });

  it("team tables seat by pad and rotate a team's shooters; a leaving shooter hands over", async () => {
    const room = (await colyseus.createRoom<WorldState>("world", {})) as unknown as WorldRoom;
    const cs = [];
    for (let i = 0; i < 4; i++) cs.push(await colyseus.connectTo(room as any, { userId: `guest-${i}`, username: `P${i}` }));
    const inb = inbox(cs[0], TYPES);
    cs[0].send("padJoin", { table: TWO_V_TWO, team: 0 });
    cs[1].send("padJoin", { table: TWO_V_TWO, team: 0 });
    cs[2].send("padJoin", { table: TWO_V_TWO, team: 0 }); // full: refused
    await sleep(50);
    const t = room.state.tables.get(String(TWO_V_TWO))!;
    assert.strictEqual(t.team0.split(",").length, 2);
    assert.strictEqual(t.team1, "");
    cs[2].send("padJoin", { table: TWO_V_TWO, team: 1 });
    cs[3].send("padJoin", { table: TWO_V_TWO, team: 1 });
    await sleep(50);
    assert.strictEqual(t.state, "countdown");
    room.tables.tick(Date.now() + 5000);
    await sleep(50);
    const start = inb.matchStart[0];
    const bySid = new Map(cs.map((c) => [c.sessionId, c]));
    // pass the turn twice: the turn team's NEXT player shoots each time it gets the turn back
    let seq = start.seq;
    let turn = start.turn;
    const shooters: string[] = [start.shooter];
    for (let k = 0; k < 3; k++) {
      bySid.get(shooters[shooters.length - 1])!.send("mEnd", { seq, balls: balls(), turn: 1 - turn, bih: false, winner: -1 });
      await sleep(60);
      const m = inb.mTurn[inb.mTurn.length - 1];
      seq = m.seq;
      turn = m.turn;
      shooters.push(m.shooter);
    }
    assert.strictEqual(start.teams[start.turn][0], shooters[0]);
    assert.strictEqual(start.teams[start.turn][1], shooters[2], "the team's second player shoots its second turn");
    // the shooter leaves: their teammate shoots on, ball in hand
    const leaving = shooters[3];
    const team = start.teams.findIndex((m: string[]) => m.includes(leaving));
    const mate = start.teams[team].find((s: string) => s !== leaving);
    bySid.get(leaving)!.send("mForfeit", {});
    await sleep(80);
    const m = inb.mTurn[inb.mTurn.length - 1];
    assert.strictEqual(m.shooter, mate);
    assert.strictEqual(m.bih, true);
    assert.strictEqual(t.state, "match");
  });
});
