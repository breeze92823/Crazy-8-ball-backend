import {
  ABILITY_MAX, BAG_MAX, BAG_READY_MAX_MS, CUE_COUNT_MAX, CUES_MAX, CURRENCY_MAX, HOTBAR_MAX, ID_PATTERN, IDS_MAX,
  PLAY_SECONDS_MAX, RANK_LEVELS_MAX, STREAK_MAX, TAG_PATTERN, UID_PATTERN, WINS_MAX, XP_MAX,
} from "./constants.js";
import type { BagItem, PlayerDoc } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
export const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
export const isTag = (v: unknown): v is string => typeof v === "string" && TAG_PATTERN.test(v);
const isUid = (v: unknown): v is string => typeof v === "string" && UID_PATTERN.test(v);

// Catalog ids (perks): slug strings, no duplicates, bounded count.
export function sanitizeIds(raw: unknown, max = IDS_MAX): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isId))].slice(0, max);
}

// Owned cues { id: count }: slug ids, whole counts 1..CUE_COUNT_MAX (0 / negative / non-finite
// entries are dropped), at most CUES_MAX kinds.
export function sanitizeCues(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  let n = 0;
  for (const [id, count] of Object.entries(raw)) {
    if (n >= CUES_MAX) break;
    if (!isId(id) || !finite(count) || count < 1) continue;
    out[id] = clampInt(count, CUE_COUNT_MAX, 1);
    n++;
  }
  return out;
}

// Lucky blocks held [{ uid, kind, readyAt }]: unique uids, slug kinds, readyAt clamped to at most
// BAG_READY_MAX_MS ahead of the server clock; at most BAG_MAX.
export function sanitizeBag(raw: unknown, now = Date.now()): BagItem[] {
  if (!Array.isArray(raw)) return [];
  const out: BagItem[] = [];
  const seen = new Set<string>();
  for (const b of raw) {
    if (out.length >= BAG_MAX) break;
    if (!isObject(b) || !isUid(b.uid) || seen.has(b.uid) || !isId(b.kind) || !finite(b.readyAt)) continue;
    seen.add(b.uid);
    out.push({ uid: b.uid, kind: b.kind, readyAt: clampNum(b.readyAt, now + BAG_READY_MAX_MS) });
  }
  return out;
}

// Hotbar: unique uids, at most HOTBAR_MAX; when the save carries the bag, each must be in it.
export function sanitizeHotbar(raw: unknown, bag?: BagItem[]): string[] {
  if (!Array.isArray(raw)) return [];
  const inBag = bag && new Set(bag.map((b) => b.uid));
  return [...new Set(raw.filter((u): u is string => isUid(u) && (!inBag || inBag.has(u))))].slice(0, HOTBAR_MAX);
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save. Server-owned fields (spins, daily,
// track, gifts) are never read here, so saveProgress can't write them.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.cash)) out.cash = clampNum(raw.cash, CURRENCY_MAX);
  if (finite(raw.wins)) out.wins = clampInt(raw.wins, WINS_MAX);
  if (finite(raw.streak)) out.streak = clampInt(raw.streak, STREAK_MAX);
  if (finite(raw.xp)) out.xp = clampInt(raw.xp, XP_MAX);
  if (finite(raw.rankClaimed)) out.rankClaimed = clampInt(raw.rankClaimed, RANK_LEVELS_MAX);
  if (isTag(raw.tag)) out.tag = raw.tag;
  if (typeof raw.tutorialDone === "boolean") out.tutorialDone = raw.tutorialDone;
  if (typeof raw.abilityHintDone === "boolean") out.abilityHintDone = raw.abilityHintDone;
  if (finite(raw.ability)) out.ability = clampNum(raw.ability, ABILITY_MAX);

  // The equipped cue must be owned ("" = none); when this save doesn't carry `cues`, trust the
  // id's shape only.
  if (raw.cues !== undefined) out.cues = sanitizeCues(raw.cues);
  if (raw.cue === "") out.cue = "";
  else if (isId(raw.cue) && (!out.cues || Object.hasOwn(out.cues, raw.cue))) out.cue = raw.cue;

  if (raw.bag !== undefined) out.bag = sanitizeBag(raw.bag);
  if (raw.hotbar !== undefined) out.hotbar = sanitizeHotbar(raw.hotbar, out.bag);
  if (raw.perks !== undefined) out.perks = sanitizeIds(raw.perks);

  if (finite(raw.playtime)) out.playtime = clampInt(raw.playtime, PLAY_SECONDS_MAX);
  if (finite(raw.lastSeen)) out.lastSeen = clampInt(raw.lastSeen, Date.now() + 10 * 60 * 1000);
  return out;
}
