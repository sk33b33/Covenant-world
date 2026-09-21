import type { ZoneDefinition } from "./zones.js";

/**
 * One character per tile. The client picks the artwork, the server only cares
 * whether you can stand there — both read this same table, so a tile that
 * looks solid always is.
 *
 * The kind set is deliberately small and theme-neutral: "tree" is a palm in
 * the desert and a scorched trunk in Revelation, "rock" is a boulder in the
 * highlands and a building in Kings. Collision only ever asks "walkable or
 * not" — which biome a kind belongs to is the client's decision to make when
 * it draws it, not the server's.
 */
export const TERRAIN = {
  grass: { char: ".", walkable: true },
  path: { char: "-", walkable: true },
  sand: { char: ",", walkable: true },
  flowers: { char: "*", walkable: true },
  tree: { char: "T", walkable: false },
  rock: { char: "O", walkable: false },
  water: { char: "~", walkable: false },
} as const;

export type TerrainKind = keyof typeof TERRAIN;

const BY_CHAR = new Map<string, TerrainKind>(
  (Object.keys(TERRAIN) as TerrainKind[]).map((kind) => [TERRAIN[kind].char, kind]),
);

export type TileMap = {
  width: number;
  height: number;
  /** Row-major, one character per tile — see TERRAIN. */
  rows: string[];
};

export function terrainAt(map: TileMap, tx: number, ty: number): TerrainKind {
  const char = map.rows[ty]?.[tx];
  return (char && BY_CHAR.get(char)) || "grass";
}

export function isWalkableTile(map: TileMap, tx: number, ty: number) {
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
  return TERRAIN[terrainAt(map, tx, ty)].walkable;
}

type Grid = TerrainKind[][];
type Random = () => number;

/**
 * Builds a zone's terrain. Hand-authored maps are what a real game ships;
 * this generates something with the right *shape* for each chapter's setting
 * — Eden's rivers, the wilderness's sand, the walled city's streets — so
 * collision and rendering can be built and tested before there's a map
 * editor. One generator per zone id, sharing a small toolkit below.
 *
 * Deterministic: the same zone always generates the same terrain, so every
 * process in a fleet agrees on what's solid without shipping map data around.
 */
export function buildTileMap(zone: ZoneDefinition): TileMap {
  const { width, height } = zone.tiles;
  const random = seededRandom(hash(zone.id));
  const generator = BIOMES[zone.id] ?? BIOMES.genesis;
  const tiles = generator(zone, random);

  carveExitPaths(tiles, zone);
  clearSpawnArea(tiles, zone);

  return { width, height, rows: tiles.map((row) => row.map((kind) => TERRAIN[kind].char).join("")) };
}

/* ------------------------------------------------------------- biomes */

const BIOMES: Record<string, (zone: ZoneDefinition, random: Random) => Grid> = {
  genesis: genesisBiome,
  exodus: exodusBiome,
  kings: kingsBiome,
  prophets: prophetsBiome,
  gospel: gospelBiome,
  revelation: revelationBiome,
};

/** Eden: a garden fed by a river, woodland only at the far edges. */
function genesisBiome(zone: ZoneDefinition, random: Random): Grid {
  const { width, height } = zone.tiles;
  const tiles = emptyGrid(width, height, "grass");

  sprinkle(tiles, width, height, random, { kind: "flowers", chance: 0.09 });
  river(tiles, width, height, random, { fringe: "sand", halfWidth: 2 });

  for (const corner of [{ x: 0, y: 0 }, { x: width - 1, y: height - 1 }]) {
    forEachTile(width, height, (tx, ty) => {
      if (tiles[ty][tx] !== "grass" && tiles[ty][tx] !== "flowers") return;
      const distance = Math.hypot((tx - corner.x) / width, (ty - corner.y) / height);
      if (distance < 0.22 && random() < 0.4 - distance) tiles[ty][tx] = random() < 0.92 ? "tree" : "rock";
    });
  }

  return tiles;
}

/** The wilderness: sand to the horizon, one oasis, wind-worn stone. */
function exodusBiome(zone: ZoneDefinition, random: Random): Grid {
  const { width, height } = zone.tiles;
  const tiles = emptyGrid(width, height, "sand");

  sprinkle(tiles, width, height, random, { kind: "rock", chance: 0.015 });
  sprinkle(tiles, width, height, random, { kind: "grass", chance: 0.02 });

  const oasis = { cx: width * (0.25 + random() * 0.2), cy: height * (0.6 + random() * 0.2) };
  patch(tiles, width, height, random, { ...oasis, rx: 3, ry: 2.4, kind: "water", fringe: "grass" });
  forEachTile(width, height, (tx, ty) => {
    const distance = Math.hypot(tx - oasis.cx, ty - oasis.cy);
    if (distance > 3 && distance < 6 && random() < 0.3) tiles[ty][tx] = "tree";
  });

  return tiles;
}

/** The royal city: a street grid of building blocks around open plazas. */
function kingsBiome(zone: ZoneDefinition, random: Random): Grid {
  const { width, height } = zone.tiles;
  const tiles = emptyGrid(width, height, "path");
  const block = 9;

  for (let by = block; by < height - block; by += block) {
    for (let bx = block; bx < width - block; bx += block) {
      if (random() < 0.72) {
        const w = 3 + Math.floor(random() * 3);
        const h = 3 + Math.floor(random() * 3);
        const ox = bx + Math.floor((block - w) / 2 + (random() - 0.5) * 2);
        const oy = by + Math.floor((block - h) / 2 + (random() - 0.5) * 2);
        for (let ty = oy; ty < oy + h; ty++) {
          for (let tx = ox; tx < ox + w; tx++) if (tiles[ty]?.[tx] !== undefined) tiles[ty][tx] = "rock";
        }
      } else {
        for (let ty = by; ty < by + block - 2; ty++) {
          for (let tx = bx; tx < bx + block - 2; tx++) {
            if (tiles[ty]?.[tx] !== undefined && random() < 0.5) tiles[ty][tx] = "grass";
          }
        }
      }
    }
  }

  return tiles;
}

/** The highlands: dry, rocky, windswept, with a single brook. */
function prophetsBiome(zone: ZoneDefinition, random: Random): Grid {
  const { width, height } = zone.tiles;
  const tiles = emptyGrid(width, height, "grass");

  sprinkle(tiles, width, height, random, { kind: "flowers", chance: 0.015 });
  sprinkle(tiles, width, height, random, { kind: "sand", chance: 0.03 });
  sprinkle(tiles, width, height, random, { kind: "rock", chance: 0.09 });
  sprinkle(tiles, width, height, random, { kind: "tree", chance: 0.01 });
  river(tiles, width, height, random, { fringe: "sand", halfWidth: 1 });

  return tiles;
}

/** Galilee: a great lake filling one side of the map, reeds at its shore. */
function gospelBiome(zone: ZoneDefinition, random: Random): Grid {
  const { width, height } = zone.tiles;
  const tiles = emptyGrid(width, height, "grass");

  sprinkle(tiles, width, height, random, { kind: "flowers", chance: 0.05 });

  // Which side the lake sits on is random, but it always leaves clear ground
  // at BOTH the west and east edges — otherwise it's a coin flip whether a
  // player arrives to open shore or drops straight into open water.
  const east = random() < 0.5;
  const rx = width * 0.16;
  patch(tiles, width, height, random, {
    cx: east ? width - rx * 1.6 : rx * 1.6,
    cy: height * 0.5,
    rx,
    ry: height * 0.42,
    kind: "water",
    fringe: "flowers",
    jitter: 0.3,
  });

  return tiles;
}

/** The new creation: scorched ground, dark pools, ruin rather than one wound. */
function revelationBiome(zone: ZoneDefinition, random: Random): Grid {
  const { width, height } = zone.tiles;
  const tiles = emptyGrid(width, height, "grass");

  sprinkle(tiles, width, height, random, { kind: "rock", chance: 0.07 });
  sprinkle(tiles, width, height, random, { kind: "tree", chance: 0.015 });

  for (let i = 0; i < 4; i++) {
    patch(tiles, width, height, random, {
      cx: width * (0.15 + random() * 0.7),
      cy: height * (0.15 + random() * 0.7),
      rx: 2 + random() * 2,
      ry: 2 + random() * 2,
      kind: "water",
    });
  }

  return tiles;
}

/* ------------------------------------------------------------- generation toolkit */

function emptyGrid(width: number, height: number, fill: TerrainKind): Grid {
  return Array.from({ length: height }, () => Array<TerrainKind>(width).fill(fill));
}

/** Replaces tiles with `kind` at random, optionally only where `onto` currently holds. */
function sprinkle(
  tiles: Grid,
  width: number,
  height: number,
  random: Random,
  opts: { kind: TerrainKind; chance: number; onto?: TerrainKind[] },
) {
  forEachTile(width, height, (tx, ty) => {
    if (opts.onto && !opts.onto.includes(tiles[ty][tx])) return;
    if (random() < opts.chance) tiles[ty][tx] = opts.kind;
  });
}

/** A soft-edged elliptical region — a lake, an oasis pool, a scorched crater. */
function patch(
  tiles: Grid,
  width: number,
  height: number,
  random: Random,
  opts: { cx: number; cy: number; rx: number; ry: number; kind: TerrainKind; fringe?: TerrainKind; jitter?: number },
) {
  const jitter = opts.jitter ?? 0.25;
  forEachTile(width, height, (tx, ty) => {
    const dx = (tx - opts.cx) / opts.rx;
    const dy = (ty - opts.cy) / opts.ry;
    const edge = 1 + (random() - 0.5) * jitter;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < edge) tiles[ty][tx] = opts.kind;
    else if (opts.fringe && distanceSq < edge + 0.5) tiles[ty][tx] = opts.fringe;
  });
}

/** A wandering line of water from top to bottom of the zone. */
function river(
  tiles: Grid,
  width: number,
  height: number,
  random: Random,
  opts: { fringe?: TerrainKind; halfWidth?: number },
) {
  const halfWidth = opts.halfWidth ?? 1;
  // A gentle meander, not a long diagonal slash — wide enough to feel alive,
  // tight enough that following either bank finds a crossing quickly.
  const amplitude = width * 0.05;
  const baseX = width * (0.3 + random() * 0.4);
  const wobbleSeed = random() * 10;

  for (let ty = 0; ty < height; ty++) {
    const x = Math.round(baseX + Math.sin(ty * 0.05 + wobbleSeed) * amplitude);
    for (let dx = -halfWidth; dx <= halfWidth; dx++) {
      if (tiles[ty]?.[x + dx] !== undefined) tiles[ty][x + dx] = "water";
    }
    if (opts.fringe) {
      for (const fx of [x - halfWidth - 1, x + halfWidth + 1]) {
        if (tiles[ty]?.[fx] !== undefined && tiles[ty][fx] !== "water") tiles[ty][fx] = opts.fringe;
      }
    }
  }
}

/** Paths from the centre to every exit, carved last so they're never blocked. */
function carveExitPaths(tiles: Grid, zone: ZoneDefinition) {
  const { width, height } = zone.tiles;
  const centre = { x: Math.floor(width / 2), y: Math.floor(height / 2) };

  for (const edge of Object.keys(zone.exits) as Array<keyof typeof zone.exits>) {
    const target =
      edge === "north" ? { x: centre.x, y: 0 }
      : edge === "south" ? { x: centre.x, y: height - 1 }
      : edge === "west" ? { x: 0, y: centre.y }
      : { x: width - 1, y: centre.y };
    carvePath(tiles, centre, target);
  }
}

function carvePath(tiles: Grid, from: { x: number; y: number }, to: { x: number; y: number }) {
  let { x, y } = from;
  const put = (px: number, py: number) => {
    if (tiles[py]?.[px] !== undefined) tiles[py][px] = "path";
  };

  while (x !== to.x || y !== to.y) {
    put(x, y);
    put(x, y + 1);
    if (x !== to.x) x += Math.sign(to.x - x);
    else y += Math.sign(to.y - y);
  }
  put(to.x, to.y);
  put(to.x, to.y + 1);
}

/** Standing room at the centre, where players spawn. */
function clearSpawnArea(tiles: Grid, zone: ZoneDefinition) {
  const { width, height } = zone.tiles;
  const centre = { x: Math.floor(width / 2), y: Math.floor(height / 2) };

  forEachTile(width, height, (tx, ty) => {
    if (Math.abs(tx - centre.x) <= 5 && Math.abs(ty - centre.y) <= 5) {
      if (!TERRAIN[tiles[ty][tx]].walkable) tiles[ty][tx] = "grass";
    }
  });
}

function forEachTile(width: number, height: number, visit: (tx: number, ty: number) => void) {
  for (let ty = 0; ty < height; ty++) for (let tx = 0; tx < width; tx++) visit(tx, ty);
}

function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function seededRandom(seed: number): Random {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}
