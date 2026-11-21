// Boxity platform calls made by this server (docs.bloxity.io). Everything here is best-effort:
// it never throws into the game, and it is a no-op where Boxity hosting injected nothing
// (local `npm start`, tests).
//   - environment: Boxity hosting injects BLOXITY_* per deploy; prod is only the fallback, never
//     a hostname guess.
//   - verifyToken: the player's identity, from the platform (never a client-sent id once deployed).
//   - verifyAdReward: a rewarded ad's single-use token.
//   - reportWins / reportStats: the Wins leaderboard and the "Only in this game" profile stats,
//     from server-owned counters (matchWins / matchesPlayed), never from a client message.
import { GAME_SLUG } from "./constants.js";

export const boxity = {
  env: process.env.BLOXITY_ENV || "prod",
  apiUrl: (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, ""),
  gameId: process.env.BLOXITY_GAME_ID || "",
  reportToken: process.env.BLOXITY_REPORT_TOKEN || "",
  // Deployed by Boxity hosting: identities must come from a verified token.
  deployed: !!process.env.BLOXITY_GAME_ID,
};

// Test seam: pretend to be deployed / not, and swap the API host.
export function __setBoxityForTest(patch: Partial<typeof boxity>) {
  Object.assign(boxity, patch);
}

const TIMEOUT_MS = 8000;

async function post(path: string, body: unknown, bearer?: string): Promise<{ status: number; json: any } | null> {
  try {
    const res = await fetch(`${boxity.apiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // No JSON body.
    }
    return { status: res.status, json };
  } catch (err) {
    console.warn(`[boxity] POST ${path} failed`, (err as Error)?.message ?? err);
    return null;
  }
}

// The Boxity account behind a player's token: { id, username } or null (no token, refused, or the
// platform could not be reached). POST /v1/auth/game-token/verify.
export async function verifyToken(token: unknown): Promise<{ id: string; username: string } | null> {
  if (typeof token !== "string" || !token || token.length > 4096) return null;
  const r = await post("/v1/auth/game-token/verify", { gameSlug: GAME_SLUG }, token);
  const user = r?.status === 200 && r.json?.valid ? r.json.user : null;
  if (!user || typeof user._id !== "string" || !user._id) return null;
  return { id: user._id, username: typeof user.displayName === "string" && user.displayName ? user.displayName : String(user.username ?? "") };
}

// A rewarded ad's token: valid once, for this game, within 5 minutes. POST /v1/ads/reward/verify.
export async function verifyAdReward(rewardToken: unknown): Promise<{ valid: boolean; placement?: string; test?: boolean; reason?: string }> {
  if (typeof rewardToken !== "string" || !rewardToken || rewardToken.length > 4096) return { valid: false, reason: "missing" };
  const r = await post("/v1/ads/reward/verify", { gameSlug: GAME_SLUG, rewardToken });
  if (!r || r.status !== 200 || !r.json) return { valid: false, reason: "unreachable" };
  return { valid: r.json.valid === true, placement: r.json.placement, test: r.json.test, reason: r.json.reason };
}

// --- Leaderboard + profile stats --------------------------------------------------------------
// Boards (client src/bloxity.js declares the same with leaderboard.define()). The first declaration
// creates a board; after that the Boxity dashboard owns its settings.
export const BOARDS = [{ id: "wins", label: "Wins", order: "desc", mode: "best", format: "compact", reset: "none" }];
export const STAT_DEFINITIONS = [
  { key: "wins", label: "Match Wins", type: "number", sortOrder: 1 },
  { key: "matches", label: "Matches Played", type: "number", sortOrder: 2 },
];
const STAT_MAX = 1_000_000_000; // the "number" ceiling: above it Boxity rejects the row
const BATCH = 200;

const canReport = () => !!(boxity.reportToken && boxity.gameId);
// Boxity identities only (guests and dev ids have no account to attach to); a "#m..." mode suffix is stripped.
export const legionId = (userId: string) => (userId && !userId.startsWith("guest-") && !userId.startsWith("dev-") ? `legion_${userId.replace(/#m.*$/, "")}` : "");
const okValue = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= STAT_MAX;

// Wins board: each player's server-counted total ("best" keeps the highest).
export async function reportWins(rows: { userId: string; wins: number }[]) {
  if (!canReport()) return;
  const scores = rows.map((r) => ({ board: "wins", userId: legionId(r.userId), score: Math.floor(r.wins) })).filter((s) => s.userId && okValue(s.score));
  for (let i = 0; i < scores.length; i += BATCH) {
    const r = await post(`/v1/leaderboards/hosted/${encodeURIComponent(boxity.gameId)}/report`, { boards: BOARDS, scores: scores.slice(i, i + BATCH) }, boxity.reportToken);
    if (r) console.log("[boxity] leaderboard report", r.status, JSON.stringify(r.json?.dropped ?? r.json));
  }
}

// Profile stats: the CURRENT values of every row (Boxity keeps the high-water mark itself).
export async function reportStats(rows: { userId: string; wins: number; matches: number }[]) {
  if (!canReport()) return;
  const players = rows
    .map((r) => {
      const values: Record<string, number> = {};
      if (okValue(r.wins)) values.wins = Math.floor(r.wins);
      if (okValue(r.matches)) values.matches = Math.floor(r.matches);
      return { userId: legionId(r.userId), values };
    })
    .filter((p) => p.userId && Object.keys(p.values).length);
  for (let i = 0; i < players.length; i += BATCH) {
    const r = await post(`/v1/games/${encodeURIComponent(boxity.gameId)}/stats`, { definitions: STAT_DEFINITIONS, players: players.slice(i, i + BATCH) }, boxity.reportToken);
    if (r) console.log("[boxity] stats report", r.status, JSON.stringify(r.json));
  }
}
