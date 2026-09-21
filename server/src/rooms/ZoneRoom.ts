import { Room, matchMaker, type Client } from "colyseus";
import { StateView, schema, t, type SchemaType } from "@colyseus/schema";
import {
  CHALLENGE_RADIUS_TILES,
  CHALLENGE_TIMEOUT_MS,
  SPAWN_SPREAD_TILES,
  STEP_DURATION_MS,
  TICK_RATE,
  TURN_DELAY_MS,
  VIEW_EXIT_RADIUS_TILES,
  VIEW_RADIUS_TILES,
  VISIBILITY_HZ,
  ZONE_CAPACITY,
  battleResultTopic,
} from "../config.js";
import { OPPOSITE_EDGE, getZone, isValidEntry, type Edge, type ZoneDefinition } from "../zones.js";
import { buildTileMap, isWalkableTile, type TileMap } from "../terrain.js";
import type { BattleOptions, BattleResult } from "./BattleRoom.js";

export const Player = schema(
  {
    /**
     * The tile this player occupies — or, mid-step, the one being stepped
     * onto. Tiles rather than pixels means a walking player produces one
     * update per step instead of one per tick.
     */
    tx: t.uint16(),
    ty: t.uint16(),
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
    /** Everyone in this instance, not just those visible — the map no longer says. */
    population: t.number().default(0),
    zoneId: t.string().default(""),
    zoneName: t.string().default(""),
    zoneSubtitle: t.string().default(""),
    /** Drives the client's palette and decoration choices for this zone. */
    zoneTheme: t.string().default(""),
    /** Zone size in tiles. Travels with the state since instances differ. */
    width: t.uint16().default(0),
    height: t.uint16().default(0),
  },
  "ZoneState",
);
export type ZoneState = SchemaType<typeof ZoneState>;

type Input = { up: boolean; down: boolean; left: boolean; right: boolean };

const NO_INPUT: Input = { up: false, down: false, left: false, right: false };

type Direction = "up" | "down" | "left" | "right";

const STEPS: Record<Direction, { dx: number; dy: number; edge: Edge }> = {
  up: { dx: 0, dy: -1, edge: "north" },
  down: { dx: 0, dy: 1, edge: "south" },
  left: { dx: -1, dy: 0, edge: "west" },
  right: { dx: 1, dy: 0, edge: "east" },
};

const DIRECTIONS = Object.keys(STEPS) as Direction[];

/** When a step or turn may next begin. Not synchronized — only its results are. */
type Motion = { stepEndsAt: number; turnReadyAt: number };

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

  /** Which zone this instance is one of. Several instances of it may be running. */
  private zone: ZoneDefinition = getZone(undefined);
  private terrain: TileMap = buildTileMap(this.zone);

  /** Step and turn timing per player. */
  private motion = new Map<string, Motion>();

  /** Players already told to travel, so the crossing only fires once. */
  private departing = new Set<string>();

  onCreate(options?: { zoneId?: string }) {
    this.zone = getZone(options?.zoneId);
    this.terrain = buildTileMap(this.zone);

    // The matchmaker filters on this, so a player asking for "meadow" is only
    // ever offered a meadow instance.
    this.setMetadata({ zoneId: this.zone.id });

    this.setState(new ZoneState());
    this.state.zoneId = this.zone.id;
    this.state.zoneName = this.zone.name;
    this.state.zoneSubtitle = this.zone.subtitle;
    this.state.zoneTheme = this.zone.theme;
    this.state.width = this.zone.tiles.width;
    this.state.height = this.zone.tiles.height;

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

    this.setSimulationInterval(() => this.update(), 1000 / TICK_RATE);
  }

  onDispose() {
    this.presence.unsubscribe(battleResultTopic(this.roomId), this.onBattleResolved);
  }

  onJoin(client: Client, options?: { name?: string; entry?: string }) {
    const player = new Player({
      ...this.spawnPoint(options?.entry),
      name: sanitizeName(options?.name, `Player ${this.clients.length}`),
    });

    this.state.players.set(client.sessionId, player);
    this.state.population = this.state.players.size;
    this.heldInputs.set(client.sessionId, { ...NO_INPUT });
    this.motion.set(client.sessionId, { stepEndsAt: 0, turnReadyAt: 0 });

    // You can always see yourself; everyone else arrives on the next pass.
    client.view = new StateView();
    client.view.add(player);
    this.visible.set(client.sessionId, new Set([client.sessionId]));
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.state.population = this.state.players.size;
    this.heldInputs.delete(client.sessionId);
    this.motion.delete(client.sessionId);
    this.visible.delete(client.sessionId);
    this.departing.delete(client.sessionId);
    this.cancelChallengesInvolving(client.sessionId);
    client.view?.clear();
  }

  /**
   * Arriving from a neighbouring zone puts you just inside the edge you walked
   * in through; arriving fresh puts you near the middle.
   */
  private spawnPoint(entry?: string) {
    const { width, height } = this.zone.tiles;
    const jitter = () => Math.round((Math.random() - 0.5) * SPAWN_SPREAD_TILES);
    const middleX = clamp(Math.floor(width / 2) + jitter(), 0, width - 1);
    const middleY = clamp(Math.floor(height / 2) + jitter(), 0, height - 1);
    const inset = 1;

    const candidate = (() => {
      switch (isValidEntry(this.zone, entry) ? entry : undefined) {
        case "west": return { tx: inset, ty: middleY };
        case "east": return { tx: width - 1 - inset, ty: middleY };
        case "north": return { tx: middleX, ty: inset };
        case "south": return { tx: middleX, ty: height - 1 - inset };
        default: return { tx: middleX, ty: middleY };
      }
    })();

    return this.nearestWalkable(candidate);
  }

  /** Spawn points are picked before terrain is consulted, so nudge off any tree or lake. */
  private nearestWalkable({ tx, ty }: { tx: number; ty: number }) {
    for (let radius = 0; radius < 12; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          if (this.isWalkable(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
        }
      }
    }
    return { tx, ty };
  }

  /** Whether a player may stand on this tile. The client draws from the same map. */
  private isWalkable(tx: number, ty: number) {
    return isWalkableTile(this.terrain, tx, ty);
  }

  /**
   * One step of tile-locked movement. Pressing a direction you aren't facing
   * turns you and stops there, so a tap turns on the spot and a hold walks —
   * then each subsequent step begins only once the previous one finishes.
   */
  private stepPlayer(sessionId: string, player: Player, now: number) {
    const motion = this.motion.get(sessionId);
    if (!motion) return;

    if (player.moving) {
      if (now < motion.stepEndsAt) return;
      player.moving = false;
    }

    const input = this.heldInputs.get(sessionId) ?? NO_INPUT;
    // Keep going the way you're already facing if that's still held, so holding
    // two directions doesn't jitter between them.
    const direction = input[player.dir as Direction]
      ? (player.dir as Direction)
      : DIRECTIONS.find((candidate) => input[candidate]);
    if (!direction) return;

    if (player.dir !== direction) {
      player.dir = direction;
      motion.turnReadyAt = now + TURN_DELAY_MS;
      return;
    }

    if (now < motion.turnReadyAt) return;

    const { dx, dy, edge } = STEPS[direction];
    const tx = player.tx + dx;
    const ty = player.ty + dy;

    // Leaving the map is travel; a tree or a lake is just a wall. These are
    // very different outcomes, so they're checked separately.
    if (tx < 0 || ty < 0 || tx >= this.zone.tiles.width || ty >= this.zone.tiles.height) {
      this.tryZoneCrossing(sessionId, player, edge);
      return;
    }

    if (!this.isWalkable(tx, ty)) return;

    player.tx = tx;
    player.ty = ty;
    player.moving = true;
    motion.stepEndsAt = now + STEP_DURATION_MS;
  }

  /** Walking into an edge that leads somewhere hands the client off to that zone. */
  private tryZoneCrossing(sessionId: string, player: Player, edge: Edge) {
    if (this.departing.has(sessionId) || player.inBattle) return;

    const destination = this.zone.exits[edge];
    if (!destination) return;

    this.departing.add(sessionId);
    this.clients.getById(sessionId)?.send("zone:travel", { zoneId: destination, entry: OPPOSITE_EDGE[edge] });
  }

  private onChallenge(client: Client, targetSessionId: string) {
    const challenger = this.state.players.get(client.sessionId);
    const target = this.state.players.get(targetSessionId);

    if (!challenger || !target || targetSessionId === client.sessionId) return;
    if (challenger.inBattle || target.inBattle) return;
    if (this.challenges.has(client.sessionId)) return;
    if (tilesApart(challenger, target) > CHALLENGE_RADIUS_TILES) {
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
    if (tilesApart(challenger, target) > CHALLENGE_RADIUS_TILES) {
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
      const key = cellKey(player.tx, player.ty);
      const bucket = cells.get(key);
      if (bucket) bucket.push(sessionId);
      else cells.set(key, [sessionId]);
    });

    for (const client of this.clients) {
      const self = this.state.players.get(client.sessionId);
      const previous = this.visible.get(client.sessionId);
      if (!self || !previous || !client.view) continue;

      const next = new Set([client.sessionId]);
      const column = Math.floor(self.tx / CELL_SIZE);
      const row = Math.floor(self.ty / CELL_SIZE);

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const otherId of cells.get(`${column + dx}:${row + dy}`) ?? []) {
            if (otherId === client.sessionId) continue;

            const other = this.state.players.get(otherId);
            if (!other) continue;

            const limit = previous.has(otherId) ? VIEW_EXIT_RADIUS_TILES : VIEW_RADIUS_TILES;
            if (distanceBetween(self, other) <= limit) next.add(otherId);
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

  private update() {
    const now = Date.now();
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

      this.stepPlayer(sessionId, player, now);
    });
  }
}

/** Cell size is the exit radius, so the nine cells around a player always cover it. */
const CELL_SIZE = VIEW_EXIT_RADIUS_TILES;

function cellKey(tx: number, ty: number) {
  return `${Math.floor(tx / CELL_SIZE)}:${Math.floor(ty / CELL_SIZE)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distanceBetween(a: Player, b: Player) {
  return Math.hypot(a.tx - b.tx, a.ty - b.ty);
}

/** Adjacency, counting diagonals — the eight tiles around you, plus your own. */
function tilesApart(a: Player, b: Player) {
  return Math.max(Math.abs(a.tx - b.tx), Math.abs(a.ty - b.ty));
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
