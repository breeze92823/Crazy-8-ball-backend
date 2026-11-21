import { MongoClient, type Collection } from "mongodb";

import type { AbilityState } from "./abilities.js";

import { LEADERBOARD_STATS } from "./constants.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// The persisted client state (what `saveProgress` carries, see sanitize.ts). The client keeps
// nothing in the browser: this document is the player's only save.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  username?: string; // display name as of the last save
  cash?: number; // in-game money
  wins?: number;
  streak?: number; // current win streak
  xp?: number; // ranked XP total
  rankClaimed?: number; // rank-division rewards granted so far
  tag?: string; // chat tag (TAG_PATTERN), "" = none
  tutorialDone?: boolean;
  abilityHintDone?: boolean;
  ability?: number; // ability meter, 0..ABILITY_MAX
  cues?: Record<string, number>; // owned cue id -> count
  cue?: string; // the equipped cue (an owned one), "" = none
  bag?: BagItem[]; // lucky blocks held
  hotbar?: string[]; // bag uids on the hotbar
  perks?: string[]; // one-off claims the client made (e.g. the starter cue)
  playtime?: number; // s with the game visible
  lastSeen?: number; // epoch ms of the last activity
  // Spin wheel (spin.ts): written only by the server's `spin` handler, never by saveProgress.
  spins?: number; // spins ready to use
  spinAt?: number; // epoch ms the next free spin arrives
  // Daily Reward + streak track (daily.ts): written by the server only, never by saveProgress.
  dailyDay?: number; // days unlocked this cycle
  dailyLast?: number; // UTC day index of the last unlock
  dailyClaimed?: number[]; // claimed day indexes this cycle
  trackDays?: number; // streak track steps (0..TRACK_DAYS)
  trackClaimed?: number[]; // claimed TRACK_MILESTONES indexes
  // Playtime gifts (gifts.ts): written by the server only, never by saveProgress.
  giftDay?: number; // UTC day index the counters belong to
  giftSecs?: number; // s played that day
  giftsClaimed?: number[]; // GIFT_MINUTES indexes claimed that day
  // Ability Spin (abilities.ts): slots, spins, pity, codes. Written by the server only, never by saveProgress.
  abilities?: AbilityState;
  // Server-counted matches (tables.ts results): the Wins leaderboard and profile stats. Server only.
  matchWins?: number;
  matchesPlayed?: number;
  // ISO country code from the roster's `stats` flag (the hub's Top Countries board). Server only.
  country?: string;
  version: number;
  updatedAt: Date;
}

// One lucky block held: a unique uid, its kind (client catalog id) and when it may be opened.
export interface BagItem {
  uid: string;
  kind: string;
  readyAt: number; // epoch ms
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const stat of LEADERBOARD_STATS) {
      players.createIndex({ [stat]: -1 }).catch((err) => console.warn(`[db] index on ${stat} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
