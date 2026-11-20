// Ability Spin (client src/abilities.js + hub/abilityStore.js): server-authoritative for signed-in
// players. The server owns each player's ability slots, spins, pity counter and redeemed codes,
// rolls every spin and grants code / pack spins, so a client can neither pick its ability nor
// hand itself spins. Stored in the doc's `abilities` field, written only by the ability messages
// (WorldRoom.ts), never by saveProgress. Cash stays client-authoritative (it rides in the save):
// the client spends a pack's / slot's price before asking and refunds it on a refusal.
// Keep the ids, rarity chances and ABILITY_* rules in step with the client's src/abilities.js.

export const ABILITY_RARITIES = [
  { id: "common", chance: 55, abilities: ["eaglesEye", "fireShot", "superBounce"] },
  { id: "uncommon", chance: 30, abilities: ["magnet", "rewind"] },
  { id: "rare", chance: 12, abilities: ["portals", "lookOverThere", "verity"] },
  { id: "epic", chance: 2, abilities: ["catchABall", "timeStop", "chainLightning"] },
  { id: "legendary", chance: 0.67, abilities: ["steelBall", "blackFlash"] },
  { id: "mythic", chance: 0.1, abilities: ["blackHole", "guangdongTiger"] },
] as const;
export const ABILITY_IDS: readonly string[] = ABILITY_RARITIES.flatMap((r) => r.abilities);
export const ABILITY_DEFAULT = "fireShot";
export const ABILITY_START_SPINS = 1;
export const ABILITY_SLOTS = 3;
export const ABILITY_PITY = 100; // the 100th spin without an Epic or better is one
export const ABILITY_PITY_RANK = 3; // index of "epic" in ABILITY_RARITIES
// Spin packs: spins per pack (the client prices them in cash).
export const ABILITY_PACKS = [1, 5, 10, 50];
// Codes (upper case; once per account): spins granted.
export const ABILITY_CODES: Record<string, number> = { FREESPINS: 5, "120KLIKES": 3 };
export const ABILITY_SPINS_MAX = 1e6;
const CODES_MAX = 64;

export interface AbilityState {
  slots: string[]; // ability id per slot, "" = empty
  unlocked: number; // slots unlocked, 1..ABILITY_SLOTS
  locked: boolean[]; // per slot: spins can't replace it
  equipped: number; // the slot used in matches and spun into
  spins: number;
  pity: number; // spins since the last Epic or better
  codes: string[]; // redeemed codes
}

export type AbilityResult = { ok: true; [k: string]: unknown } | { ok: false; reason: string };

export function freshAbilities(): AbilityState {
  return { slots: [ABILITY_DEFAULT, "", ""], unlocked: 1, locked: [false, false, false], equipped: 0, spins: ABILITY_START_SPINS, pity: 0, codes: [] };
}

const int = (v: unknown, min: number, max: number, def: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def;

// A stored (or missing) `abilities` field -> a valid state (a new player starts fresh).
export function abilitiesFrom(raw: unknown): AbilityState {
  const s = freshAbilities();
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, any>;
  s.unlocked = int(r.unlocked, 1, ABILITY_SLOTS, 1);
  for (let i = 0; i < ABILITY_SLOTS; i++) {
    const id = Array.isArray(r.slots) ? r.slots[i] : undefined;
    s.slots[i] = i < s.unlocked && typeof id === "string" && ABILITY_IDS.includes(id) ? id : i === 0 ? ABILITY_DEFAULT : "";
    s.locked[i] = i < s.unlocked && Array.isArray(r.locked) && r.locked[i] === true;
  }
  s.equipped = int(r.equipped, 0, s.unlocked - 1, 0);
  s.spins = int(r.spins, 0, ABILITY_SPINS_MAX, 0);
  s.pity = int(r.pity, 0, ABILITY_PITY - 1, 0);
  s.codes = Array.isArray(r.codes) ? r.codes.filter((c: unknown): c is string => typeof c === "string" && c in ABILITY_CODES).slice(0, CODES_MAX) : [];
  return s;
}

// One ability: a rarity by chance (only Epic or better when `forced`), then one of its abilities.
export function rollAbility(forced = false, rand: () => number = Math.random): { id: string; rank: number } {
  const pool = ABILITY_RARITIES.map((r, rank) => ({ ...r, rank })).filter((r) => !forced || r.rank >= ABILITY_PITY_RANK);
  const total = pool.reduce((n, r) => n + r.chance, 0);
  let x = rand() * total;
  let pick = pool[pool.length - 1];
  for (const r of pool) {
    if (x < r.chance) {
      pick = r;
      break;
    }
    x -= r.chance;
  }
  const i = Math.min(pick.abilities.length - 1, Math.floor(rand() * pick.abilities.length));
  return { id: pick.abilities[i], rank: pick.rank };
}

const isSlot = (s: AbilityState, slot: unknown): slot is number => Number.isInteger(slot) && (slot as number) >= 0 && (slot as number) < s.unlocked;

// The actions. Each mutates `s` only when it succeeds.
export const abilityActions = {
  spin(s: AbilityState, rand: () => number = Math.random): AbilityResult {
    if (s.locked[s.equipped]) return { ok: false, reason: "locked" };
    if (s.spins < 1) return { ok: false, reason: "none" };
    const forced = s.pity >= ABILITY_PITY - 1;
    const a = rollAbility(forced, rand);
    s.spins--;
    s.pity = a.rank >= ABILITY_PITY_RANK ? 0 : s.pity + 1;
    s.slots[s.equipped] = a.id;
    return { ok: true, id: a.id, slot: s.equipped, forced };
  },
  buy(s: AbilityState, pack: unknown): AbilityResult {
    const n = Number.isInteger(pack) ? ABILITY_PACKS[pack as number] : undefined;
    if (!n) return { ok: false, reason: "pack" };
    s.spins = Math.min(ABILITY_SPINS_MAX, s.spins + n);
    return { ok: true, n };
  },
  redeem(s: AbilityState, raw: unknown): AbilityResult {
    const code = typeof raw === "string" ? raw.trim().toUpperCase().slice(0, 32) : "";
    const n = Object.prototype.hasOwnProperty.call(ABILITY_CODES, code) ? ABILITY_CODES[code] : 0;
    if (!n) return { ok: false, reason: "invalid" };
    if (s.codes.includes(code)) return { ok: false, reason: "used" };
    s.codes.push(code);
    s.spins = Math.min(ABILITY_SPINS_MAX, s.spins + n);
    return { ok: true, code, n };
  },
  equip(s: AbilityState, slot: unknown): AbilityResult {
    if (!isSlot(s, slot)) return { ok: false, reason: "slot" };
    s.equipped = slot;
    return { ok: true };
  },
  lock(s: AbilityState, slot: unknown, locked: unknown): AbilityResult {
    if (!isSlot(s, slot)) return { ok: false, reason: "slot" };
    s.locked[slot] = locked === true;
    return { ok: true };
  },
  // The next slot only (in order); it starts empty and equipped so the next spin fills it.
  unlockSlot(s: AbilityState, slot: unknown): AbilityResult {
    if (slot !== s.unlocked || s.unlocked >= ABILITY_SLOTS) return { ok: false, reason: "slot" };
    s.unlocked++;
    s.slots[slot] = "";
    s.locked[slot] = false;
    s.equipped = slot;
    return { ok: true };
  },
};
