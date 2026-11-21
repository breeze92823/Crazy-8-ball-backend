import { AVATAR_MAX_LEN, CURRENCY_MAX, FLAG_PATTERN, ID_PATTERN, POSE_BOUNDS, RANK_BADGE_MAX, STREAK_MAX, TAG_PATTERN, WINS_MAX } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player in the world.
// Relayed through the roster as sent, only bounded here -- like the rest of the game it is
// client-authoritative and purely cosmetic.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
const isTag = (v: unknown): v is string => typeof v === "string" && TAG_PATTERN.test(v);

// `pose` { x, y, z, yaw, speed }: the player's feet position, heading (rad) and speed (m/s).
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xy, b.xy);
  if (finite(m.y)) p.y = clamp(m.y, -b.xy, b.xy);
  if (finite(m.z)) p.z = clamp(m.z, -b.z, b.xy);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
}

// `loadout` { cue, tag }: the equipped cue id ("" = none) and the chat tag ("" = none).
export function applyLoadout(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  if (m.cue === "" || isId(m.cue)) p.cue = m.cue as string;
  if (isTag(m.tag)) p.tag = m.tag;
}

// `setAvatar` { avatar }: the Bloxity look as an opaque JSON string ("" = default), length-capped.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const a = (msg as { avatar?: unknown })?.avatar;
  if (typeof a === "string" && a.length <= AVATAR_MAX_LEN) p.avatar = a;
}

// `stats` { wins, cash, rank, flag, streak }: what the hub's Players panel and name tags show for this player. Like the
// save it is client-reported; only bounded here (whole numbers, the save ceilings, a 2-letter code).
export function applyStats(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  if (finite(m.wins)) p.wins = Math.floor(clamp(m.wins, 0, WINS_MAX));
  if (finite(m.cash)) p.cash = Math.floor(clamp(m.cash, 0, CURRENCY_MAX));
  if (finite(m.rank)) p.rank = Math.floor(clamp(m.rank, 0, RANK_BADGE_MAX));
  if (finite(m.streak)) p.streak = Math.floor(clamp(m.streak, 0, STREAK_MAX));
  if (m.flag === "" || (typeof m.flag === "string" && FLAG_PATTERN.test(m.flag))) p.flag = m.flag as string;
}

// `emote` { id }: starts emote `id` (a client catalog id), or stops it with "". Every accepted
// message bumps emoteSeq so the others restart it. Returns false when the message is ignored.
export function applyEmote(p: PlayerState, msg: unknown): boolean {
  const id = (msg as { id?: unknown })?.id;
  if (id !== "" && !isId(id)) return false;
  if (id === "" && p.emote === "") return false; // nothing to stop
  p.emote = id as string;
  p.emoteSeq = (p.emoteSeq + 1) % 65536;
  return true;
}
