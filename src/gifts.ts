import { GIFT_MINUTES } from "./constants.js";
import { DAY_MS, utcDay } from "./daily.js";
import type { PlayerDoc } from "./db.js";

// Playtime gifts (client gifts window): GIFT_MINUTES thresholds of time played TODAY (UTC day,
// server clock). The server counts each loaded session's connected time (WorldRoom.ts ticks it),
// so a client can't fast-forward it; a new UTC day resets the seconds and the claims. The client
// only grants a gift after `giftResult` ok.
export interface GiftState {
  day: number; // UTC day index the counters belong to
  secs: number; // s played that day (fractional while counting)
  claimed: number[]; // GIFT_MINUTES indexes claimed that day
}

const fresh = (day: number): GiftState => ({ day, secs: 0, claimed: [] });

// The saved state from a player's doc (null / another day = a fresh day), bounded.
export function readGifts(doc: Partial<PlayerDoc> | null, now = Date.now()): GiftState {
  const today = utcDay(now);
  if (!doc || doc.giftDay !== today) return fresh(today);
  const secs = typeof doc.giftSecs === "number" && Number.isFinite(doc.giftSecs) ? Math.min(DAY_MS / 1000, Math.max(0, doc.giftSecs)) : 0;
  const raw = Array.isArray(doc.giftsClaimed) ? doc.giftsClaimed : [];
  const claimed = [...new Set(raw.filter((i) => Number.isInteger(i) && i >= 0 && i < GIFT_MINUTES.length))].sort((a, b) => a - b);
  return { day: today, secs, claimed };
}

// Moves the clock from `from` to `to` (epoch ms). `counting` = the session was connected, so the
// time is added. A new UTC day resets first (only the time after midnight counts). Returns true
// when it reset (tell the client).
export function advanceGifts(s: GiftState, from: number, to: number, counting = true): boolean {
  const today = utcDay(to);
  let reset = false;
  if (today > s.day) {
    Object.assign(s, fresh(today));
    from = Math.max(from, today * DAY_MS);
    reset = true;
  }
  if (counting && to > from) s.secs = Math.min(DAY_MS / 1000, s.secs + (to - from) / 1000);
  return reset;
}

// Claims gift `i`: "locked" (bad index or not played long enough), "claimed", or null = done.
export function claimGift(s: GiftState, i: unknown): "locked" | "claimed" | null {
  if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= GIFT_MINUTES.length) return "locked";
  if (s.claimed.includes(i as number)) return "claimed";
  if (s.secs < GIFT_MINUTES[i as number] * 60) return "locked";
  s.claimed.push(i as number);
  s.claimed.sort((a, b) => a - b);
  return null;
}

// What the client is sent (whole seconds).
export function giftsView(s: GiftState, now = Date.now()) {
  return { secs: Math.floor(s.secs), claimed: [...s.claimed], day: s.day, nextResetAt: (s.day + 1) * DAY_MS, serverTime: now };
}

// The doc fields that store it.
export const giftFields = (s: GiftState) => ({ giftDay: s.day, giftSecs: Math.floor(s.secs), giftsClaimed: [...s.claimed] });
