import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { RedisDriver, RedisPresence, Server, WebSocketTransport } from "colyseus";
import { CHALLENGE_RADIUS_TILES, PORT, STEP_DURATION_MS, TILE_SIZE, VIEW_RADIUS_TILES, ZONE_CAPACITY } from "./config.js";
import { STARTING_ZONE, ZONES, getZone } from "./zones.js";
import { TERRAIN, buildTileMap } from "./terrain.js";
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
    challengeRadiusTiles: CHALLENGE_RADIUS_TILES,
    viewRadiusTiles: VIEW_RADIUS_TILES,
    stepDurationMs: STEP_DURATION_MS,
    startingZone: STARTING_ZONE,
    zones: Object.values(ZONES).map(({ id, name, subtitle, theme }) => ({ id, name, subtitle, theme })),
    terrain: TERRAIN,
  });
});

// Terrain is deterministic per zone and never changes, so it's a plain cached
// fetch rather than part of the realtime state every client re-receives.
app.get("/zones/:zoneId/terrain.json", (req, res) => {
  const zone = getZone(req.params.zoneId);
  res.set("cache-control", "public, max-age=300").json(buildTileMap(zone));
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

// Containers must bind every interface, not just loopback, or the host's
// proxy can't reach the process.
await gameServer.listen(PORT, process.env.HOST ?? "0.0.0.0");
console.log(
  `Covenant World zone server — http://localhost:${PORT}` +
    ` · zones: ${Object.keys(ZONES).join(", ")} · capacity ${ZONE_CAPACITY}/instance` +
    ` · registry: ${redisUrl ? "redis" : "local"}`,
);
