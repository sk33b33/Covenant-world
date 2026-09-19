export const TILE_SIZE = 32;

export const WORLD_TILES = { width: 40, height: 30 };

export const WORLD = {
  width: WORLD_TILES.width * TILE_SIZE,
  height: WORLD_TILES.height * TILE_SIZE,
};

/** Pixels per second — 4 tiles/s, roughly a Pokemon-style walking pace. */
export const PLAYER_SPEED = 4 * TILE_SIZE;

/** Simulation ticks per second. */
export const TICK_RATE = 20;

/**
 * Per-zone-instance player cap. Sharding into multiple instances of the same
 * zone (not built yet) is what carries the game past this number — see
 * docs/ARCHITECTURE.md.
 */
export const ZONE_CAPACITY = Number(process.env.ZONE_CAPACITY ?? 150);

/** How close two players must stand before either can challenge the other. */
export const CHALLENGE_RADIUS = 2 * TILE_SIZE;

/** An unanswered challenge expires rather than pinning both players in place. */
export const CHALLENGE_TIMEOUT_MS = 15_000;

/** A battle room with nobody in it disposes rather than lingering. */
export const BATTLE_JOIN_GRACE_MS = 10_000;

/** How long a finished battle stays open so both clients can read the result. */
export const BATTLE_RESULT_LINGER_MS = 3_000;

/** Presence topic a battle publishes its result on, scoped to the zone that spawned it. */
export const battleResultTopic = (zoneRoomId: string) => `battle:resolved:${zoneRoomId}`;

export const PORT = Number(process.env.PORT ?? 2567);
