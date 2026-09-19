const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const populationEl = document.getElementById("population");
const roomEl = document.getElementById("room");

const KEY_BINDINGS = {
  ArrowUp: "up", KeyW: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
};

const held = { up: false, down: false, left: false, right: false };
let lastSent = null;

// Server positions jump one tick at a time (20Hz); these catch up to them every
// animation frame so movement reads as smooth at whatever the display refreshes.
const rendered = new Map();

const config = await fetch("/config.json").then((res) => res.json());
const endpoint = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const name = new URLSearchParams(location.search).get("name") ?? "";

let room;
try {
  room = await new Colyseus.Client(endpoint).joinOrCreate("zone", { name });
} catch (error) {
  statusEl.textContent = `could not join: ${error.message}`;
  throw error;
}

// This is a test client — the live room handle is deliberately reachable from
// the console (and from automated smoke tests).
window.room = room;

statusEl.textContent = "connected";
roomEl.textContent = `zone ${room.roomId}`;
room.onLeave(() => {
  statusEl.textContent = "disconnected";
  populationEl.textContent = "";
});

window.addEventListener("keydown", onKey);
window.addEventListener("keyup", onKey);

function onKey(event) {
  const direction = KEY_BINDINGS[event.code];
  if (!direction) return;
  event.preventDefault();
  held[direction] = event.type === "keydown";
}

function sendInputIfChanged() {
  const serialized = JSON.stringify(held);
  if (serialized === lastSent) return;
  lastSent = serialized;
  room.send("input", held);
}

let previousFrame = performance.now();

function frame(now) {
  const delta = Math.min((now - previousFrame) / 1000, 0.1);
  previousFrame = now;

  sendInputIfChanged();
  interpolate(delta);
  draw();

  requestAnimationFrame(frame);
}

function interpolate(delta) {
  // The first state patch lands shortly after join, so the first few frames
  // render an empty world rather than a crash.
  const players = room.state?.players;
  if (!players) return;

  // Exponential smoothing: covers ~90% of the remaining gap every 100ms,
  // independent of frame rate.
  const catchUp = 1 - Math.pow(0.0001, delta);
  const present = new Set();

  players.forEach((player, sessionId) => {
    present.add(sessionId);
    let entry = rendered.get(sessionId);

    if (!entry) {
      entry = { x: player.x, y: player.y };
      rendered.set(sessionId, entry);
    }

    entry.x += (player.x - entry.x) * catchUp;
    entry.y += (player.y - entry.y) * catchUp;
    entry.name = player.name;
    entry.dir = player.dir;
    entry.moving = player.moving;
  });

  for (const sessionId of rendered.keys()) {
    if (!present.has(sessionId)) rendered.delete(sessionId);
  }

  populationEl.textContent = `${players.size} / ${config.zoneCapacity} in zone`;
}

function draw() {
  const self = rendered.get(room.sessionId);
  const camera = {
    x: clamp((self?.x ?? config.world.width / 2) - canvas.width / 2, 0, Math.max(0, config.world.width - canvas.width)),
    y: clamp((self?.y ?? config.world.height / 2) - canvas.height / 2, 0, Math.max(0, config.world.height - canvas.height)),
  };

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGround(camera);

  for (const [sessionId, entry] of rendered) {
    drawPlayer(entry, sessionId === room.sessionId, camera);
  }
}

function drawGround(camera) {
  ctx.fillStyle = "#26301f";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = -camera.x % config.tileSize; x < canvas.width; x += config.tileSize) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvas.height);
  }
  for (let y = -camera.y % config.tileSize; y < canvas.height; y += config.tileSize) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(canvas.width, y + 0.5);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.strokeRect(-camera.x + 0.5, -camera.y + 0.5, config.world.width, config.world.height);
}

function drawPlayer(entry, isSelf, camera) {
  const x = entry.x - camera.x;
  const y = entry.y - camera.y;
  const radius = config.tileSize / 2;

  ctx.fillStyle = isSelf ? "#f2c14e" : "#6fa8dc";
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  if (isSelf) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // A stub for sprite facing — until there are sprites, the nose is the tell.
  const facing = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[entry.dir] ?? [0, 1];
  ctx.fillStyle = "#11151c";
  ctx.beginPath();
  ctx.arc(x + facing[0] * radius * 0.55, y + facing[1] * radius * 0.55, radius * 0.22, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#e6e9ef";
  ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(entry.name ?? "", x, y - radius - 6);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

requestAnimationFrame(frame);
