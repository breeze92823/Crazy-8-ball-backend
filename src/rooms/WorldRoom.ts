import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { DISTANCE_MAX, EMOTE_GAP_MS, GIFT_SAVE_MS, GIFT_TICK_MS, GUEST_ID_PREFIX, LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, RECONNECT_SECONDS, ROOM_MAX_CLIENTS } from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { accrue, rollWedge, spinStateFrom, type SpinState } from "../spin.js";
import { claimDaily, claimTrack, copyDaily, dailyFields, dailyView, readDaily, rollDaily, unlockAllDaily, type DailyState } from "../daily.js";
import { advanceGifts, claimGift, giftFields, giftsView, readGifts, type GiftState } from "../gifts.js";
import { applyAvatar, applyEmote, applyLoadout, applyPose, applyStats } from "../presence.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { abilitiesFrom, abilityActions, type AbilityResult, type AbilityState } from "../abilities.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username })`. Loads and
 * saves each signed-in player's progress (MongoDB, see db.ts) -- the client keeps no save of its
 * own, so this is the only place progress lives. The game is client-authoritative: no gameplay
 * rules live here, saves are only bounded (sanitize.ts). Full rooms spill into a fresh one
 * automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // sessionId -> Spin wheel state (spin.ts), set once the session's save has been read. Kept for
  // guests and serverless sessions too (it then lasts the connection).
  private spinStates = new Map<string, SpinState>();
  // sessionId -> Daily Reward state (daily.ts), read with the save. Guests and serverless sessions
  // keep theirs here only (like the rest of their progress, it lasts the session).
  private dailies = new Map<string, DailyState>();
  // sessionId -> playtime gifts state (gifts.ts), read with the save; `at` = when its clock last
  // moved, `savedAt` = when it was last stored. Guests and serverless sessions keep theirs here only.
  private gifts = new Map<string, { s: GiftState; at: number; savedAt: number }>();
  // sessionId -> Ability Spin state (abilities.ts), read with a signed-in player's save (a dev /
  // serverless session keeps it for the connection). Guests have none: their client runs the rules.
  private abilityStates = new Map<string, AbilityState>();
  private abilityBusy = new Set<string>();
  // sessionId -> when its last emote started (EMOTE_GAP_MS rate limit).
  private emoteAt = new Map<string, number>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...patch, username: p.username || "Player", updatedAt: new Date() },
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Claims Daily Reward day `msg.day` (0-based) and moves the streak track one step, in one
    // write. The server decides: answers `dailyResult` { ok, day, ...state }; the client only grants
    // the reward on ok.
    claimDaily: async (client: Client, msg: { day?: unknown }) => {
      const s = this.dailies.get(client.sessionId);
      const day = msg?.day;
      if (!s || !this.loaded.has(client.sessionId)) return client.send("dailyResult", { ok: false, day, reason: "loading" });
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s); // midnight passed while online
      const before = copyDaily(s);
      if (!claimDaily(s, day)) return client.send("dailyResult", { ok: false, day, reason: "locked", ...dailyView(s) });
      if (!(await this.saveDaily(client.sessionId, s))) {
        Object.assign(s, before); // not stored: not claimed
        return client.send("dailyResult", { ok: false, day, reason: "save", ...dailyView(s) });
      }
      client.send("dailyResult", { ok: true, day, ...dailyView(s) });
    },
    // Unlocks every day of this Daily Reward cycle (the client charges its cash before sending).
    // Answers `dailyUnlockResult` { ok, reason?: "loading" | "done" | "save", ...state }.
    dailyUnlockAll: async (client: Client) => {
      const s = this.dailies.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return client.send("dailyUnlockResult", { ok: false, reason: "loading" });
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s);
      const prev = s.day;
      if (!unlockAllDaily(s)) return client.send("dailyUnlockResult", { ok: false, reason: "done", ...dailyView(s) });
      if (!(await this.saveDaily(client.sessionId, s))) {
        s.day = prev;
        return client.send("dailyUnlockResult", { ok: false, reason: "save", ...dailyView(s) });
      }
      client.send("dailyUnlockResult", { ok: true, ...dailyView(s) });
    },
    // Claims streak-track milestone `msg.i` (TRACK_MILESTONES index). Answers `trackResult`
    // { ok, i, reason?: "loading" | "locked" | "claimed" | "save", ...state }; ok only once stored.
    claimTrack: async (client: Client, msg: { i?: unknown }) => {
      const s = this.dailies.get(client.sessionId);
      const i = msg?.i;
      if (!s || !this.loaded.has(client.sessionId)) return client.send("trackResult", { ok: false, i, reason: "loading" });
      const why = claimTrack(s, i);
      if (why) return client.send("trackResult", { ok: false, i, reason: why, ...dailyView(s) });
      if (!(await this.saveDaily(client.sessionId, s))) {
        s.trackClaimed = s.trackClaimed.filter((n) => n !== i);
        return client.send("trackResult", { ok: false, i, reason: "save", ...dailyView(s) });
      }
      client.send("trackResult", { ok: true, i, ...dailyView(s) });
    },
    // Claims playtime gift `msg.i` (GIFT_MINUTES index) on the server's count of today's playtime.
    // Answers `giftResult` { ok, i, reason?: "loading" | "locked" | "claimed" | "save", ...gifts }.
    claimGift: async (client: Client, msg: { i?: unknown }) => {
      const g = this.gifts.get(client.sessionId);
      const i = msg?.i;
      if (!g || !this.loaded.has(client.sessionId)) return client.send("giftResult", { ok: false, i, reason: "loading" });
      const now = Date.now();
      this.moveGiftClock(client.sessionId, g, now);
      const why = claimGift(g.s, i);
      if (why) return client.send("giftResult", { ok: false, i, reason: why, ...giftsView(g.s, now) });
      if (!(await this.saveGifts(client.sessionId))) {
        g.s.claimed = g.s.claimed.filter((n) => n !== i);
        return client.send("giftResult", { ok: false, i, reason: "save", ...giftsView(g.s, now) });
      }
      client.send("giftResult", { ok: true, i, ...giftsView(g.s, now) });
    },
    // The client's countdown reached the next UTC day: unlock it (server clock) and answer `daily`.
    dailyRefresh: (client: Client) => {
      const s = this.dailies.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return;
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s);
      client.send("daily", dailyView(s));
    },
    // Spin wheel: uses one spin and rolls the prize here, so the client can't choose it. Answers
    // `spinResult` { ok, id (SPIN_WEDGES id), spins, nextAt, serverTime } or { ok: false, reason }.
    spin: async (client: Client) => {
      const s = this.spinStates.get(client.sessionId);
      if (!s) return client.send("spinResult", { ok: false, reason: "loading" });
      const now = Date.now();
      accrue(s, now);
      if (s.spins < 1) return client.send("spinResult", { ok: false, reason: "none", ...this.spinView(s, now) });
      s.spins--;
      accrue(s, now); // dropping below the cap starts the free-spin clock
      const wedge = rollWedge();
      client.send("spinResult", { ok: true, id: wedge.id, ...this.spinView(s, now) });
      await this.saveSpins(client.sessionId, s);
    },
    // Ability Spin (abilities.ts): every action answers `abilityResult` { ok, action, reason?, ...,
    // state } and is ok only once stored. Packs / slots cost cash, which the client spends first
    // (and refunds on a refusal): the server only grants the spins / slot.
    abilitySpin: (client: Client) => this.abilityAction(client, "abilitySpin", (s) => abilityActions.spin(s)),
    abilityBuy: (client: Client, msg: { pack?: unknown }) => this.abilityAction(client, "abilityBuy", (s) => abilityActions.buy(s, msg?.pack)),
    abilityRedeem: (client: Client, msg: { code?: unknown }) => this.abilityAction(client, "abilityRedeem", (s) => abilityActions.redeem(s, msg?.code)),
    abilityEquip: (client: Client, msg: { slot?: unknown }) => this.abilityAction(client, "abilityEquip", (s) => abilityActions.equip(s, msg?.slot)),
    abilityLock: (client: Client, msg: { slot?: unknown; locked?: unknown }) => this.abilityAction(client, "abilityLock", (s) => abilityActions.lock(s, msg?.slot, msg?.locked)),
    abilityUnlockSlot: (client: Client, msg: { slot?: unknown }) => this.abilityAction(client, "abilityUnlockSlot", (s) => abilityActions.unlockSlot(s, msg?.slot)),
    // The sender's race, relayed through the roster so everyone draws them on the distance bar and
    // podium: { racing, distance (studs this race) }, a few times a second while racing.
    race: (client: Client, msg: { racing?: unknown; distance?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.racing = msg?.racing === true;
      const d = msg?.distance;
      p.distance = p.racing && typeof d === "number" && Number.isFinite(d) ? Math.min(DISTANCE_MAX, Math.max(0, d)) : 0;
    },
    // Presence (presence.ts): the sender's pose ~10x/s, its equipped gear and its Bloxity look,
    // relayed through the roster so everyone draws them in the world (client remotePlayers.js).
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    // Players list: the sender's wins / money / rank badge / country, for everyone's Players panel.
    stats: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyStats(p, msg);
    },
    // Emotes: { id } starts one (client catalog id), { id: "" } stops it; at most one per
    // EMOTE_GAP_MS (a stop always goes through, so a player's emote never sticks).
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const now = Date.now();
      const stop = (msg as { id?: unknown })?.id === "";
      if (!stop && now - (this.emoteAt.get(client.sessionId) ?? 0) < EMOTE_GAP_MS) return;
      if (applyEmote(p, msg) && !stop) this.emoteAt.set(client.sessionId, now);
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: (client: Client, msg: { username?: string; userId?: string; pfp?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      if (typeof msg?.userId === "string") this.setUserId(client, p, msg.userId);
    },
  };

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads. Playtime gifts: every loaded
  // session's clock moves every GIFT_TICK_MS.
  onCreate() {
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
    this.clock.setInterval(() => this.tickGifts(), GIFT_TICK_MS);
  }

  // Moves every session's gift clock to `now`: connected time counts, a new UTC day resets (and
  // re-sends `gifts`), and each is stored about every GIFT_SAVE_MS (a reset right away).
  tickGifts(now = Date.now()) {
    for (const [sid, g] of this.gifts) {
      if (this.moveGiftClock(sid, g, now)) g.savedAt = -Infinity;
      if (now - g.savedAt >= GIFT_SAVE_MS) {
        g.savedAt = now;
        void this.saveGifts(sid);
      }
    }
  }

  // Test-only: adds `secs` of playtime to a session's gift clock.
  __addGiftSecsForTest(sessionId: string, secs: number) {
    const g = this.gifts.get(sessionId);
    if (g) g.s.secs += secs;
  }

  // Moves one session's gift clock to `now` (time counts only while it is connected). Sends
  // `gifts` when a new UTC day reset it; returns true then.
  private moveGiftClock(sessionId: string, g: { s: GiftState; at: number }, now: number): boolean {
    const client = this.clients.find((c) => c.sessionId === sessionId);
    const reset = advanceGifts(g.s, g.at, now, !!client);
    g.at = Math.max(g.at, now);
    if (reset && client) {
      try {
        client.send("gifts", giftsView(g.s, now));
      } catch {
        // Gone meanwhile.
      }
    }
    return reset;
  }

  // `leaderboard` { boards: { wins|xp: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  onJoin(client: Client, options?: { username?: string; userId?: string; pfp?: string; pose?: unknown; loadout?: unknown; avatar?: string; stats?: unknown }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options);
    applyStats(p, options?.stats);
    this.state.players.set(client.sessionId, p);
    this.setUserId(client, p, typeof options?.userId === "string" ? options.userId : "");
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // Server-clock "last seen" (and the gift clock) for a player who has really gone. Call before
  // forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    const now = Date.now();
    const g = this.loaded.has(sessionId) ? this.gifts.get(sessionId) : undefined;
    if (g) this.moveGiftClock(sessionId, g, now);
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: now, ...(g && giftFields(g.s)) } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.dailies.delete(sessionId);
    this.spinStates.delete(sessionId);
    this.abilityStates.delete(sessionId);
    this.abilityBusy.delete(sessionId);
    this.gifts.delete(sessionId);
    this.emoteAt.delete(sessionId);
  }

  // Runs one Ability Spin action and stores the result (rolled back in memory when it can't be).
  private async abilityAction(client: Client, action: string, run: (s: AbilityState) => AbilityResult) {
    const id = client.sessionId;
    const s = this.abilityStates.get(id);
    if (!this.loaded.has(id)) return client.send("abilityResult", { ok: false, action, reason: "loading" });
    if (!s) return client.send("abilityResult", { ok: false, action, reason: "guest" });
    if (this.abilityBusy.has(id)) return client.send("abilityResult", { ok: false, action, reason: "busy", state: s });
    const before = structuredClone(s);
    const r = run(s);
    if (!r.ok) return client.send("abilityResult", { ...r, action, state: s });
    this.abilityBusy.add(id);
    const stored = await this.saveAbilities(id, s);
    this.abilityBusy.delete(id);
    if (this.abilityStates.get(id) !== s) return; // left or switched identity meanwhile
    if (!stored) {
      Object.assign(s, before);
      return client.send("abilityResult", { ok: false, action, reason: "save", state: s });
    }
    client.send("abilityResult", { ...r, action, state: s });
  }

  // True when stored, or when there is nowhere to store it (no database: it lives for the session).
  private async saveAbilities(sessionId: string, s: AbilityState): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne({ _id: userId }, { $set: { abilities: s, updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true });
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveAbilities failed", err);
      return false;
    }
  }

  private spinView(s: SpinState, now: number) {
    return { spins: s.spins, nextAt: s.nextAt, serverTime: now };
  }

  // The spin fields go straight to Mongo (saveProgress never carries them).
  private async saveSpins(sessionId: string, s: SpinState) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { spins: s.spins, spinAt: s.nextAt, updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
    } catch (err) {
      console.warn("[WorldRoom] saveSpins failed", err);
    }
  }

  // Stores a session's Daily Reward state. True when stored, or when there is nowhere to store it
  // (guest / no database: it lives in `dailies` for the session).
  private async saveDaily(sessionId: string, s: DailyState): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { ...dailyFields(s), updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveDaily failed", err);
      return false;
    }
  }

  // Stores a session's gift state, like saveDaily (true when stored or there is nowhere to store it).
  private async saveGifts(sessionId: string): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const g = this.gifts.get(sessionId);
    const players = getPlayers();
    if (!userId || !g || !players || !this.loaded.has(sessionId)) return true;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { ...giftFields(g.s), updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveGifts failed", err);
      return false;
    }
  }

  // Brings a session's gift clock up to now and stores it under its CURRENT identity (before that
  // identity changes or the session is evicted). Resolves when stored.
  private flushGifts(sessionId: string): Promise<boolean> {
    const g = this.gifts.get(sessionId);
    if (!g || !this.loaded.has(sessionId)) return Promise.resolve(true);
    this.moveGiftClock(sessionId, g, Date.now());
    return this.saveGifts(sessionId);
  }

  // Client-trusted Bloxity user id (guest ids are dropped, see GUEST_ID_PREFIX). A forged id can
  // only read/overwrite the SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, 128);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    // The old identity's playtime is stored first; the new one's load waits for that write.
    const flushes: Promise<unknown>[] = [this.flushGifts(client.sessionId)];
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    this.spinStates.delete(client.sessionId); // nor spins
    this.abilityStates.delete(client.sessionId); // nor abilities
    this.gifts.delete(client.sessionId); // nor gifts
    p.signedIn = !!userId;

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        flushes.push(this.flushGifts(sid));
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p, Promise.all(flushes));
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState, pending: Promise<unknown>) {
    await pending;
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    const spin = spinStateFrom(doc, now);
    this.spinStates.set(client.sessionId, spin);
    if (!doc) client.send("noProgress", { serverTime: now });
    else client.send("progress", { ...(sanitizeProgress(doc) ?? {}), serverTime: now });
    client.send("spins", this.spinView(spin, now));
    // Ability Spin: a signed-in (or dev / serverless) player's state; a guest's client runs it locally.
    if (userId) {
      const abilities = abilitiesFrom(doc?.abilities);
      this.abilityStates.set(client.sessionId, abilities);
      client.send("abilities", abilities);
    } else client.send("abilities", { local: true });
    // Playtime gifts: today's counters (another day's are reset), then the clock runs (tickGifts).
    const gifts = { s: readGifts(doc, now), at: now, savedAt: now };
    this.gifts.set(client.sessionId, gifts);
    client.send("gifts", giftsView(gifts.s, now));

    // Daily Reward: today's day unlocks on join (server clock), then the client gets the calendar.
    const daily = readDaily(doc);
    this.dailies.set(client.sessionId, daily);
    if (rollDaily(daily)) await this.saveDaily(client.sessionId, daily);
    if (this.dailies.get(client.sessionId) === daily) client.send("daily", dailyView(daily));
    void this.sendLeaderboard(client);
  }
}
