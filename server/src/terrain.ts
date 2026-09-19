import type { ZoneDefinition } from "./zones.js";

/**
 * One character per tile. The client picks the artwork, the server only cares
 * whether you can stand there — both read this same table, so a tile that
 * looks solid always is.
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

/**
 * Builds a zone's terrain. Hand-authored maps are what a real game ships;
 * this generates something with the right *shape* — open ground to roam, water
 * and woodland to route around, paths that actually lead to the exits — so
 * collision and rendering can be built and tested before there's a map editor.
 *
 * Deterministic: the same zone always generates the same terrain, so every
 * process in a fleet agrees on what's solid without shipping map data around.
 */
export function buildTileMap(zone: ZoneDefinition): TileMap {
  const { width, height } = zone.tiles;
  const random = seededRandom(hash(zone.id));
  const tiles: TerrainKind[][] = [];

  for (let ty = 0; ty < height; ty++) {
    const row: TerrainKind[] = [];
    for (let tx = 0; tx < width; tx++) row.push(random() < 0.04 ? "flowers" : "grass");
    tiles.push(row);
  }

  // A lake, kept clear of the middle so spawns and paths stay open.
  const lake = {
    x: Math.floor(width * 0.68),
    y: Math.floor(height * 0.24),
    rx: Math.max(3, Math.floor(width * 0.09)),
    ry: Math.max(2, Math.floor(height * 0.09)),
  };
  forEachTile(width, height, (tx, ty) => {
    const dx = (tx - lake.x) / lake.rx;
    const dy = (ty - lake.y) / lake.ry;
    const edge = 1 + (random() - 0.5) * 0.25;
    if (dx * dx + dy * dy < edge) tiles[ty][tx] = "water";
    else if (dx * dx + dy * dy < edge + 0.5) tiles[ty][tx] = "sand";
  });

  // Woodland in two corners, thinning toward the middle.
  for (const corner of [
    { x: 0, y: 0 },
    { x: width - 1, y: height - 1 },
  ]) {
    forEachTile(width, height, (tx, ty) => {
      if (tiles[ty][tx] !== "grass" && tiles[ty][tx] !== "flowers") return;
      const distance = Math.hypot((tx - corner.x) / width, (ty - corner.y) / height);
      if (distance < 0.28 && random() < 0.5 - distance) tiles[ty][tx] = random() < 0.85 ? "tree" : "rock";
    });
  }

  // Paths from the centre to every exit, carved last so they're never blocked.
  const centre = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  for (const edge of Object.keys(zone.exits) as Array<keyof typeof zone.exits>) {
    const target =
      edge === "north" ? { x: centre.x, y: 0 }
      : edge === "south" ? { x: centre.x, y: height - 1 }
      : edge === "west" ? { x: 0, y: centre.y }
      : { x: width - 1, y: centre.y };
    carvePath(tiles, centre, target);
  }

  // Standing room at the centre, where players spawn.
  forEachTile(width, height, (tx, ty) => {
    if (Math.abs(tx - centre.x) <= 5 && Math.abs(ty - centre.y) <= 5) {
      if (!TERRAIN[tiles[ty][tx]].walkable) tiles[ty][tx] = "grass";
    }
  });

  return { width, height, rows: tiles.map((row) => row.map((kind) => TERRAIN[kind].char).join("")) };
}

function carvePath(tiles: TerrainKind[][], from: { x: number; y: number }, to: { x: number; y: number }) {
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

function seededRandom(seed: number) {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}
