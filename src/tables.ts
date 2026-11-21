// The hub's pool tables, run by the server so every match is between real players.
//
// Pads: `padJoin` { table, team } seats the sender (1v1: by join order; team tables: the pad's team),
// `padLeave` {} stands them up. A full table counts down TABLE_COUNTDOWN_MS, then the match starts:
// `matchStart` { table, matchId, seq, seed, teams, turn, shooter } to everyone (spectators rack too).
//
// Turns: the shooter's client runs the physics and the rules. It relays `mAim` { seq, a, p, x?, z?, k }
// while aiming, `mShot` { seq, a, s, ab, x, z, ... } when it strikes, `mBalls` { seq, b, ev } while the
// balls roll, and `mEnd` { seq, balls, turn, groups, bih, foul, note, winner, why, distract } once they
// settle. Only the current shooter's messages for the current `seq` count; the server picks the next
// shooter (a team's players take turns) and answers everyone `mTurn` { table, matchId, seq, balls,
// turn, shooter, teams, groups, bih, foul, note, winner, why, distract }. A shooter who goes silent
// (TURN_MS / ROLL_MS) fouls ("Ran out of time"); a player who leaves the match forfeits for their team
// once nobody of it is left (else a teammate takes over). A won match cools down, then the table opens.
import { MapSchema } from "@colyseus/schema";
import { TableState } from "./rooms/schema/WorldState.js";
import { BALL_COORD_MAX, BALL_EVENTS_MAX, MATCH_TEXT_MAX, ROLL_MS, TABLE_COOLDOWN_MS, TABLE_COUNTDOWN_MS, TABLE_TEAMS, TURN_MS } from "./constants.js";

type Send = (type: string, msg: unknown, exceptSid?: string) => void;
// Match results for the room (server-counted wins / matches, the rewarded-ad window).
export interface TableHooks {
  start?(players: string[]): void;
  end?(winners: string[], players: string[]): void;
}
const GROUPS = new Set(["", "solids", "stripes"]);
// group: a team got its group; rewind / timeStop: abilities; rerack: an illegal break, re-racked for
// the other team to break; kitchen: a scratch on the break, ball in hand behind the head string.
const NOTES = new Set(["", "group", "rewind", "timeStop", "rerack", "kitchen"]);

interface Run {
  seq: number;
  idx: [number, number]; // each team's current shooter index
  deadline: number; // server ms: the backstop for this turn / shot
  shot: boolean; // the shooter struck this turn
  groups: [string, string];
  bih: boolean;
}

const splitSids = (s: string) => (s ? s.split(",") : []);
const text = (v: unknown) => (typeof v === "string" ? v.slice(0, MATCH_TEXT_MAX) : "");
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// 16 balls x [x, z, on] whole 1e-4 m, or null.
export function cleanBalls(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== 48) return null;
  const out: number[] = [];
  for (let i = 0; i < 48; i++) {
    const v = raw[i];
    if (!finite(v)) return null;
    out.push(i % 3 === 2 ? (v ? 1 : 0) : Math.max(-BALL_COORD_MAX, Math.min(BALL_COORD_MAX, Math.round(v))));
  }
  return out;
}
// Events [type, n, speed, x, z] x k (whole numbers), at most BALL_EVENTS_MAX.
function cleanEvents(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const n = Math.min(BALL_EVENTS_MAX, Math.floor(raw.length / 5)) * 5;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    out.push(finite(v) ? Math.max(-BALL_COORD_MAX, Math.min(BALL_COORD_MAX, Math.round(v))) : 0);
  }
  return out;
}
const packBalls = (b: number[]) => {
  const rows: string[] = [];
  for (let i = 0; i < 48; i += 3) rows.push(`${b[i]},${b[i + 1]},${b[i + 2]}`);
  return rows.join(";");
};
const unpackBalls = (s: string): number[] | null => (s ? cleanBalls(s.split(/[;,]/).map(Number)) : null);

export class Tables {
  readonly runs = new Map<string, Run>();

  constructor(
    private tables: MapSchema<TableState>,
    private send: Send,
    private nameOf: (sid: string) => string,
    private hooks: TableHooks = {},
  ) {
    TABLE_TEAMS.forEach((_, i) => {
      if (!tables.has(String(i))) tables.set(String(i), new TableState());
    });
  }

  private teams(t: TableState): [string[], string[]] {
    return [splitSids(t.team0), splitSids(t.team1)];
  }
  private setTeams(t: TableState, teams: [string[], string[]]) {
    t.team0 = teams[0].join(",");
    t.team1 = teams[1].join(",");
  }
  private seated(t: TableState) {
    return splitSids(t.team0).length + splitSids(t.team1).length;
  }
  // The table a session sits at, if any.
  tableOf(sid: string): [string, TableState] | null {
    for (const [id, t] of this.tables) if (this.teams(t).some((m) => m.includes(sid))) return [id, t];
    return null;
  }

  // Seats `sid` on table `table` (team: the pad's team on team tables). True when seated.
  join(sid: string, table: unknown, team: unknown): boolean {
    const id = typeof table === "number" && Number.isInteger(table) ? String(table) : "";
    const t = this.tables.get(id);
    const size = TABLE_TEAMS[Number(id)];
    if (!t || !size || !["open", "waiting", "countdown"].includes(t.state)) return false;
    const at = this.tableOf(sid);
    if (at?.[0] === id) return true;
    const teams = this.teams(t);
    let side: number;
    if (size === 1) side = teams[0].length < 1 ? 0 : 1;
    else side = team === 0 || team === 1 ? team : -1;
    if (side < 0 || teams[side].length >= size) return false;
    if (at) this.leave(sid, "pad");
    teams[side].push(sid);
    this.setTeams(t, teams);
    if (t.state === "open") t.state = "waiting";
    if (this.seated(t) >= size * 2) {
      t.state = "countdown";
      t.startsAt = Date.now() + TABLE_COUNTDOWN_MS;
    }
    return true;
  }

  // Stands `sid` up. "pad" = stepped off (not during a match), "forfeit" = left the match,
  // "gone" = left the room. In a match: the team forfeits once empty, else a teammate shoots on.
  leave(sid: string, why: "pad" | "forfeit" | "gone") {
    const at = this.tableOf(sid);
    if (!at) return;
    const [id, t] = at;
    if (why === "pad" && t.state === "match") return;
    const teams = this.teams(t);
    const side = teams[0].includes(sid) ? 0 : 1;
    teams[side] = teams[side].filter((m) => m !== sid);
    this.setTeams(t, teams);
    if (t.state === "match") {
      const run = this.runs.get(id);
      if (!run) return;
      if (!teams[side].length) return this.endMatch(id, t, run, 1 - side, `${this.nameOf(sid)} left the match`);
      this.send("mTeams", { table: Number(id), matchId: t.matchId, teams });
      if (t.shooter === sid) {
        // a teammate takes the shot over, ball in hand
        run.idx[side] = run.idx[side] % teams[side].length;
        this.nextTurn(id, t, run, { turn: side, bih: true, foul: "", note: "", balls: unpackBalls(t.balls), keepShooter: true });
      }
      return;
    }
    if (t.state === "countdown") t.state = "waiting";
    if ((t.state === "waiting" || t.state === "countdown") && !this.seated(t)) t.state = "open";
  }

  private start(id: string, t: TableState, now: number) {
    const teams = this.teams(t);
    const turn = Math.random() < 0.5 ? 0 : 1;
    const run: Run = { seq: 1, idx: [-1, -1], deadline: now + TURN_MS, shot: false, groups: ["", ""], bih: false };
    run.idx[turn] = 0;
    this.runs.set(id, run);
    t.state = "match";
    t.matchId = (t.matchId + 1) % 65536;
    t.turn = turn;
    t.shooter = teams[turn][0];
    t.balls = "";
    const seed = Math.random();
    this.hooks.start?.(teams.flat());
    this.send("matchStart", { table: Number(id), matchId: t.matchId, seq: run.seq, seed, teams, turn, shooter: t.shooter });
  }

  // The current turn of the sender's match, if `msg.seq` is it and the sender shoots it.
  private turnOf(sid: string, msg: unknown): [string, TableState, Run] | null {
    const at = this.tableOf(sid);
    if (!at || at[1].state !== "match" || at[1].shooter !== sid) return null;
    const run = this.runs.get(at[0]);
    if (!run || (msg as { seq?: unknown })?.seq !== run.seq) return null;
    return [at[0], at[1], run];
  }

  aim(sid: string, msg: { a?: unknown; p?: unknown; x?: unknown; z?: unknown; k?: unknown }) {
    const cur = this.turnOf(sid, msg);
    if (!cur || cur[2].shot || !finite(msg.a)) return;
    // k: the pocket called for the 8 ball (0..5, -1 = none)
    const k = Number.isInteger(msg.k) && (msg.k as number) >= 0 && (msg.k as number) <= 5 ? (msg.k as number) : -1;
    const out: Record<string, unknown> = { table: Number(cur[0]), seq: cur[2].seq, a: msg.a, p: finite(msg.p) ? Math.max(0, Math.min(1, msg.p)) : 0, k };
    if (finite(msg.x) && finite(msg.z)) {
      out.x = Math.max(-3, Math.min(3, msg.x));
      out.z = Math.max(-3, Math.min(3, msg.z));
    }
    this.send("mAim", out, sid);
  }

  shot(sid: string, msg: { a?: unknown; s?: unknown; sx?: unknown; sy?: unknown; el?: unknown; ab?: unknown; x?: unknown; z?: unknown }) {
    const cur = this.turnOf(sid, msg);
    if (!cur || cur[2].shot || !finite(msg.a) || !finite(msg.s)) return;
    const [id, , run] = cur;
    run.shot = true;
    run.deadline = Date.now() + ROLL_MS;
    const num = (v: unknown, lo: number, hi: number) => (finite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
    this.send(
      "mShot",
      { table: Number(id), seq: run.seq, a: msg.a, s: num(msg.s, 0, 20), sx: num(msg.sx, -1, 1), sy: num(msg.sy, -1, 1), el: num(msg.el, 0, 1), ab: typeof msg.ab === "string" && /^[A-Za-z]{0,32}$/.test(msg.ab) ? msg.ab : "", x: num(msg.x, -3, 3), z: num(msg.z, -3, 3) },
      sid,
    );
  }

  balls(sid: string, msg: { b?: unknown; ev?: unknown }) {
    const cur = this.turnOf(sid, msg);
    if (!cur || !cur[2].shot) return;
    const b = cleanBalls(msg.b);
    if (!b) return;
    cur[1].balls = packBalls(b); // where they are now, should the shooter go quiet
    this.send("mBalls", { table: Number(cur[0]), seq: cur[2].seq, b, ev: cleanEvents(msg.ev) }, sid);
  }

  // The shooter's outcome of the turn (its rules decided it).
  end(sid: string, msg: { balls?: unknown; turn?: unknown; groups?: unknown; bih?: unknown; foul?: unknown; note?: unknown; winner?: unknown; why?: unknown; distract?: unknown }) {
    const cur = this.turnOf(sid, msg);
    if (!cur) return;
    const [id, t, run] = cur;
    const balls = cleanBalls(msg.balls);
    if (!balls || (msg.turn !== 0 && msg.turn !== 1)) return;
    const g = Array.isArray(msg.groups) ? msg.groups : [];
    if (GROUPS.has(g[0]) && GROUPS.has(g[1])) run.groups = [g[0], g[1]];
    if (msg.winner === 0 || msg.winner === 1) {
      t.balls = packBalls(balls);
      return this.endMatch(id, t, run, msg.winner, text(msg.why));
    }
    this.nextTurn(id, t, run, { turn: msg.turn, bih: msg.bih === true, foul: text(msg.foul), note: NOTES.has(msg.note as string) ? (msg.note as string) : "", balls, distract: msg.distract === true });
  }

  private nextTurn(id: string, t: TableState, run: Run, o: { turn: number; bih: boolean; foul: string; note: string; balls: number[] | null; distract?: boolean; keepShooter?: boolean }) {
    const teams = this.teams(t);
    const team = teams[o.turn];
    if (!team.length) return this.endMatch(id, t, run, 1 - o.turn, "The other team left");
    if (o.turn !== t.turn && !o.keepShooter) run.idx[o.turn] = (run.idx[o.turn] + 1) % team.length;
    run.idx[o.turn] = Math.max(0, run.idx[o.turn]) % team.length;
    t.turn = o.turn;
    t.shooter = team[run.idx[o.turn]];
    if (o.balls) t.balls = packBalls(o.balls);
    run.seq++;
    run.shot = false;
    run.bih = o.bih;
    run.deadline = Date.now() + TURN_MS;
    this.send("mTurn", { table: Number(id), matchId: t.matchId, seq: run.seq, balls: o.balls ?? unpackBalls(t.balls), turn: t.turn, shooter: t.shooter, teams, groups: run.groups, bih: o.bih, foul: o.foul, note: o.note, winner: -1, why: "", distract: !!o.distract });
  }

  private endMatch(id: string, t: TableState, run: Run, winner: number, why: string) {
    run.seq++;
    t.state = "cooldown";
    t.startsAt = Date.now() + TABLE_COOLDOWN_MS;
    t.shooter = "";
    this.runs.delete(id);
    const teams = this.teams(t);
    this.hooks.end?.(teams[winner] ?? [], teams.flat());
    this.send("mTurn", { table: Number(id), matchId: t.matchId, seq: run.seq, balls: unpackBalls(t.balls), turn: t.turn, shooter: "", teams, groups: run.groups, bih: false, foul: "", note: "", winner, why, distract: false });
  }

  // Countdowns, cooldowns and the silent-shooter backstop.
  tick(now = Date.now()) {
    for (const [id, t] of this.tables) {
      if (t.state === "countdown" && now >= t.startsAt) {
        if (this.seated(t) >= (TABLE_TEAMS[Number(id)] ?? 1) * 2) this.start(id, t, now);
        else t.state = this.seated(t) ? "waiting" : "open";
      } else if (t.state === "cooldown" && now >= t.startsAt) {
        Object.assign(t, { state: "open", team0: "", team1: "", shooter: "", balls: "", startsAt: 0 });
      } else if (t.state === "match") {
        const run = this.runs.get(id);
        if (run && now >= run.deadline) this.nextTurn(id, t, run, { turn: 1 - t.turn, bih: true, foul: "Ran out of time", note: "", balls: unpackBalls(t.balls) });
      }
    }
  }
}
