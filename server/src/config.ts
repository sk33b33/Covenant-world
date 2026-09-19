export const TILE_SIZE = 32;

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

/** New arrivals land near each other rather than scattered across the zone. */
export const SPAWN_SPREAD = 6 * TILE_SIZE;

/** How close to an edge counts as walking out of the zone. */
export const EDGE_THRESHOLD = 2;

/**
 * How far a player can see. Players outside this radius are not sent to that
 * client at all — this, not the zone cap, is what keeps per-client bandwidth
 * flat as a zone fills up.
 */
export const VIEW_RADIUS = 18 * TILE_SIZE;

/**
 * Players already visible stay visible slightly past {@link VIEW_RADIUS}.
 * Without the gap, anyone loitering exactly on the boundary would be added
 * and removed repeatedly, and every re-add re-sends the whole entity.
 */
export const VIEW_EXIT_RADIUS = VIEW_RADIUS * 1.1;

/**
 * Visibility recomputes at this rate rather than every tick. At walking pace
 * a player crosses a small fraction of the view radius between passes, so
 * 5Hz costs a fraction of the work for no perceptible pop-in.
 */
export const VISIBILITY_HZ = 5;

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
