import { Room, type Client } from "colyseus";
import { schema, t, type SchemaType } from "@colyseus/schema";
import { PLAYER_SPEED, TICK_RATE, WORLD, ZONE_CAPACITY } from "../config.js";

export const Player = schema(
  {
    x: t.number(),
    y: t.number(),
    name: t.string(),
    dir: t.string().default("down"),
    moving: t.boolean().default(false),
  },
  "Player",
);
export type Player = SchemaType<typeof Player>;

export const ZoneState = schema(
  {
    players: t.map(Player),
  },
  "ZoneState",
);
export type ZoneState = SchemaType<typeof ZoneState>;

type Input = { up: boolean; down: boolean; left: boolean; right: boolean };

const NO_INPUT: Input = { up: false, down: false, left: false, right: false };

export class ZoneRoom extends Room<{ state: ZoneState }> {
  maxClients = ZONE_CAPACITY;

  // Intent only, never positions: a client says which way it is holding, the
  // simulation below decides where that puts it. Kept off the state schema
  // because no other client needs to see it.
  private heldInputs = new Map<string, Input>();

  onCreate() {
    this.setState(new ZoneState());

    this.onMessage("input", (client, message) => {
      this.heldInputs.set(client.sessionId, sanitizeInput(message));
    });

    this.setSimulationInterval((deltaMs) => this.update(deltaMs), 1000 / TICK_RATE);
  }

  onJoin(client: Client, options?: { name?: string }) {
    const player = new Player({
      ...randomSpawn(),
      name: sanitizeName(options?.name, `Player ${this.clients.length}`),
    });

    this.state.players.set(client.sessionId, player);
    this.heldInputs.set(client.sessionId, { ...NO_INPUT });
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.heldInputs.delete(client.sessionId);
  }

  private update(deltaMs: number) {
    const delta = deltaMs / 1000;

    this.state.players.forEach((player, sessionId) => {
      const input = this.heldInputs.get(sessionId) ?? NO_INPUT;

      let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
      const moving = dx !== 0 || dy !== 0;

      if (moving) {
        if (dx !== 0 && dy !== 0) {
          dx *= Math.SQRT1_2;
          dy *= Math.SQRT1_2;
        }

        player.x = clamp(player.x + dx * PLAYER_SPEED * delta, 0, WORLD.width);
        player.y = clamp(player.y + dy * PLAYER_SPEED * delta, 0, WORLD.height);

        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
        if (player.dir !== dir) player.dir = dir;
      }

      if (player.moving !== moving) player.moving = moving;
    });
  }
}

function randomSpawn() {
  const spread = 4 * 32;
  return {
    x: clamp(WORLD.width / 2 + (Math.random() - 0.5) * spread, 0, WORLD.width),
    y: clamp(WORLD.height / 2 + (Math.random() - 0.5) * spread, 0, WORLD.height),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeInput(raw: unknown): Input {
  const message = (raw ?? {}) as Record<string, unknown>;
  return {
    up: message.up === true,
    down: message.down === true,
    left: message.left === true,
    right: message.right === true,
  };
}

function sanitizeName(raw: unknown, fallback: string) {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 16);
  return cleaned.length > 0 ? cleaned : fallback;
}
