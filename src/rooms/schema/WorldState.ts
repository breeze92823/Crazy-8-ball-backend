import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none), for the others to draw
    racing: t.boolean().default(false), // in a race right now (`race` message)
    distance: t.float64().default(0), // this race's distance so far, studs
    // Presence (presence.ts, `pose` / `loadout` / `setAvatar`): what the others draw in the world.
    x: t.float64().default(0), // feet position
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float32().default(0), // heading, rad
    speed: t.float32().default(0), // m/s, for dead reckoning
    cue: t.string().default(""), // equipped cue id (client catalog), "" = none
    tag: t.string().default(""), // chat tag (capitals/spaces), "" = none
    avatar: t.string().default(""), // Bloxity look JSON { equipped, proportions, skin }, "" = default
    // Players list (presence.ts `stats`): what the others show in the hub's Players panel.
    wins: t.uint32().default(0),
    cash: t.float64().default(0), // money ($)
    rank: t.uint8().default(0), // rank badge tier, 0..RANK_BADGE_MAX
    flag: t.string().default(""), // ISO country code ("" = unknown)
    // Emotes (presence.ts `emote`): the emote playing ("" = none); emoteSeq bumps on every
    // `emote` so the same emote played twice still restarts on the other clients.
    emote: t.string().default(""),
    emoteSeq: t.uint16().default(0),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
