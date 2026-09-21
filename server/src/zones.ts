export type Edge = "north" | "south" | "east" | "west";

/**
 * The Covenant's six energy types — also its six story chapters (see
 * `src/data/story` in the sibling `The-Covenant` repo). One zone per
 * chapter, themed to match.
 */
export type ZoneTheme = "light" | "fire" | "earth" | "spirit" | "water" | "shadow";

export type ZoneDefinition = {
  id: string;
  name: string;
  /** The chapter's own subtitle, carried over rather than invented fresh. */
  subtitle: string;
  theme: ZoneTheme;
  tiles: { width: number; height: number };
  /** Which zone lies beyond each edge. An edge with no entry here is a wall. */
  exits: Partial<Record<Edge, string>>;
};

/**
 * The world map: one zone per chapter of The Covenant's story mode, in the
 * same order — Genesis through Revelation — connected west to east, so
 * walking the map retraces the story's arc. A zone's theme matches its
 * chapter's energy type; that theme drives both terrain generation
 * (`terrain.ts`) and the client's palette and decoration choices.
 *
 * The card game itself only has Genesis and Exodus written so far — Kings
 * onward are locked chapters with no encounters yet. The overworld doesn't
 * need encounter data to exist as a place, so all six are built now; battle
 * content in the later zones catches up whenever those chapters do.
 *
 * A zone may be running as several independent instances at once — see
 * docs/ARCHITECTURE.md. Two players in the same zone but different
 * instances never see each other.
 */
export const ZONES: Record<string, ZoneDefinition> = {
  genesis: {
    id: "genesis",
    name: "Genesis",
    subtitle: "In the beginning",
    theme: "light",
    tiles: { width: 90, height: 68 },
    exits: { east: "exodus" },
  },
  exodus: {
    id: "exodus",
    name: "Exodus",
    subtitle: "Let my people go",
    theme: "fire",
    tiles: { width: 100, height: 68 },
    exits: { west: "genesis", east: "kings" },
  },
  kings: {
    id: "kings",
    name: "Kings",
    subtitle: "A crown and a harp",
    theme: "earth",
    tiles: { width: 76, height: 60 },
    exits: { west: "exodus", east: "prophets" },
  },
  prophets: {
    id: "prophets",
    name: "Prophets",
    subtitle: "A voice in the wilderness",
    theme: "spirit",
    tiles: { width: 88, height: 66 },
    exits: { west: "kings", east: "gospel" },
  },
  gospel: {
    id: "gospel",
    name: "Gospel",
    subtitle: "The Word made flesh",
    theme: "water",
    tiles: { width: 92, height: 70 },
    exits: { west: "prophets", east: "revelation" },
  },
  revelation: {
    id: "revelation",
    name: "Revelation",
    subtitle: "Behold, I make all things new",
    theme: "shadow",
    tiles: { width: 84, height: 64 },
    exits: { west: "gospel" },
  },
};

export const STARTING_ZONE = "genesis";

export const OPPOSITE_EDGE: Record<Edge, Edge> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

export function getZone(id: unknown): ZoneDefinition {
  return (typeof id === "string" ? ZONES[id] : undefined) ?? ZONES[STARTING_ZONE];
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
