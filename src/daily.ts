import { DAILY_DAYS, TRACK_DAYS, TRACK_MILESTONES } from "./constants.js";
import type { PlayerDoc } from "./db.js";

// Daily Reward (client daily window): a 7-day calendar on the SERVER's clock (UTC days), so a
// changed device clock can't unlock anything. Each new UTC day the player joins (or is online
// through midnight) unlocks one more day, up to DAILY_DAYS; unlocked days stay claimable until
// claimed (days need not be consecutive). Once all are claimed, the next new day starts a fresh
// cycle at day 1. `dailyUnlockAll` (paid for in cash client-side) unlocks the whole cycle at once.
// Every claimed daily also moves the 28-step streak track one step; its TRACK_MILESTONES rewards
// are claimed with `claimTrack`. Unlike the rest of the save, the client never writes these
// fields: claims go through messages (WorldRoom.ts) and only then does the client grant rewards.
export interface DailyState {
  day: number; // days unlocked this cycle (0..DAILY_DAYS)
  last: number; // UTC day index (utcDay) of the last unlock, -1 = never
  claimed: number[]; // claimed day indexes (0-based) this cycle
  trackDays: number; // streak track steps (0..TRACK_DAYS)
  trackClaimed: number[]; // claimed TRACK_MILESTONES indexes
}

export const DAY_MS = 86_400_000;
export const utcDay = (ms = Date.now()) => Math.floor(ms / DAY_MS);

const indexes = (raw: unknown, below: number) =>
  [...new Set((Array.isArray(raw) ? raw : []).filter((i): i is number => Number.isInteger(i) && i >= 0 && i < below))].sort((a, b) => a - b);

// The saved state from a player's doc (null / missing fields = a new player), bounded.
export function readDaily(doc: Partial<PlayerDoc> | null): DailyState {
  const day = Number.isInteger(doc?.dailyDay) ? Math.min(DAILY_DAYS, Math.max(0, doc!.dailyDay!)) : 0;
  const last = Number.isInteger(doc?.dailyLast) ? doc!.dailyLast! : -1;
  const trackDays = Number.isInteger(doc?.trackDays) ? Math.min(TRACK_DAYS, Math.max(0, doc!.trackDays!)) : 0;
  return { day, last, claimed: indexes(doc?.dailyClaimed, day), trackDays, trackClaimed: indexes(doc?.trackClaimed, TRACK_MILESTONES.length) };
}

// A copy, to put back when a change could not be stored.
export const copyDaily = (s: DailyState): DailyState => ({ ...s, claimed: [...s.claimed], trackClaimed: [...s.trackClaimed] });

// Unlocks today's day if it isn't yet. Returns true when the state changed (save it).
export function rollDaily(s: DailyState, today = utcDay()): boolean {
  if (s.last >= today) return false; // already rolled today (or the clock went back)
  if (s.day === 0 || s.claimed.length >= DAILY_DAYS) {
    s.day = 1;
    s.claimed = [];
  } else s.day = Math.min(DAILY_DAYS, s.day + 1);
  s.last = today;
  return true;
}

// Claims day `i` (0-based) if it is unlocked and unclaimed, and moves the track one step (a track
// whose milestones were all claimed starts over first).
export function claimDaily(s: DailyState, i: unknown): boolean {
  if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= s.day || s.claimed.includes(i as number)) return false;
  s.claimed.push(i as number);
  s.claimed.sort((a, b) => a - b);
  if (s.trackClaimed.length >= TRACK_MILESTONES.length) {
    s.trackDays = 0;
    s.trackClaimed = [];
  }
  s.trackDays = Math.min(TRACK_DAYS, s.trackDays + 1);
  return true;
}

// Unlocks every day of this cycle. False when they already are.
export function unlockAllDaily(s: DailyState): boolean {
  if (s.day >= DAILY_DAYS) return false;
  s.day = DAILY_DAYS;
  return true;
}

// Claims track milestone `i`: "locked" (bad index or not reached yet), "claimed", or null = done.
export function claimTrack(s: DailyState, i: unknown): "locked" | "claimed" | null {
  if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= TRACK_MILESTONES.length) return "locked";
  if (s.trackClaimed.includes(i as number)) return "claimed";
  if (s.trackDays < TRACK_MILESTONES[i as number]) return "locked";
  s.trackClaimed.push(i as number);
  s.trackClaimed.sort((a, b) => a - b);
  return null;
}

// What the client is sent: the state plus when the next UTC day starts (server clock).
export function dailyView(s: DailyState, now = Date.now()) {
  return {
    unlocked: s.day,
    claimed: [...s.claimed],
    nextAt: (utcDay(now) + 1) * DAY_MS,
    serverTime: now,
    track: { days: s.trackDays, claimed: [...s.trackClaimed] },
  };
}

// The doc fields that store it.
export const dailyFields = (s: DailyState) => ({
  dailyDay: s.day,
  dailyLast: s.last,
  dailyClaimed: [...s.claimed],
  trackDays: s.trackDays,
  trackClaimed: [...s.trackClaimed],
});
