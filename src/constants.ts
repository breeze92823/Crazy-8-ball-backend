// Keep in step with the client's src/config.js by hand.
export const ROOM_MAX_CLIENTS = 50;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw and the pose
// bounds (|x|, |y| and z up to `xy` m; z down to -`z` m; speed in m/s).
export const AVATAR_MAX_LEN = 3000;
export const POSE_BOUNDS = { xy: 5000, z: 1e8, speed: 2000 };

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules.
export const CURRENCY_MAX = 1e15; // cash
export const WINS_MAX = 1e9;
export const STREAK_MAX = 1e6;
export const XP_MAX = 1e9; // ranked XP total
export const RANK_LEVELS_MAX = 64; // rank-division rewards granted (`rankClaimed`)
export const ABILITY_MAX = 100; // the ability meter, 0..100
export const DISTANCE_MAX = 1e15; // `race` distance relayed through the roster
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year

// Players list (presence.ts `stats`): the rank badge tier and the country code.
export const RANK_BADGE_MAX = 8;
export const FLAG_PATTERN = /^[A-Z]{2}$/;
// Emotes (presence.ts `emote`): at most one every EMOTE_GAP_MS per player; ids are ID_PATTERN.
export const EMOTE_GAP_MS = 250;

// Chat tag ("" = none): capitals and spaces only.
export const TAG_PATTERN = /^[A-Z ]{0,16}$/;

// Owned cues { id: count }: kinds and copies of one kind.
export const CUES_MAX = 256;
export const CUE_COUNT_MAX = 1e6;
// Lucky blocks held (`bag`) and the hotbar slots (bag uids); a block's readyAt may be at most
// BAG_READY_MAX_MS ahead of the server clock.
export const BAG_MAX = 200;
export const HOTBAR_MAX = 9;
export const BAG_READY_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const UID_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;
// Other id lists (`perks`): at most this many.
export const IDS_MAX = 256;

// Daily Reward (client DAILY.days): days in one calendar cycle.
export const DAILY_DAYS = 7;
// Streak track (daily.ts): one step per claimed daily, up to TRACK_DAYS; rewards at these steps.
export const TRACK_DAYS = 28;
export const TRACK_MILESTONES = [8, 14, 21, 28] as const;

// Playtime gifts (gifts.ts): minutes played TODAY (UTC) that unlock each gift. The session clock
// ticks every GIFT_TICK_MS and is stored about every GIFT_SAVE_MS (and on claim / leave).
export const GIFT_MINUTES = [5, 15, 30, 45, 60] as const;
export const GIFT_TICK_MS = 1000;
export const GIFT_SAVE_MS = 60 * 1000;

// Spin wheel (client SPIN in config.js; spin.ts): one free spin every SPIN_EVERY_MS, stored up
// to SPIN_CAP; a new player starts with SPIN_START. SPINS_MAX bounds a saved count.
export const SPIN_EVERY_MS = 15 * 60 * 1000;
export const SPIN_CAP = 5;
export const SPIN_START = 1;
export const SPINS_MAX = 1e6;
// The wedges' prizes and odds (weights in %). Ids match the client's SPIN.wedges; the client
// decides what each prize is, the server only which one is won.
export const SPIN_WEDGES = [
  { id: "doubleWins", weight: 35 },
  { id: "wins50", weight: 25 },
  { id: "luck", weight: 35 },
  { id: "wins250", weight: 4.9 },
  { id: "hugePet", weight: 0.1 },
] as const;

// Leaderboards (leaderboard.ts): the saved doc fields ranked, rows per board and how often the
// lists are re-read and re-sent.
export const LEADERBOARD_STATS = ["wins", "xp"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Ids from the client's catalogs (cues, lucky-block kinds, perks): slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
