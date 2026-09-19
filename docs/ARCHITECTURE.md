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
enough for a single process to simulate. A matchmaker/lobby assigns a
player entering "Route 1" to whichever `route-1` instance has room
(`route-1-a`, `route-1-b`, ...), spinning up a new instance when all
existing ones are full.

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
- **Authority**: server-authoritative movement. Client sends inputs
  (direction/intent), server simulates and is the source of truth, at a
  ~15–20Hz tick. Client-side prediction + reconciliation keeps movement
  feeling instant despite the round trip.
- **Interest management (AOI)**: within a zone, a player's client only
  receives state for entities within a radius of their position (spatial
  grid), not the whole zone's 100–150 players. This is what keeps per-tick
  bandwidth flat as a zone fills up — sharding alone isn't enough.
- **Cross-zone coordination**: Redis holds the live room registry (zone name
  → instance → current player count) so the matchmaker can route new
  entrants, and pub/sub carries anything that isn't zone-local — chat,
  friend presence, a challenge sent to a player in a different instance.
- **Battles**: a proximity challenge between two players spawns a separate,
  ephemeral "battle room" — ordinary turn-based TCG logic, no realtime
  movement concerns — and both players' overworld characters just wait/emote
  in the zone until it resolves.

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
(Fly.io, Railway, a small VM/ECS fleet), not a serverless platform. Not
decided yet for this prototype; running locally is enough for now.

## Anti-cheat baseline (later, not in the prototype)

- Server rejects a movement input that would exceed max speed or cross a
  collision boundary — never trust a client-reported position outright.
- Rate-limit challenge/action messages per player.

## Capacity, measured

`server/scripts/load-test.mjs` fills a single zone instance with synthetic
walking clients. At the 150-player cap, on one local dev process:

```
all 150 joined in 638ms (4.3ms/client)
still connected: 150/150
patches/sec — min 19.9 · median 19.9 · max 20.0
```

Every client held the full 20Hz tick rate with no drops, and that's *before*
interest management — so the 100–150 figure is a conservative starting point,
not a ceiling we're pressed against. Re-run this after any change to the
simulation, since it's the number the whole sharding plan is built on.

## Build order

1. ~~Repo structure + this doc~~
2. ~~Minimal Colyseus zone server (one zone, no sharding/AOI yet) + a
   bare-bones client that can join and see other connected players move~~
3. AOI / interest management within a zone.
4. Multi-instance sharding + matchmaker + Redis registry.
5. Battle room handoff.
6. Wire to the portal (see `docs/INTEGRATION.md`).
