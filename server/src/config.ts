/**
 * Positions are in TILES everywhere on the server — players occupy a tile and
 * step to the next one. Only the client multiplies by this to draw.
 */
export const TILE_SIZE = 32;

/**
 * How long one tile step takes. A Pokemon walk is ~16 frames at 60fps (267ms);
 * this is a touch brisker so roaming doesn't drag.
 */
export const STEP_DURATION_MS = 220;

/**
 * Pressing a direction you aren't facing turns you without moving, and only
 * the *next* step actually walks. That's what makes a tap turn on the spot
 * and a hold walk — without it there's no way to turn around in place.
 */
export const TURN_DELAY_MS = 90;

/** Simulation ticks per second. */
export const TICK_RATE = 20;

/**
 * Per-zone-instance player cap. Sharding into multiple instances of the same
 * zone is what carries the game past this number — see docs/ARCHITECTURE.md.
 */
export const ZONE_CAPACITY = Number(process.env.ZONE_CAPACITY ?? 150);

/** New arrivals land near each other rather than scattered across the zone. */
export const SPAWN_SPREAD_TILES = 6;

/**
 * How far a player can see, in tiles. Players outside this are not sent to
 * that client at all — this, not the zone cap, is what keeps per-client
 * bandwidth flat as a zone fills up.
 */
export const VIEW_RADIUS_TILES = 18;

/**
 * Players already visible stay visible slightly past {@link VIEW_RADIUS_TILES}.
 * Without the gap, anyone loitering exactly on the boundary would be added
 * and removed repeatedly, and every re-add re-sends the whole entity.
 */
export const VIEW_EXIT_RADIUS_TILES = 20;

/**
 * Visibility recomputes at this rate rather than every tick. At walking pace
 * a player crosses a small fraction of the view radius between passes, so
 * 5Hz costs a fraction of the work for no perceptible pop-in.
 */
export const VISIBILITY_HZ = 5;

/** Challengeable when standing on or next to your tile, including diagonals. */
export const CHALLENGE_RADIUS_TILES = 1;

/** An unanswered challenge expires rather than pinning both players in place. */
export const CHALLENGE_TIMEOUT_MS = 15_000;

/** A battle room with nobody in it disposes rather than lingering. */
export const BATTLE_JOIN_GRACE_MS = 10_000;

/** How long a finished battle stays open so both clients can read the result. */
export const BATTLE_RESULT_LINGER_MS = 3_000;

/** Presence topic a battle publishes its result on, scoped to the zone that spawned it. */
export const battleResultTopic = (zoneRoomId: string) => `battle:resolved:${zoneRoomId}`;

export const PORT = Number(process.env.PORT ?? 2567);
