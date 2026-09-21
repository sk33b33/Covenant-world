# Architecture

## Goal

A shared, roaming overworld where players see each other move around in real
time and can challenge one another into a TCG battle — targeting up to ~1000
concurrent players across the whole game, without needing one server process
to track all 1000 of them at once.

## Why zones, not one giant shared map

Broadcasting every player's position to every other player is O(n²) — at
1000 players that's ~1,000,000 position messages per tick, which no single
process handles smoothly. Real games with this shape (including Pokemon's
own multiplayer spinoffs) solve it by capping how many players share one
simulated space and splitting the rest into parallel copies of that space.

**Decision: each zone instance caps at 100–150 concurrent players.** At
1000 total players that's 7–10 zone instances running at once, each cheap
enough for a single process to simulate. A player entering "Genesis" is
matched into whichever Genesis instance has room, and a new instance opens
when the existing ones are full.

Two players in the same zone but different instances never see each other.
That's the trade the design makes: a zone is a *place*, not a single shared
room, and "which copy of the place am I in" is decided at the door. Grouping
friends into the same instance is a known gap — `joinOrCreate` currently
takes whichever instance has space.

## World map

Six zones, one per chapter of The Covenant's card game story mode
(`src/data/story` in the sibling `The-Covenant` repo) — Genesis through
Revelation, in that order, connected west to east so walking the map
retraces the story's arc. Each zone's theme matches its chapter's energy
type, which the card game already defines: Genesis is light, Exodus fire,
Kings earth, Prophets spirit, Gospel water, Revelation shadow.

| Zone | Chapter subtitle | Theme | Setting |
| --- | --- | --- | --- |
| `genesis` | In the beginning | light | Eden — a garden fed by a gentle river |
| `exodus` | Let my people go | fire | the wilderness — sand, one oasis |
| `kings` | A crown and a harp | earth | the royal city — streets and stone |
| `prophets` | A voice in the wilderness | spirit | the highlands — dry, windswept, rocky |
| `gospel` | The Word made flesh | water | Galilee — a great lake, a shoreline |
| `revelation` | Behold, I make all things new | shadow | the new creation — scorched, unquiet |

The card game only has Genesis and Exodus written so far — the other four
chapters are locked with no encounters yet. The overworld doesn't need
encounter data to exist as a *place*, so all six zones are built now; battle
content catches up whenever those chapters do. This is metadata only —
covenant-world does not import anything from The-Covenant's engine (see
`docs/INTEGRATION.md` for why that's deferred).

Terrain generation (`server/src/terrain.ts`) is per-zone: one generator
function per zone id, sharing a small toolkit (`sprinkle`, `patch`, `river`)
rather than one generic algorithm parameterized to look different — Kings'
street grid and Gospel's lake are structurally different maps, not the same
map recolored. The *mechanical* tile kinds stay universal (grass, path, sand,
flowers, tree, rock, water — see `TERRAIN` in `terrain.ts`); a zone's theme
only changes how densely they're used and what the client draws them as
(`tree` is an oak in Genesis, a palm in Exodus, a bare blackened trunk in
Revelation; `rock` is a boulder, a building in Kings, a crag in Prophets, glowing rubble in Revelation).

Every zone connects to its neighbour via a carved path through the middle
row — the ford, bridge, or street a player is meant to follow to cross
whatever the zone's centerpiece obstacle is (a river, a lake). Terrain
elsewhere isn't guaranteed crossable in a straight line, same as any
top-down game with water or buildings in it; the path is the reliable route,
not the only one.

## Components

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────────────┐
│   Client     │◄────►│   Zone server     │◄────►│  Redis                │
│ (walk, see   │  WS  │  (Colyseus room,  │      │  - room registry       │
│  others,     │      │   one per zone     │      │    (which instance has│
│  challenge)  │      │   instance)        │      │     room)              │
└─────────────┘      └──────────────────┘      │  - pub/sub for cross-  │
                              │                    │    zone events (chat,  │
                              │ on challenge       │    invites)            │
                              ▼                    └─────────────────────┘
                      ┌──────────────────┐
                      │  Battle room       │  ephemeral Colyseus room,
                      │  (TCG match)       │  spun up per challenge,
                      └──────────────────┘  torn down after the match
```

- **Transport**: [Colyseus](https://colyseus.io) (Node, WebSocket). Rooms map
  1:1 to zone instances; Colyseus gives schema-based state diffing for free,
  so we're not hand-rolling delta compression.
- **Authority**: server-authoritative, tile-locked movement. A player occupies
  a tile and steps to the next over a fixed duration, four directions only —
  the Pokemon model. The client sends intent (which direction is held), the
  server decides where that puts you at a 20Hz tick.

  Tiles rather than pixels means a walking player emits one update per *step*
  rather than one per tick, and the client slides between tiles at a matching
  pace. It also makes collision exact: a tile is walkable or it isn't, with no
  partial overlaps to resolve.

- **Terrain**: generated deterministically per zone from its id, so every
  process agrees on what's solid without distributing map data. Server and
  client read the same table — the server to allow or refuse a step, the
  client to draw it.
- **Interest management (AOI)**: within a zone, a player's client only
  receives state for players within `VIEW_RADIUS` of it, not the whole zone's
  100–150. This is what keeps per-client bandwidth flat as a zone fills up —
  sharding alone isn't enough.

  Built on Colyseus `StateView`: the `players` map is `.view()`-tagged, so
  nothing in it reaches a client until that client's view holds it, and the
  room adds/removes entries as players move. Three things make it cheap:

  - **A spatial grid.** Comparing every player to every other is O(n²) —
    22,500 distance checks per pass at 150 players. Players are bucketed into
    cells the size of the view radius, and each client only examines the nine
    cells around it.
  - **Hysteresis.** Players leave the view slightly further out than they
    enter it. Without the gap, someone loitering on the boundary would be
    added and removed repeatedly, and every re-add re-sends the whole entity.
  - **5Hz, not 20Hz.** At walking pace a player crosses a small fraction of
    the view radius between passes, so recomputing every fourth tick costs a
    quarter of the work with no perceptible pop-in.

  The zone's real population no longer equals what a client can see, so
  `ZoneState.population` carries it as an untagged field.
- **Sharding**: zone instances are ordinary Colyseus rooms filtered by
  `zoneId` (`gameServer.define("zone", ZoneRoom).filterBy(["zoneId"])`). A
  request for a zone only matches instances of *that* zone, and the
  matchmaker opens another instance when they're all full. Nothing else is
  needed to split one zone into many.

- **Cross-zone coordination**: with `REDIS_URL` set, Redis holds the room
  registry and carries presence pub/sub, so several server processes share
  one world: a player can connect to any process and be routed to the
  instance they need, wherever it's actually running. Without it everything
  runs locally, which is what `npm run dev` does. The same pub/sub carries
  anything that isn't room-local — today that's battle results; later chat
  and friend presence.

- **Travel between zones**: walking into an edge that leads somewhere makes
  the server send `zone:travel`, and the client leaves its current room and
  joins an instance of the destination, entering from the matching edge. So
  crossing a zone boundary and being moved to a different instance are the
  same mechanism.
- **Battles**: a proximity challenge between two players spawns a separate,
  ephemeral "battle room" — ordinary turn-based TCG logic, no realtime
  movement concerns — while both players' overworld characters stay frozen in
  the zone until it resolves. The battle reports its outcome back over
  presence rather than by return value, because the zone and the battle are
  already separate rooms and will eventually be separate processes; the same
  channel carries cross-zone events once sharding lands.

  The zone freezes a player for the whole battle, so it has to hear an outcome
  on *every* exit path — a finished match, a forfeit, a battle nobody joined.
  A battle that ends without publishing would strand both players frozen in
  the overworld forever, which is why `BattleRoom.onDispose` publishes an
  `abandoned` result as a backstop.

## Persistence boundary

Position and movement are pure in-memory, per-zone-server state — never
written to a database on every tick, only ever relayed to nearby clients.
The only things that get persisted are checkpoints (last zone + position on
disconnect, inventory changes, battle results), and only via the existing
portal API — see `docs/INTEGRATION.md`. This prototype doesn't persist
anything yet; positions live and die with the server process.

## Hosting

Zone servers are long-lived processes holding live in-memory room state —
they need a host with persistent processes and sticky WebSocket sessions
(Fly.io, Railway, a small VM/ECS fleet), not a serverless platform. Which
host isn't decided yet.

Running more than one process needs three things, all already wired:
`REDIS_URL` so they share a registry, `PUBLIC_ADDRESS` per process so a
process can tell clients how to reach rooms it hosts, and something in front
of the fleet to spread incoming connections. Verified locally with two
processes against one Redis: 20 players connecting through a single process
were distributed across instances running on *both*, with clients
transparently redirected to whichever process hosts their instance.

## Anti-cheat baseline (later, not in the prototype)

- Server rejects a movement input that would exceed max speed or cross a
  collision boundary — never trust a client-reported position outright.
- Rate-limit challenge/action messages per player.

## Capacity, measured

`server/scripts/load-test.mjs` fills a single zone instance with synthetic
walking clients. At the 150-player cap in Genesis (90×68 tiles), on one
local dev process sharing this machine with other work:

```
all 150 joined in 654ms (4.4ms/client)
still connected: 150/150
patches/sec — min 17.8 · median 18.0 · max 18.1
players in zone: 150
players VISIBLE per client — min 6 · avg 31.5 · max 54
```

All 150 stayed connected with no drops, but the tick rate settled around
18Hz rather than the full 20 — a real, if modest, cost of Genesis being a
smaller zone (6,120 tiles) than the one this was first measured against
(7,500), so the same population packs denser: 31.5 average visible per
client instead of 27.7, more encode work per tick. Interest management is
still doing its job — every client carries a fifth of the zone, not all of
it — the number just moves with zone size and shape, not only player count.
Re-measure after any change to zone sizes or the simulation, since it's the
number the whole sharding plan is built on, and don't read a single
manual run's Hz to the decimal on a shared machine.

## Build order

1. ~~Repo structure + this doc~~
2. ~~Minimal Colyseus zone server (one zone, no sharding/AOI yet) + a
   bare-bones client that can join and see other connected players move~~
3. ~~Battle room handoff — proximity challenge, ephemeral battle room,
   result back to the zone. The battle *itself* is a placeholder coin flip;
   the TCG ruleset is a separate piece of work.~~
4. ~~AOI / interest management within a zone.~~
5. ~~Multi-instance sharding + matchmaker + Redis registry, and travel
   between zones.~~
6. Wire to the portal (see `docs/INTEGRATION.md`).

7. ~~A biblical-themed six-zone map, one per chapter of The Covenant's story
   mode, each with its own generated terrain, palette and decoration set.~~

Still open, roughly in order of how soon they'll bite: keeping a party in the
same instance, the real TCG ruleset, persistence, and a load balancer in front
of the process fleet.
