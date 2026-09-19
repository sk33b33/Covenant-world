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
let lastSent = null;

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
const name = new URLSearchParams(location.search).get("name") ?? "";
const colyseus = new Colyseus.Client(endpoint);

let room;
let battleRoom = null;
try {
  room = await colyseus.joinOrCreate("zone", { name });
} catch (error) {
  statusEl.textContent = `could not join: ${error.message}`;
  throw error;
}

// This is a test client — the live room handles are deliberately reachable from
// the console (and from automated smoke tests).
window.room = room;

statusEl.textContent = "connected";
roomEl.textContent = `zone ${room.roomId}`;
room.onLeave(() => {
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

window.addEventListener("keydown", onKey);
window.addEventListener("keyup", onKey);

function onKey(event) {
  const direction = KEY_BINDINGS[event.code];

  if (direction) {
    event.preventDefault();
    // Movement keys are dead outside the overworld — the server freezes you
    // during a battle anyway, so releasing them here keeps the two in step.
    held[direction] = mode === "roaming" && event.type === "keydown";
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
  drawOverlays(now);

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
  const self = players.get(room.sessionId);
  let closest = null;

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
    entry.inBattle = player.inBattle;

    if (self && !self.inBattle && !player.inBattle && sessionId !== room.sessionId) {
      const distance = Math.hypot(self.x - player.x, self.y - player.y);
      if (distance <= config.challengeRadius && (!closest || distance < closest.distance)) {
        closest = { sessionId, name: player.name, distance };
      }
    }
  });

  for (const sessionId of rendered.keys()) {
    if (!present.has(sessionId)) rendered.delete(sessionId);
  }

  nearby = closest;
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
    drawPlayer(entry, sessionId, camera);
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

function drawPlayer(entry, sessionId, camera) {
  const isSelf = sessionId === room.sessionId;
  const x = entry.x - camera.x;
  const y = entry.y - camera.y;
  const radius = config.tileSize / 2;

  if (nearby?.sessionId === sessionId) {
    ctx.strokeStyle = "#7ddc7d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = isSelf ? "#f2c14e" : "#6fa8dc";
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  if (entry.inBattle) {
    ctx.strokeStyle = "#e06c75";
    ctx.lineWidth = 3;
    ctx.stroke();
  } else if (isSelf) {
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
