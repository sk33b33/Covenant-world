import { Room, matchMaker, type Client } from "colyseus";
import { StateView, schema, t, type SchemaType } from "@colyseus/schema";
import {
  CHALLENGE_RADIUS,
  CHALLENGE_TIMEOUT_MS,
  PLAYER_SPEED,
  SPAWN_SPREAD,
  TICK_RATE,
  VIEW_EXIT_RADIUS,
  VIEW_RADIUS,
  VISIBILITY_HZ,
  WORLD,
  ZONE_CAPACITY,
  battleResultTopic,
} from "../config.js";
import type { BattleOptions, BattleResult } from "./BattleRoom.js";

export const Player = schema(
  {
    x: t.number(),
    y: t.number(),
    name: t.string(),
    dir: t.string().default("down"),
    moving: t.boolean().default(false),
    /** Frozen in place and un-challengeable while away in a battle room. */
    inBattle: t.boolean().default(false),
  },
  "Player",
);
export type Player = SchemaType<typeof Player>;

export const ZoneState = schema(
  {
    // View-tagged: a client receives only the players its StateView holds,
    // which the visibility pass below keeps to those within VIEW_RADIUS.
    players: t.map(Player).view(),
    /** Everyone in the zone, not just those visible — the map no longer says. */
    population: t.number().default(0),
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

  /** Outstanding challenges, keyed by the session that sent them. */
  private challenges = new Map<string, { target: string; expiresAt: number }>();

  /** Who each client can currently see, so a visibility pass only sends the difference. */
  private visible = new Map<string, Set<string>>();

  private ticksSinceVisibility = 0;

  onCreate() {
    this.setState(new ZoneState());

    this.onMessage("input", (client, message) => {
      this.heldInputs.set(client.sessionId, sanitizeInput(message));
    });

    this.onMessage("challenge", (client, message) => {
      this.onChallenge(client, String(message?.targetSessionId ?? ""));
    });

    this.onMessage("challenge:respond", (client, message) => {
      void this.onChallengeResponse(client, String(message?.from ?? ""), message?.accept === true);
    });

    this.presence.subscribe(battleResultTopic(this.roomId), this.onBattleResolved);

    this.setSimulationInterval((deltaMs) => this.update(deltaMs), 1000 / TICK_RATE);
  }

  onDispose() {
    this.presence.unsubscribe(battleResultTopic(this.roomId), this.onBattleResolved);
  }

  onJoin(client: Client, options?: { name?: string }) {
    const player = new Player({
      ...randomSpawn(),
      name: sanitizeName(options?.name, `Player ${this.clients.length}`),
    });

    this.state.players.set(client.sessionId, player);
    this.state.population = this.state.players.size;
    this.heldInputs.set(client.sessionId, { ...NO_INPUT });

    // You can always see yourself; everyone else arrives on the next pass.
    client.view = new StateView();
    client.view.add(player);
    this.visible.set(client.sessionId, new Set([client.sessionId]));
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.state.population = this.state.players.size;
    this.heldInputs.delete(client.sessionId);
    this.visible.delete(client.sessionId);
    this.cancelChallengesInvolving(client.sessionId);
    client.view?.clear();
  }

  private onChallenge(client: Client, targetSessionId: string) {
    const challenger = this.state.players.get(client.sessionId);
    const target = this.state.players.get(targetSessionId);

    if (!challenger || !target || targetSessionId === client.sessionId) return;
    if (challenger.inBattle || target.inBattle) return;
    if (this.challenges.has(client.sessionId)) return;
    if (distanceBetween(challenger, target) > CHALLENGE_RADIUS) {
      client.send("challenge:failed", { reason: "too far away" });
      return;
    }

    this.challenges.set(client.sessionId, { target: targetSessionId, expiresAt: Date.now() + CHALLENGE_TIMEOUT_MS });

    client.send("challenge:sent", { to: targetSessionId, name: target.name });
    this.clients
      .getById(targetSessionId)
      ?.send("challenge:received", { from: client.sessionId, name: challenger.name });
  }

  private async onChallengeResponse(client: Client, challengerSessionId: string, accepted: boolean) {
    const challenge = this.challenges.get(challengerSessionId);
    if (!challenge || challenge.target !== client.sessionId) return;

    this.challenges.delete(challengerSessionId);

    const challenger = this.state.players.get(challengerSessionId);
    const target = this.state.players.get(client.sessionId);
    const challengerClient = this.clients.getById(challengerSessionId);

    if (!accepted) {
      challengerClient?.send("challenge:declined", { by: target?.name ?? "" });
      return;
    }

    // Both could have moved, disconnected, or been pulled into another battle
    // between the challenge and the answer.
    if (!challenger || !target || challenger.inBattle || target.inBattle) return;
    if (distanceBetween(challenger, target) > CHALLENGE_RADIUS) {
      client.send("challenge:failed", { reason: "too far away" });
      challengerClient?.send("challenge:failed", { reason: "too far away" });
      return;
    }

    challenger.inBattle = true;
    target.inBattle = true;

    try {
      const options: BattleOptions = {
        zoneRoomId: this.roomId,
        participants: [
          { zoneSessionId: challengerSessionId, name: challenger.name },
          { zoneSessionId: client.sessionId, name: target.name },
        ],
      };
      const battle = await matchMaker.createRoom("battle", options);

      for (const participant of options.participants) {
        const reservation = await matchMaker.reserveSeatFor(battle, { zoneSessionId: participant.zoneSessionId });
        this.clients.getById(participant.zoneSessionId)?.send("battle:start", { reservation });
      }
    } catch (error) {
      challenger.inBattle = false;
      target.inBattle = false;
      const reason = "could not start the battle";
      client.send("challenge:failed", { reason });
      challengerClient?.send("challenge:failed", { reason });
      throw error;
    }
  }

  private onBattleResolved = (result: BattleResult) => {
    for (const zoneSessionId of result.participants) {
      const player = this.state.players.get(zoneSessionId);
      if (player) player.inBattle = false;

      this.clients.getById(zoneSessionId)?.send("battle:result", {
        outcome: result.outcome,
        won: result.winnerZoneSessionId === zoneSessionId,
      });
    }
  };

  private cancelChallengesInvolving(sessionId: string) {
    this.challenges.delete(sessionId);
    for (const [challengerSessionId, challenge] of this.challenges) {
      if (challenge.target === sessionId) this.challenges.delete(challengerSessionId);
    }
  }

  private expireChallenges() {
    const now = Date.now();
    for (const [challengerSessionId, challenge] of this.challenges) {
      if (challenge.expiresAt > now) continue;
      this.challenges.delete(challengerSessionId);
      this.clients.getById(challengerSessionId)?.send("challenge:expired", { to: challenge.target });
    }
  }

  /**
   * Recomputes who each client can see. Comparing every player against every
   * other is O(n²) — at 150 players that's 22,500 distance checks per pass —
   * so players are bucketed into a grid of view-radius-sized cells first and
   * each client only considers the nine cells around it.
   */
  private updateVisibility() {
    const cells = new Map<string, string[]>();

    this.state.players.forEach((player, sessionId) => {
      const key = cellKey(player.x, player.y);
      const bucket = cells.get(key);
      if (bucket) bucket.push(sessionId);
      else cells.set(key, [sessionId]);
    });

    for (const client of this.clients) {
      const self = this.state.players.get(client.sessionId);
      const previous = this.visible.get(client.sessionId);
      if (!self || !previous || !client.view) continue;

      const next = new Set([client.sessionId]);
      const column = Math.floor(self.x / CELL_SIZE);
      const row = Math.floor(self.y / CELL_SIZE);

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const otherId of cells.get(`${column + dx}:${row + dy}`) ?? []) {
            if (otherId === client.sessionId) continue;

            const other = this.state.players.get(otherId);
            if (!other) continue;

            const limit = previous.has(otherId) ? VIEW_EXIT_RADIUS : VIEW_RADIUS;
            if (Math.hypot(self.x - other.x, self.y - other.y) <= limit) next.add(otherId);
          }
        }
      }

      for (const sessionId of next) {
        if (previous.has(sessionId)) continue;
        const player = this.state.players.get(sessionId);
        if (player) client.view.add(player);
      }

      for (const sessionId of previous) {
        if (next.has(sessionId)) continue;
        const player = this.state.players.get(sessionId);
        // A player who left the zone is already gone from every view.
        if (player) client.view.remove(player);
      }

      this.visible.set(client.sessionId, next);
    }
  }

  private update(deltaMs: number) {
    const delta = deltaMs / 1000;
    this.expireChallenges();

    if (++this.ticksSinceVisibility >= TICK_RATE / VISIBILITY_HZ) {
      this.ticksSinceVisibility = 0;
      this.updateVisibility();
    }

    this.state.players.forEach((player, sessionId) => {
      if (player.inBattle) {
        if (player.moving) player.moving = false;
        return;
      }

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

/** Cell size is the exit radius, so the nine cells around a player always cover it. */
const CELL_SIZE = VIEW_EXIT_RADIUS;

function cellKey(x: number, y: number) {
  return `${Math.floor(x / CELL_SIZE)}:${Math.floor(y / CELL_SIZE)}`;
}

function randomSpawn() {
  return {
    x: clamp(WORLD.width / 2 + (Math.random() - 0.5) * SPAWN_SPREAD, 0, WORLD.width),
    y: clamp(WORLD.height / 2 + (Math.random() - 0.5) * SPAWN_SPREAD, 0, WORLD.height),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distanceBetween(a: Player, b: Player) {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
