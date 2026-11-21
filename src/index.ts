import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { connectDb } from "./db.js";
import { reportStats } from "./boxity.js";
import { STATS_EVERY_MS } from "./constants.js";
import { installRoomReporter } from "./legion-room-reporter.js";
import { WorldRoom } from "./rooms/WorldRoom.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Listens on PORT (or 2567).
await listen(app);

// Boxity hosting (no-ops locally): this pod's rooms for "Open Rooms" / joins by id, and every
// signed-in player's profile stats every STATS_EVERY_MS and once more when the pod drains.
installRoomReporter();
const flushStats = () => reportStats([...WorldRoom.live].flatMap((room) => room.statRows()));
setInterval(() => void flushStats(), STATS_EVERY_MS).unref();
// Read synchronously on the signal, before Colyseus' own graceful shutdown disposes the rooms.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void flushStats());
