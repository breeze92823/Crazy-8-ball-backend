import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    uid: t.string().default(""), // the Boxity account id (verified from the token once deployed), "" = guest; chat bubbles match on it
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
    streak: t.uint32().default(0), // current win streak (the flame on name tags)
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

// One pool table of the hub (tables.ts): who sits on its join pads and its lobby / match state.
// Matches are played by real players only; the in-match messages (mAim, mShot, mBalls, mEnd ->
// mTurn) carry the shots, this only what a newcomer or a passer-by needs to draw the table.
export const TableState = schema(
  {
    state: t.string().default("open"), // open | waiting | countdown | match | cooldown
    startsAt: t.float64().default(0), // server ms: the countdown's end (countdown) / the reset (cooldown)
    team0: t.string().default(""), // sessionIds, comma-separated, in join order
    team1: t.string().default(""),
    turn: t.uint8().default(0), // team to shoot (match)
    shooter: t.string().default(""), // sessionId of the player to shoot (match)
    matchId: t.uint16().default(0), // bumps on every match start
    balls: t.string().default(""), // last settled balls: 16 x "x,z,on" (1e-4 m), ";"-joined ("" = racked)
  },
  "TableState",
);
export type TableState = SchemaType<typeof TableState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
    tables: t.map(TableState), // keyed by table id ("0".."n-1", client TABLE_GRID row by row)
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
