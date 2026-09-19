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

export const PORT = Number(process.env.PORT ?? 2567);
