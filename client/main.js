const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const populationEl = document.getElementById("population");
const roomEl = document.getElementById("room");
const promptEl = document.getElementById("prompt");
const overlayEl = document.getElementById("overlay");

const KEY_BINDINGS = {
  ArrowUp: "up", KeyW: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
};

const held = { up: false, down: false, left: false, right: false };
const pressedAt = {};
const releasedAt = {};
let lastSent = null;

/**
 * A key is reported as held for at least this long. The server samples held
 * direction on its own 20Hz tick, so a tap shorter than one tick would land
 * and clear between samples and be lost entirely — and tapping to turn on the
 * spot is exactly what the turn delay exists for.
 */
const MIN_HOLD_MS = 90;

// Server positions jump one tick at a time (20Hz); these catch up to them every
// animation frame so movement reads as smooth at whatever the display refreshes.
const rendered = new Map();

// "roaming" → "awaiting" (challenge sent) | "challenged" (challenge received) → "battling".
let mode = "roaming";
let incomingChallenge = null;
let nearby = null;
let notice = "";
let noticeUntil = 0;
let lastOverlaySignature = null;

const config = await fetch("/config.json").then((res) => res.json());
const endpoint = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const params = new URLSearchParams(location.search);
const name = params.get("name") ?? "";
const colyseus = new Colyseus.Client(endpoint);

let room;
let battleRoom = null;
let traveling = false;
let terrain = null;

/**
 * Joins a zone, or moves to another one. The matchmaker picks which *instance*
 * of that zone we land in, so this is also what happens when an instance fills
 * up and a new one opens.
 */
async function connectToZone(zoneId, entry) {
  traveling = true;
  statusEl.textContent = "travelling…";

  if (room) {
    try {
      await room.leave();
    } catch {
      // Already gone; nothing to wind down.
    }
  }

  // Nobody from the old zone exists here.
  rendered.clear();
  nearby = null;
  backToRoaming("");

  terrain = await fetch(`/zones/${zoneId ?? config.startingZone}/terrain.json`).then((res) => res.json());

  try {
    room = await colyseus.joinOrCreate("zone", { name, zoneId, entry });
  } catch (error) {
    statusEl.textContent = `could not join: ${error.message}`;
    throw error;
  }

  // This is a test client — the live room handles are deliberately reachable
  // from the console (and from automated smoke tests).
  window.room = room;
  traveling = false;
  statusEl.textContent = "connected";

  room.onLeave(() => {
    if (traveling) return;
    statusEl.textContent = "disconnected";
    populationEl.textContent = "";
  });

  room.onMessage("challenge:sent", ({ name: target }) => {
    mode = "awaiting";
    incomingChallenge = { name: target };
  });
  room.onMessage("challenge:received", ({ from, name: challenger }) => {
    if (mode !== "roaming") return;
    mode = "challenged";
    incomingChallenge = { from, name: challenger };
  });
  room.onMessage("challenge:declined", ({ by }) => backToRoaming(`${by} declined`));
  room.onMessage("challenge:expired", () => backToRoaming("challenge expired"));
  room.onMessage("challenge:failed", ({ reason }) => backToRoaming(reason));
  room.onMessage("battle:start", ({ reservation }) => enterBattle(reservation));
  room.onMessage("battle:result", ({ outcome, won }) => {
    // The battle room's own state drives the result screen; this is the zone's
    // authoritative copy, and the only word a client that never made it into
    // the battle room gets.
    if (mode !== "battling") showNotice(outcome === "played" ? (won ? "you won" : "you lost") : `battle ${outcome}`);
  });
  room.onMessage("zone:travel", ({ zoneId: destination, entry: arrivalEdge }) => {
    // Held keys belong to the room we're leaving.
    for (const key of Object.keys(held)) held[key] = false;
    lastSent = null;
    connectToZone(destination, arrivalEdge);
  });
}

await connectToZone(params.get("zone") ?? config.startingZone);

window.addEventListener("keydown", onKey);
window.addEventListener("keyup", onKey);

function onKey(event) {
  const direction = KEY_BINDINGS[event.code];

  if (direction) {
    event.preventDefault();
    // Movement keys are dead outside the overworld — the server freezes you
    // during a battle anyway, so releasing them here keeps the two in step.
    if (event.type === "keydown") {
      if (!held[direction]) pressedAt[direction] = performance.now();
      held[direction] = mode === "roaming";
    } else {
      releasedAt[direction] = performance.now();
    }
    return;
  }

  if (event.type !== "keydown") return;

  if (event.code === "KeyE" && mode === "roaming" && nearby) {
    room.send("challenge", { targetSessionId: nearby.sessionId });
  } else if (event.code === "KeyY" && mode === "challenged") {
    room.send("challenge:respond", { from: incomingChallenge.from, accept: true });
    incomingChallenge = null;
    mode = "awaiting";
  } else if (event.code === "KeyN" && mode === "challenged") {
    room.send("challenge:respond", { from: incomingChallenge.from, accept: false });
    backToRoaming("declined");
  } else if (event.code === "KeyR" && mode === "battling" && battleRoom?.state?.phase === "active") {
    battleRoom.send("ready");
  }
}

async function enterBattle(reservation) {
  mode = "battling";
  incomingChallenge = null;

  try {
    battleRoom = await colyseus.consumeSeatReservation(reservation);
  } catch (error) {
    backToRoaming(`could not enter the battle: ${error.message}`);
    return;
  }

  window.battleRoom = battleRoom;
  battleRoom.onLeave(() => {
    battleRoom = null;
    window.battleRoom = null;
    backToRoaming("");
  });
}

function backToRoaming(message) {
  mode = "roaming";
  incomingChallenge = null;
  if (message) showNotice(message);
}

function showNotice(message) {
  notice = message;
  noticeUntil = performance.now() + 3000;
}

function sendInputIfChanged() {
  const now = performance.now();
  for (const direction of Object.keys(held)) {
    const releasedAfterPress = (releasedAt[direction] ?? -1) >= (pressedAt[direction] ?? 0);
    if (held[direction] && releasedAfterPress && now - (pressedAt[direction] ?? 0) >= MIN_HOLD_MS) {
      held[direction] = false;
    }
  }

  const serialized = JSON.stringify(held);
  if (serialized === lastSent) return;
  lastSent = serialized;
  room.send("input", held);
}

let previousFrame = performance.now();

function frame(now) {
  const delta = Math.min((now - previousFrame) / 1000, 0.1);
  previousFrame = now;

  if (traveling) {
    requestAnimationFrame(frame);
    return;
  }

  sendInputIfChanged();
  interpolate(delta);
  draw();
  drawOverlays(now);

  requestAnimationFrame(frame);
}

// Walking speed in pixels/second, derived from how long the server takes to
// cross one tile — so the slide finishes exactly as the step does.
const WALK_SPEED = config.tileSize / (config.stepDurationMs / 1000);
const tileToPixel = (tile) => (tile + 0.5) * config.tileSize;

function interpolate(delta) {
  // The first state patch lands shortly after join, so the first few frames
  // render an empty world rather than a crash.
  const players = room.state?.players;
  if (!players) return;

  const present = new Set();
  const self = players.get(room.sessionId);
  let closest = null;

  players.forEach((player, sessionId) => {
    present.add(sessionId);
    const targetX = tileToPixel(player.tx);
    const targetY = tileToPixel(player.ty);
    let entry = rendered.get(sessionId);

    if (!entry) {
      entry = { x: targetX, y: targetY };
      rendered.set(sessionId, entry);
    }

    // Slide at a constant walking pace toward the tile the server says they're
    // on. A jump of more than a couple of tiles isn't walking — it's a spawn or
    // a zone change — so take it instantly rather than gliding across the map.
    const gapX = targetX - entry.x;
    const gapY = targetY - entry.y;
    const reach = WALK_SPEED * delta;

    if (Math.hypot(gapX, gapY) > config.tileSize * 2) {
      entry.x = targetX;
      entry.y = targetY;
    } else {
      entry.x = Math.abs(gapX) <= reach ? targetX : entry.x + Math.sign(gapX) * reach;
      entry.y = Math.abs(gapY) <= reach ? targetY : entry.y + Math.sign(gapY) * reach;
    }

    entry.name = player.name;
    entry.dir = player.dir;
    entry.moving = player.moving;
    entry.inBattle = player.inBattle;

    if (self && !self.inBattle && !player.inBattle && sessionId !== room.sessionId) {
      // Adjacency, diagonals included — the eight tiles around you.
      const distance = Math.max(Math.abs(self.tx - player.tx), Math.abs(self.ty - player.ty));
      if (distance <= config.challengeRadiusTiles && (!closest || distance < closest.distance)) {
        closest = { sessionId, name: player.name, distance };
      }
    }
  });

  for (const sessionId of rendered.keys()) {
    if (!present.has(sessionId)) rendered.delete(sessionId);
  }

  nearby = closest;
  // players.size is what this client can see, not the instance's population —
  // interest management means those are different numbers now.
  populationEl.textContent = `${players.size} visible · ${room.state.population} / ${config.zoneCapacity} here`;
  roomEl.textContent = `${room.state.zoneName} — ${room.state.zoneSubtitle} · instance ${room.roomId}`;
}

function draw() {
  const self = rendered.get(room.sessionId);
  // Instances of different zones are different sizes, so bounds come from
  // state — in tiles, which only the client turns into pixels.
  const zone = {
    width: (room.state?.width || 0) * config.tileSize || canvas.width,
    height: (room.state?.height || 0) * config.tileSize || canvas.height,
  };
  const camera = {
    x: clamp((self?.x ?? zone.width / 2) - canvas.width / 2, 0, Math.max(0, zone.width - canvas.width)),
    y: clamp((self?.y ?? zone.height / 2) - canvas.height / 2, 0, Math.max(0, zone.height - canvas.height)),
  };

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawTerrain(camera, zone);

  // Trees, rocks and players are drawn together in depth order, so you pass
  // behind a tree rather than through it.
  const standing = [];
  for (const [sessionId, entry] of rendered) standing.push({ y: entry.y, draw: () => drawCharacter(entry, sessionId, camera) });
  collectTallTerrain(camera, standing);
  standing.sort((a, b) => a.y - b.y);
  for (const item of standing) item.draw();
}

// One palette + decoration set per chapter energy, matching the zone's theme
// (server-assigned per zone, see server/src/zones.ts). Shades within a kind
// sit close together on purpose: enough variation that a field isn't a flat
// slab, not so much that it reads as a checkerboard.
const THEMES = {
  // Genesis — Eden: bright, lush, untroubled.
  light: {
    bg: "#16240f",
    ground: {
      grass: ["#5a8f49", "#5c9250", "#57894a", "#619752"],
      flowers: ["#5a8f49"],
      path: ["#c9ad78", "#c4a670", "#cdb280"],
      sand: ["#e3d3a0", "#e0cf9c"],
      water: ["#3f8fd0", "#4192cf"],
      tree: ["#54874a"],
      rock: ["#5a8f49"],
    },
    flowerColors: ["#f0dd6e", "#ea88ac", "#e8e8f2"],
    tree: "oak",
    rock: "boulder",
  },
  // Exodus — the wilderness: sand to the horizon, one oasis.
  fire: {
    bg: "#2a1c0d",
    ground: {
      grass: ["#8a7a44"],
      flowers: ["#8a7a44"],
      path: ["#c79a5a", "#c29556"],
      sand: ["#e2b877", "#dcae6c", "#e6c084"],
      water: ["#2f8f95", "#31989e"],
      tree: ["#caa25f"],
      rock: ["#caa25f"],
    },
    flowerColors: ["#f0dd6e"],
    tree: "palm",
    rock: "boulder",
  },
  // Kings — the royal city: streets and stone.
  earth: {
    bg: "#221d16",
    ground: {
      grass: ["#7c9457"],
      flowers: ["#7c9457"],
      path: ["#a89a83", "#a2937c", "#ad9f88"],
      sand: ["#c9b899"],
      water: ["#3f74a8"],
      tree: ["#a89a83"],
      rock: ["#a89a83"],
    },
    flowerColors: ["#e8d26a"],
    tree: "oak",
    rock: "building",
  },
  // Prophets — the highlands: dry, windswept, rocky.
  spirit: {
    bg: "#1c1f22",
    ground: {
      grass: ["#6c7a63", "#6f7d66", "#697760"],
      flowers: ["#6c7a63"],
      path: ["#9c9a92", "#96948c"],
      sand: ["#b7b2a2"],
      water: ["#4f7d8a"],
      tree: ["#63705f"],
      rock: ["#63705f"],
    },
    flowerColors: ["#e8e8f2", "#c9b6e0"],
    tree: "oak",
    rock: "crag",
  },
  // Gospel — Galilee: fresh green shores around a great lake.
  water: {
    bg: "#0f2420",
    ground: {
      grass: ["#4e8a5e", "#50905f", "#4b8459"],
      flowers: ["#4e8a5e"],
      path: ["#b3a077"],
      sand: ["#d6c69a"],
      water: ["#2f7fa0", "#2f86a8", "#337f9c"],
      tree: ["#487d55"],
      rock: ["#487d55"],
    },
    flowerColors: ["#e8e8f2", "#f0dd6e"],
    tree: "oak",
    rock: "boulder",
  },
  // Revelation — the new creation: scorched, dark, unquiet.
  shadow: {
    bg: "#180a12",
    ground: {
      grass: ["#3c3540", "#3f3742", "#39323d"],
      flowers: ["#3c3540"],
      path: ["#332a34", "#362d37"],
      sand: ["#4a3f47"],
      water: ["#1c1224", "#20142a"],
      tree: ["#332a34"],
      rock: ["#332a34"],
    },
    flowerColors: ["#c96b6b"],
    tree: "dead",
    rock: "rubble",
  },
};

function currentTheme() {
  return THEMES[room.state?.zoneTheme] ?? THEMES.light;
}

/** Stable per-tile variation, so the same tile always looks the same. */
function tileNoise(tx, ty) {
  const value = Math.sin(tx * 127.1 + ty * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function tileAt(tx, ty) {
  if (!terrain) return "grass";
  const char = terrain.rows[ty]?.[tx];
  if (!char) return "grass";
  for (const [kind, spec] of Object.entries(config.terrain)) if (spec.char === char) return kind;
  return "grass";
}

function visibleTiles(camera) {
  const size = config.tileSize;
  return {
    fromX: Math.max(0, Math.floor(camera.x / size)),
    toX: Math.min((terrain?.width ?? 0) - 1, Math.ceil((camera.x + canvas.width) / size)),
    fromY: Math.max(0, Math.floor(camera.y / size)),
    toY: Math.min((terrain?.height ?? 0) - 1, Math.ceil((camera.y + canvas.height) / size)),
  };
}

function drawTerrain(camera, zone) {
  const size = config.tileSize;
  const theme = currentTheme();

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const { fromX, toX, fromY, toY } = visibleTiles(camera);
  const shimmer = performance.now() / 700;

  for (let ty = fromY; ty <= toY; ty++) {
    for (let tx = fromX; tx <= toX; tx++) {
      const kind = tileAt(tx, ty);
      const noise = tileNoise(tx, ty);
      const x = Math.round(tx * size - camera.x);
      const y = Math.round(ty * size - camera.y);
      const palette = theme.ground[kind] ?? theme.ground.grass;

      ctx.fillStyle = palette[Math.floor(noise * palette.length)];
      ctx.fillRect(x, y, size, size);

      if (kind === "water") {
        // A couple of drifting highlights, enough to read as moving water.
        ctx.fillStyle = "rgba(255,255,255,0.13)";
        const wave = Math.sin(shimmer + tx * 0.7 + ty * 0.4) * 3;
        ctx.fillRect(x + 4, y + 10 + wave, size - 12, 2);
        ctx.fillStyle = "rgba(255,255,255,0.07)";
        ctx.fillRect(x + 9, y + 21 - wave, size - 18, 2);
      } else if (kind === "grass" && noise > 0.86) {
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(x + 6, y + 18, 5, 3);
        ctx.fillRect(x + 18, y + 9, 5, 3);
      } else if (kind === "flowers") {
        const colours = theme.flowerColors;
        ctx.fillStyle = colours[Math.floor(noise * colours.length)];
        ctx.fillRect(x + 8 + noise * 6, y + 10 + noise * 8, 4, 4);
        ctx.fillRect(x + 19, y + 20, 3, 3);
      } else if (kind === "path" && noise > 0.8) {
        ctx.fillStyle = "rgba(0,0,0,0.06)";
        ctx.fillRect(x + 7, y + 13, 6, 4);
      }
    }
  }

  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(-camera.x, -camera.y, zone.width, zone.height);
}

/** Trees and rocks stand up out of their tile, so they sort with the players. */
function collectTallTerrain(camera, into) {
  const size = config.tileSize;
  const theme = currentTheme();
  const { fromX, toX, fromY, toY } = visibleTiles(camera);

  for (let ty = fromY; ty <= toY; ty++) {
    for (let tx = fromX; tx <= toX; tx++) {
      const kind = tileAt(tx, ty);
      if (kind !== "tree" && kind !== "rock") continue;
      const x = tx * size - camera.x;
      const y = ty * size - camera.y;
      into.push({
        y: ty * size + size,
        draw: () =>
          kind === "tree"
            ? drawTree(x, y, tileNoise(tx, ty), theme.tree)
            : drawRock(x, y, tileNoise(tx, ty), theme.rock),
      });
    }
  }
}

function drawTree(x, y, noise, style) {
  if (style === "palm") return drawPalm(x, y, noise);
  if (style === "dead") return drawDeadTree(x, y, noise);
  drawOak(x, y, noise);
}

function drawOak(x, y, noise) {
  const size = config.tileSize;
  groundShadow(x, y, size, 0.34, 0.14);

  ctx.fillStyle = "#6b4a2f";
  ctx.fillRect(x + size / 2 - 3, y + size - 14, 6, 12);

  const canopy = ["#2f5c2a", "#356630", "#2b5526"][Math.floor(noise * 3)];
  ctx.fillStyle = canopy;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2 - 8, size * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.arc(x + size / 2 - 5, y + size / 2 - 13, size * 0.2, 0, Math.PI * 2);
  ctx.fill();
}

function drawPalm(x, y, noise) {
  const size = config.tileSize;
  const cx = x + size / 2;
  const top = y + size / 2 - 12;
  groundShadow(x, y, size, 0.3, 0.12);

  // A gently curved trunk, leaning with the wind rather than dead straight.
  const lean = (noise - 0.5) * 6;
  ctx.strokeStyle = "#8a6a3c";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx, y + size - 2);
  ctx.quadraticCurveTo(cx + lean, y + size / 2, cx + lean * 1.4, top);
  ctx.stroke();

  const frondColour = "#3f8a4a";
  for (const angle of [-70, -35, 0, 35, 70]) {
    const rad = (angle * Math.PI) / 180;
    ctx.strokeStyle = frondColour;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx + lean * 1.4, top);
    ctx.quadraticCurveTo(
      cx + lean * 1.4 + Math.sin(rad) * 14,
      top - 6,
      cx + lean * 1.4 + Math.sin(rad) * 20,
      top + Math.cos(rad) * 4,
    );
    ctx.stroke();
  }
}

function drawDeadTree(x, y, noise) {
  const size = config.tileSize;
  const cx = x + size / 2;
  groundShadow(x, y, size, 0.28, 0.11);

  ctx.strokeStyle = "#241f26";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx, y + size - 2);
  ctx.lineTo(cx, y + size / 2 - 6);
  ctx.stroke();

  ctx.lineWidth = 2.5;
  for (const [dx, dy, ex, ey] of [
    [0, -4, -9, -14],
    [0, -10, 8, -18],
    [0, -16, -6 * (noise > 0.5 ? 1 : -1), -22],
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx, y + size / 2 + dy);
    ctx.lineTo(cx + ex, y + size / 2 + ey);
    ctx.stroke();
  }
}

function drawRock(x, y, noise, style) {
  if (style === "building") return drawBuilding(x, y, noise);
  if (style === "crag") return drawCrag(x, y, noise);
  if (style === "rubble") return drawRubble(x, y, noise);
  drawBoulder(x, y);
}

function drawBoulder(x, y) {
  const size = config.tileSize;
  groundShadow(x, y, size, 0.3, 0.12, 6);

  ctx.fillStyle = "#7d8285";
  ctx.beginPath();
  ctx.moveTo(x + 5, y + size - 6);
  ctx.lineTo(x + 11, y + 10);
  ctx.lineTo(x + 22, y + 8);
  ctx.lineTo(x + size - 4, y + size - 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.beginPath();
  ctx.moveTo(x + 11, y + 10);
  ctx.lineTo(x + 22, y + 8);
  ctx.lineTo(x + 18, y + 17);
  ctx.closePath();
  ctx.fill();
}

function drawBuilding(x, y, noise) {
  const size = config.tileSize;
  groundShadow(x, y, size, 0.36, 0.13, 4);

  const wall = ["#d9c9a6", "#cdbd9a", "#c3b28f"][Math.floor(noise * 3)];
  const roof = ["#8a4a3a", "#7a4034", "#96543f"][Math.floor((1 - noise) * 3)];

  ctx.fillStyle = wall;
  ctx.fillRect(x + 4, y + size / 2 - 4, size - 8, size / 2);

  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(x + 2, y + size / 2 - 4);
  ctx.lineTo(x + size / 2, y + 4);
  ctx.lineTo(x + size - 2, y + size / 2 - 4);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#5c4632";
  ctx.fillRect(x + size / 2 - 3, y + size - 12, 6, 10);
  ctx.fillStyle = "rgba(255, 224, 138, 0.55)";
  ctx.fillRect(x + 8, y + size / 2 + 2, 4, 4);
  ctx.fillRect(x + size - 12, y + size / 2 + 2, 4, 4);
}

function drawCrag(x, y, noise) {
  const size = config.tileSize;
  groundShadow(x, y, size, 0.32, 0.12, 6);

  ctx.fillStyle = "#565a68";
  ctx.beginPath();
  ctx.moveTo(x + 4, y + size - 4);
  ctx.lineTo(x + 8, y + size * 0.45);
  ctx.lineTo(x + size / 2 - 2, y + 2);
  ctx.lineTo(x + size / 2 + 6, y + size * 0.4);
  ctx.lineTo(x + size - 6, y + size * 0.35);
  ctx.lineTo(x + size - 3, y + size - 4);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.beginPath();
  ctx.moveTo(x + size / 2 - 2, y + 2);
  ctx.lineTo(x + size / 2 + 6, y + size * 0.4);
  ctx.lineTo(x + size / 2 - 4, y + size * 0.5);
  ctx.closePath();
  ctx.fill();

  if (noise > 0.5) {
    // A wisp of low cloud snagged on the peak — this is the windswept zone.
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(x + size / 2 - 8, y - 2, 16, 3);
  }
}

function drawRubble(x, y, noise) {
  const size = config.tileSize;
  groundShadow(x, y, size, 0.34, 0.13, 6);

  ctx.fillStyle = "#2b2530";
  ctx.beginPath();
  ctx.moveTo(x + 3, y + size - 4);
  ctx.lineTo(x + 9, y + size * 0.5);
  ctx.lineTo(x + size / 2, y + size * 0.2);
  ctx.lineTo(x + size - 8, y + size * 0.55);
  ctx.lineTo(x + size - 3, y + size - 4);
  ctx.closePath();
  ctx.fill();

  // A coal-like glow in the cracks — this is ruin, not just stone.
  ctx.fillStyle = `rgba(224, 90, 70, ${0.25 + noise * 0.25})`;
  ctx.fillRect(x + size / 2 - 2, y + size * 0.55, 3, 6);
  ctx.fillRect(x + size / 2 + 6, y + size * 0.65, 2, 5);
}

function groundShadow(x, y, size, rx, ry, offset = 4) {
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(x + size / 2, y + size - offset, size * rx, size * ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

const SHIRTS = ["#c0553f", "#3f74c0", "#4aa05e", "#9a5bb5", "#c9873f", "#3fa2a8"];

function shirtColour(name) {
  let hash = 0;
  for (let i = 0; i < (name ?? "").length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return SHIRTS[hash % SHIRTS.length];
}

function drawCharacter(entry, sessionId, camera) {
  const isSelf = sessionId === room.sessionId;
  const size = config.tileSize;
  const x = Math.round(entry.x - camera.x);
  const feet = Math.round(entry.y - camera.y) + size / 2 - 4;

  // Walk cycle: legs alternate and the body bobs, driven by distance covered
  // rather than time, so it stays in step with the tile the server puts us on.
  entry.phase = (entry.phase ?? 0) + (entry.moving ? 0.22 : 0);
  if (!entry.moving) entry.phase = 0;
  const swing = Math.sin(entry.phase) * 3;
  const bob = entry.moving ? Math.abs(Math.sin(entry.phase)) * 1.5 : 0;

  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(x, feet + 2, 9, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();

  if (nearby?.sessionId === sessionId) {
    ctx.strokeStyle = "#8ee88e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, feet + 2, 13, 6, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  const top = feet - 26 - bob;

  ctx.fillStyle = "#2f3a4a";
  ctx.fillRect(x - 5, feet - 9 + swing * 0.3, 4, 9 - swing * 0.3);
  ctx.fillRect(x + 1, feet - 9 - swing * 0.3, 4, 9 + swing * 0.3);

  ctx.fillStyle = shirtColour(entry.name);
  roundedRect(x - 7, top + 10, 14, 13, 3);
  ctx.fill();

  // Arms read as depth cues when facing sideways.
  ctx.fillStyle = "#e8b48c";
  if (entry.dir === "left") ctx.fillRect(x - 9, top + 12 + swing, 3, 8);
  else if (entry.dir === "right") ctx.fillRect(x + 6, top + 12 - swing, 3, 8);
  else {
    ctx.fillRect(x - 9, top + 12 + swing, 3, 8);
    ctx.fillRect(x + 6, top + 12 - swing, 3, 8);
  }

  ctx.fillStyle = "#e8b48c";
  ctx.beginPath();
  ctx.arc(x, top + 4, 7.5, 0, Math.PI * 2);
  ctx.fill();

  // Hair covers the whole head from behind and leaves a face otherwise.
  ctx.fillStyle = isSelf ? "#4a3520" : "#2f2a26";
  ctx.beginPath();
  if (entry.dir === "up") ctx.arc(x, top + 4, 7.5, 0, Math.PI * 2);
  else ctx.arc(x, top + 2.5, 7.5, Math.PI, Math.PI * 2);
  ctx.fill();

  if (entry.dir !== "up") {
    ctx.fillStyle = "#2b2b33";
    const eyes = entry.dir === "left" ? [-4] : entry.dir === "right" ? [3] : [-3, 2];
    for (const offset of eyes) ctx.fillRect(x + offset, top + 5, 2, 2);
  }

  if (entry.inBattle) {
    ctx.strokeStyle = "#e06c75";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, feet + 2, 13, 6, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.strokeText(entry.name ?? "", x, top - 8);
  ctx.fillStyle = isSelf ? "#ffe08a" : "#ffffff";
  ctx.fillText(entry.name ?? "", x, top - 8);
}

function roundedRect(x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function drawOverlays(now) {
  const showingNotice = notice && now < noticeUntil;
  const promptText =
    mode === "roaming" && nearby ? `Press E to challenge ${nearby.name}` : showingNotice ? notice : "";

  promptEl.hidden = promptText === "";
  if (promptText) promptEl.textContent = promptText;

  const overlay = overlayContent();
  const signature = JSON.stringify(overlay);
  if (signature === lastOverlaySignature) return;
  lastOverlaySignature = signature;

  overlayEl.hidden = overlay === null;
  if (overlay) overlayEl.innerHTML = overlay.map((line) => line).join("");
}

function overlayContent() {
  if (mode === "challenged" && incomingChallenge) {
    return [
      `<strong>${escapeHtml(incomingChallenge.name)} challenges you!</strong>`,
      `<div class="keys">[Y] accept · [N] decline</div>`,
    ];
  }

  if (mode === "awaiting") {
    return [`<strong>Waiting for ${escapeHtml(incomingChallenge?.name ?? "your opponent")}…</strong>`];
  }

  if (mode === "battling") {
    const state = battleRoom?.state;
    if (!state) return [`<strong>Entering battle…</strong>`];

    if (state.phase === "resolved") {
      const won = state.winnerZoneSessionId === room.sessionId;
      const headline = state.outcome === "forfeit" ? (won ? "Opponent forfeited" : "You forfeited") : won ? "You win!" : "You lose";
      return [`<strong>${headline}</strong>`, `<div class="keys">returning to the overworld…</div>`];
    }

    const names = [];
    state.players.forEach((player) => names.push(`${escapeHtml(player.name)}${player.ready ? " ✓" : ""}`));
    return [
      `<strong>Battle — ${names.join(" vs ")}</strong>`,
      `<div class="keys">${state.phase === "active" ? "[R] ready up" : "waiting for your opponent…"}</div>`,
      `<div class="keys">(placeholder match — the TCG ruleset goes here)</div>`,
    ];
  }

  return null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

requestAnimationFrame(frame);
