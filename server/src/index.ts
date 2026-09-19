import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { RedisDriver, RedisPresence, Server, WebSocketTransport } from "colyseus";
import { CHALLENGE_RADIUS, PORT, TILE_SIZE, VIEW_RADIUS, ZONE_CAPACITY } from "./config.js";
import { STARTING_ZONE, ZONES } from "./zones.js";
import { BattleRoom } from "./rooms/BattleRoom.js";
import { ZoneRoom } from "./rooms/ZoneRoom.js";

const clientDir = path.resolve(fileURLToPath(new URL("../../client", import.meta.url)));
// The SDK's prebuilt browser bundle, served as-is so the test client needs no build step.
const sdkDist = path.join(path.dirname(fileURLToPath(import.meta.resolve("@colyseus/sdk/package.json"))), "dist");

const app = express();
app.use(express.static(clientDir));
app.use("/vendor", express.static(sdkDist));
app.get("/config.json", (_req, res) => {
  res.json({
    tileSize: TILE_SIZE,
    zoneCapacity: ZONE_CAPACITY,
    challengeRadius: CHALLENGE_RADIUS,
    viewRadius: VIEW_RADIUS,
    startingZone: STARTING_ZONE,
    zones: Object.values(ZONES).map(({ id, name }) => ({ id, name })),
  });
});

const httpServer = createServer(app);

// With REDIS_URL set, several server processes share one room registry: a
// player can hit any process and be routed to the instance it needs, wherever
// that instance is actually running. Without it, everything is local.
const redisUrl = process.env.REDIS_URL;
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  ...(redisUrl ? { presence: new RedisPresence(redisUrl), driver: new RedisDriver(redisUrl) } : {}),
  // How other processes reach rooms hosted here, once there's more than one.
  ...(process.env.PUBLIC_ADDRESS ? { publicAddress: process.env.PUBLIC_ADDRESS } : {}),
});

// filterBy is the sharding primitive: a request for a zone only matches
// instances of THAT zone, and the matchmaker opens another instance when the
// existing ones are full.
gameServer.define("zone", ZoneRoom).filterBy(["zoneId"]);
gameServer.define("battle", BattleRoom);

await gameServer.listen(PORT);
console.log(
  `Covenant World zone server — http://localhost:${PORT}` +
    ` · zones: ${Object.keys(ZONES).join(", ")} · capacity ${ZONE_CAPACITY}/instance` +
    ` · registry: ${redisUrl ? "redis" : "local"}`,
);
