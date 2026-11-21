import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import type { WorldRoom } from "../src/rooms/WorldRoom.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setBoxityForTest, boxity, legionId } from "../src/boxity.js";
import { TABLE_TEAMS } from "../src/constants.js";
import { __setPlayersForTest } from "../src/db.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const API = "http://boxity.test";
const realFetch = globalThis.fetch;
const calls: { path: string; body: any; auth: string }[] = [];
// Stands in for the Boxity API; everything else (the test client) goes to the real fetch.
function stubBoxity(answer: (path: string, body: any, auth: string) => unknown) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith(API)) return realFetch(input, init);
    const path = url.slice(API.length);
    const body = init?.body ? JSON.parse(init.body) : null;
    const auth = init?.headers?.authorization ?? "";
    calls.push({ path, body, auth });
    return new Response(JSON.stringify(answer(path, body, auth)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("Boxity platform", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const saved = { ...boxity };
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    calls.length = 0;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    __setBoxityForTest(saved);
    __setPlayersForTest(null);
  });

  it("maps identities to Boxity ids for reports, skipping guests and dev ids", () => {
    assert.strictEqual(legionId("64ab"), "legion_64ab");
    assert.strictEqual(legionId("64ab#m2"), "legion_64ab");
    assert.strictEqual(legionId("guest-x1"), "");
    assert.strictEqual(legionId("dev-x1"), "");
  });

  it("on Boxity hosting takes the identity from the verified token, never the client's id", async () => {
    __setBoxityForTest({ apiUrl: API, deployed: true });
    stubBoxity((path, body, auth) => (path === "/v1/auth/game-token/verify" && auth === "Bearer good" && body.gameSlug === "crazy-8-ball" ? { valid: true, user: { _id: "acc1", username: "ann" } } : { valid: false }));
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "someone-else", token: "good", username: "Ann" });
    const b = await colyseus.connectTo(room, { userId: "forged", token: "bad", username: "Bo" });
    await sleep(120);
    assert.strictEqual(room.state.players.get(a.sessionId)!.uid, "acc1");
    assert.strictEqual(room.state.players.get(a.sessionId)!.signedIn, true);
    assert.strictEqual(room.state.players.get(b.sessionId)!.uid, "", "a refused token plays as a guest");
    assert.strictEqual(room.state.players.get(b.sessionId)!.signedIn, false);
  });

  it("grants the result card's rewarded ad once per match, only for a verified token", async () => {
    __setBoxityForTest({ apiUrl: API, deployed: false });
    stubBoxity((path, body) => (path === "/v1/ads/reward/verify" ? { valid: body.rewardToken === "tok" } : {}));
    const room = (await colyseus.createRoom<WorldState>("world", {})) as unknown as WorldRoom;
    const a = await colyseus.connectTo(room as any, { userId: "guest-a", username: "Ann" });
    const b = await colyseus.connectTo(room as any, { userId: "guest-b", username: "Bo" });
    const got: any[] = [];
    a.onMessage("adRewardResult", (m) => got.push(m));
    a.send("adReward", { rewardToken: "tok" });
    await sleep(60);
    assert.deepStrictEqual(got[0], { ok: false, reason: "no-match" }, "no match played yet");

    const table = TABLE_TEAMS.indexOf(1);
    a.send("padJoin", { table });
    b.send("padJoin", { table });
    await sleep(50);
    room.tables.tick(Date.now() + 5000);
    await sleep(50);
    b.send("mForfeit", {});
    await sleep(50);
    a.send("adReward", { rewardToken: "tok" });
    await sleep(80);
    assert.strictEqual(got[1].ok, true);
    a.send("adReward", { rewardToken: "tok" });
    await sleep(80);
    assert.strictEqual(got[2].ok, false, "one claim per match");
    assert.ok(calls.some((c) => c.path === "/v1/ads/reward/verify" && c.body.gameSlug === "crazy-8-ball"));
  });
});
