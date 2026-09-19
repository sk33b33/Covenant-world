import { TILE_SIZE } from "./config.js";

export type Edge = "north" | "south" | "east" | "west";

export type ZoneDefinition = {
  id: string;
  name: string;
  tiles: { width: number; height: number };
  /** Which zone lies beyond each edge. An edge with no entry here is a wall. */
  exits: Partial<Record<Edge, string>>;
};

/**
 * The world map. Each entry is a *zone*, and a zone may be running as several
 * independent instances at once — see docs/ARCHITECTURE.md. Two players in
 * the same zone but different instances never see each other.
 */
export const ZONES: Record<string, ZoneDefinition> = {
  meadow: {
    id: "meadow",
    name: "Verdant Meadow",
    tiles: { width: 100, height: 75 },
    exits: { east: "hollow" },
  },
  hollow: {
    id: "hollow",
    name: "Shaded Hollow",
    tiles: { width: 80, height: 60 },
    exits: { west: "meadow" },
  },
};

export const STARTING_ZONE = "meadow";

export const OPPOSITE_EDGE: Record<Edge, Edge> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

export function getZone(id: unknown): ZoneDefinition {
  return (typeof id === "string" ? ZONES[id] : undefined) ?? ZONES[STARTING_ZONE];
}

export function zoneSize(zone: ZoneDefinition) {
  return { width: zone.tiles.width * TILE_SIZE, height: zone.tiles.height * TILE_SIZE };
}

/**
 * An arriving client names the edge it walked in through, which decides where
 * it spawns. Only an edge that actually connects somewhere is accepted, so a
 * client can't name an arbitrary one — though since any spot in a zone is
 * reachable on foot anyway, this is tidiness rather than a security boundary.
 */
export function isValidEntry(zone: ZoneDefinition, entry: unknown): entry is Edge {
  return typeof entry === "string" && entry in zone.exits;
}
