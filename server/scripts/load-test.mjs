/**
 * Fills one zone instance with synthetic walking clients to check the
 * per-zone capacity assumption in docs/ARCHITECTURE.md holds up.
 *
 * Usage: node scripts/load-test.mjs [clients] [seconds]
 */
import { Client } from "@colyseus/sdk";

const CLIENTS = Number(process.argv[2] ?? 150);
const DURATION = Number(process.argv[3] ?? 15);
const ENDPOINT = process.env.ENDPOINT ?? "ws://localhost:2567";

const DIRECTIONS = ["up", "down", "left", "right"];
const randomInput = () => ({
  up: false, down: false, left: false, right: false,
  [DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)]]: true,
});

// Bots hold a heading for seconds at a time rather than jittering in place, so
// they spread across the zone the way roaming players would.
const HEADING_MS = [2000, 4000];

const client = new Client(ENDPOINT);
const rooms = [];
const patchCounts = new Map();

console.log(`connecting ${CLIENTS} clients to ${ENDPOINT}…`);
const connectStarted = Date.now();

for (let i = 0; i < CLIENTS; i++) {
  const room = await client.joinOrCreate("zone", { name: `Bot${i}` });
  rooms.push(room);
  patchCounts.set(room.sessionId, 0);
  room.onStateChange(() => patchCounts.set(room.sessionId, patchCounts.get(room.sessionId) + 1));
}

const connectMs = Date.now() - connectStarted;
console.log(`all ${rooms.length} joined in ${connectMs}ms (${(connectMs / CLIENTS).toFixed(1)}ms/client)`);
console.log(`room: ${rooms[0].roomId} · walking randomly for ${DURATION}s…`);

for (const room of rooms) {
  room.send("input", randomInput());
  setInterval(() => room.send("input", randomInput()), HEADING_MS[0] + Math.random() * (HEADING_MS[1] - HEADING_MS[0]));
}

const measureStarted = Date.now();
for (const sessionId of patchCounts.keys()) patchCounts.set(sessionId, 0);

await new Promise((resolve) => setTimeout(resolve, DURATION * 1000));

const elapsed = (Date.now() - measureStarted) / 1000;
const counts = [...patchCounts.values()].sort((a, b) => a - b);
const connected = rooms.filter((room) => room.connection.isOpen).length;
const rate = (n) => (n / elapsed).toFixed(1);

const visible = rooms.map((room) => room.state.players.size).sort((a, b) => a - b);
const average = (values) => (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);

console.log(`\nstill connected: ${connected}/${CLIENTS}`);
console.log(`patches/sec — min ${rate(counts[0])} · median ${rate(counts[counts.length >> 1])} · max ${rate(counts.at(-1))}`);
console.log(`players in zone: ${rooms[0].state.population}`);
console.log(`players VISIBLE per client — min ${visible[0]} · avg ${average(visible)} · max ${visible.at(-1)}`);
console.log(`(each client is sent only what it can see; without interest management every client would carry all ${CLIENTS})`);

process.exit(0);
