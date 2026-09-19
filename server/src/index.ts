import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server, WebSocketTransport } from "colyseus";
import { CHALLENGE_RADIUS, PORT, TILE_SIZE, WORLD, WORLD_TILES, ZONE_CAPACITY } from "./config.js";
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
    world: WORLD,
    worldTiles: WORLD_TILES,
    zoneCapacity: ZONE_CAPACITY,
    challengeRadius: CHALLENGE_RADIUS,
  });
});

const httpServer = createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });

gameServer.define("zone", ZoneRoom);
gameServer.define("battle", BattleRoom);

await gameServer.listen(PORT);
console.log(`Covenant World zone server — http://localhost:${PORT}`);
