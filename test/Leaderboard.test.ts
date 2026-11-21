import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";
import { LEADERBOARD_COUNTRIES, LEADERBOARD_SIZE } from "../src/constants.js";
import { __resetLeaderboardForTest } from "../src/leaderboard.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const doc = (id: string, f: Partial<PlayerDoc>): PlayerDoc => ({ _id: id, version: 1, updatedAt: new Date(), ...f });

describe("leaderboard", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    __resetLeaderboardForTest();
  });
  afterEach(() => __setPlayersForTest(null));

  it("sends the top saved players per stat and the player's own ranks after the load", async () => {
    const seed = [
      doc("u1", { username: "Ann", wins: 500, xp: 10 }),
      doc("u2", { username: "Bo", wins: 100, xp: 7200 }),
      ...Array.from({ length: 15 }, (_, i) => doc(`x${i}`, { username: `P${i}`, wins: 1000 + i })),
    ];
    const fake = fakePlayers(seed);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    let got: any = null;
    c.onMessage("leaderboard", (m: any) => (got = m));
    c.onMessage("progress", () => {});
    c.onMessage("spins", () => {});
    c.onMessage("daily", () => {});
    fake.release();
    await sleep(200);
    assert.ok(got, "leaderboard sent after the load");
    assert.strictEqual(got.boards.wins.length, LEADERBOARD_SIZE);
    assert.deepStrictEqual(got.boards.wins[0], { name: "P14", value: 1014, flag: "" });
    assert.deepStrictEqual(got.boards.xp, [{ name: "Bo", value: 7200, flag: "" }, { name: "Ann", value: 10, flag: "" }], "players without a score are left out");
    assert.deepStrictEqual(got.ranks, { wins: 16, xp: 2 });
  });

  it("gives a player with no save the lists and no ranks", async () => {
    const fake = fakePlayers([doc("u1", { username: "Ann", wins: 3 })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u9", username: "New" });
    let got: any = null;
    c.onMessage("leaderboard", (m: any) => (got = m));
    c.onMessage("noProgress", () => {});
    c.onMessage("spins", () => {});
    c.onMessage("daily", () => {});
    fake.release();
    await sleep(200);
    assert.deepStrictEqual(got?.boards.wins, [{ name: "Ann", value: 3, flag: "" }]);
    assert.deepStrictEqual(got?.ranks, { wins: null, xp: null });
  });
  it("ranks countries by their players' total wins and stores the country from `stats`", async () => {
    const seed = [
      doc("a1", { username: "Ana", wins: 40, country: "PH" }),
      doc("a2", { username: "Ben", wins: 30, country: "PH" }),
      doc("a3", { username: "Cy", wins: 50, country: "US" }),
      doc("a4", { username: "Dee", wins: 5, country: "lk" }), // malformed: not counted
      doc("a5", { username: "Eve", wins: 0, country: "BR" }), // no wins: not listed
      ...Array.from({ length: 12 }, (_, i) => doc(`c${i}`, { username: `C${i}`, wins: 1, country: String.fromCharCode(65 + i) + "Z" })),
      doc("me", { username: "Me", wins: 2 }),
    ];
    const fake = fakePlayers(seed);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "me", username: "Me", stats: { flag: "LK", wins: 2 } });
    const got: any[] = [];
    c.onMessage("leaderboard", (m: any) => got.push(m));
    c.onMessage("progress", () => {});
    c.onMessage("spins", () => {});
    c.onMessage("daily", () => {});
    fake.release();
    await sleep(250);
    assert.strictEqual(fake.docs.get("me")?.country, "LK", "the join's flag is stored once the save is read");
    const m = got[0];
    assert.deepStrictEqual(m.countries.slice(0, 2), [{ flag: "PH", value: 70 }, { flag: "US", value: 50 }]);
    assert.strictEqual(m.countries.length, LEADERBOARD_COUNTRIES);
    assert.deepStrictEqual(m.country, { flag: "LK", rank: 3, value: 2 }, "the own country's place (stored before the lists were read)");
    assert.deepStrictEqual(m.boards.wins[0], { name: "Cy", value: 50, flag: "US" });

    c.send("stats", { flag: "PH" });
    await sleep(150);
    assert.strictEqual(fake.docs.get("me")?.country, "PH", "a new flag is stored");
  });
});
