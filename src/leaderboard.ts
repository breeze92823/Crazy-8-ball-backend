import { FLAG_PATTERN, LEADERBOARD_COUNTRIES, LEADERBOARD_EVERY_MS, LEADERBOARD_SIZE, LEADERBOARD_STATS, type LeaderboardStat } from "./constants.js";
import { getPlayers } from "./db.js";

// The leaderboard boards: the top LEADERBOARD_SIZE saved players by each LEADERBOARD_STATS field
// (wins, xp), read from every saved doc. The top lists are one shared cache per process (every
// room reads it), refreshed at most every LEADERBOARD_EVERY_MS; each player's own rank is counted
// per refresh. Guests are never saved, so they never appear (their rank is null).

// Top Countries (the hub's second board): every saved player's `wins` summed per `country` (the
// ISO code their client reports in `stats`, stored by WorldRoom), all countries ranked, refreshed
// with the boards.

export interface LeaderRow {
  name: string;
  value: number;
  flag: string; // the player's country code, "" = unknown
}
export interface CountryRow {
  flag: string;
  value: number; // total wins
}
export type Boards = Record<LeaderboardStat, LeaderRow[]>;
export type Ranks = Record<LeaderboardStat, number | null>;

const empty = (): Boards => Object.fromEntries(LEADERBOARD_STATS.map((s): [string, LeaderRow[]] => [s, []])) as unknown as Boards;

let cache: { at: number; boards: Boards; countries: CountryRow[] } = { at: -Infinity, boards: empty(), countries: [] };
let inflight: Promise<Boards> | null = null;

// Top lists, from the cache while fresh. Never throws: no database / a failed read keeps the last lists.
export function topBoards(now = Date.now()): Promise<Boards> {
  if (now - cache.at < LEADERBOARD_EVERY_MS) return Promise.resolve(cache.boards);
  return (inflight ??= Promise.all([readBoards(), readCountries()])
    .then(([boards, countries]) => {
      cache = { at: Date.now(), boards, countries };
      return boards;
    })
    .catch((err) => {
      console.warn("[leaderboard] read failed", err);
      cache.at = Date.now(); // don't hammer a failing database
      return cache.boards;
    })
    .finally(() => (inflight = null)));
}

async function readBoards(): Promise<Boards> {
  const players = getPlayers();
  if (!players) return empty();
  const boards = empty();
  await Promise.all(
    LEADERBOARD_STATS.map(async (stat) => {
      const docs = await players
        .find({ [stat]: { $gt: 0 } }, { projection: { username: 1, country: 1, [stat]: 1 } })
        .sort({ [stat]: -1 })
        .limit(LEADERBOARD_SIZE)
        .toArray();
      boards[stat] = docs.map((d) => ({ name: d.username || "Player", value: Number(d[stat]) || 0, flag: typeof d.country === "string" && FLAG_PATTERN.test(d.country) ? d.country : "" }));
    }),
  );
  return boards;
}

// Every country with wins, most first (at most ~250 rows: one per country code).
async function readCountries(): Promise<CountryRow[]> {
  const players = getPlayers();
  if (!players) return [];
  const rows = await players
    .aggregate<{ _id: string; value: number }>([
      { $match: { wins: { $gt: 0 }, country: { $regex: FLAG_PATTERN.source } } },
      { $group: { _id: "$country", value: { $sum: "$wins" } } },
      { $sort: { value: -1, _id: 1 } },
    ])
    .toArray();
  return rows.map((r) => ({ flag: r._id, value: Math.floor(Number(r.value) || 0) }));
}

// The Top Countries board from the cache (topBoards() refreshes it): the first LEADERBOARD_COUNTRIES
// rows, and `flag`'s own place ({ flag, rank, value }, null when that country has no wins yet).
export function countryBoard(flag: string): { top: CountryRow[]; mine: { flag: string; rank: number; value: number } | null } {
  const i = flag ? cache.countries.findIndex((c) => c.flag === flag) : -1;
  return { top: cache.countries.slice(0, LEADERBOARD_COUNTRIES), mine: i >= 0 ? { flag, rank: i + 1, value: cache.countries[i].value } : null };
}

// A saved player's place on each board (1 = top), null when it has no score there or can't be read.
export async function ranksOf(userId: string): Promise<Ranks> {
  const ranks = Object.fromEntries(LEADERBOARD_STATS.map((s): [string, null] => [s, null])) as unknown as Ranks;
  const players = getPlayers();
  if (!userId || !players) return ranks;
  try {
    const doc = await players.findOne({ _id: userId }, { projection: Object.fromEntries(LEADERBOARD_STATS.map((s): [string, number] => [s, 1])) });
    if (!doc) return ranks;
    await Promise.all(
      LEADERBOARD_STATS.map(async (stat) => {
        const v = Number(doc[stat]);
        if (!(v > 0)) return;
        ranks[stat] = (await players.countDocuments({ [stat]: { $gt: v } })) + 1;
      }),
    );
  } catch (err) {
    console.warn("[leaderboard] rank read failed", err);
  }
  return ranks;
}

// Test-only: forget the cached lists.
export function __resetLeaderboardForTest(): void {
  cache = { at: -Infinity, boards: empty(), countries: [] };
  inflight = null;
}
