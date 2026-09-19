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
- **Cross-zone coordination**: Redis holds the live room registry (zone name
  → instance → current player count) so the matchmaker can route new
  entrants, and pub/sub carries anything that isn't zone-local — chat,
  friend presence, a challenge sent to a player in a different instance.
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
all 150 joined in 956ms (6.4ms/client)
still connected: 150/150
patches/sec — min 19.9 · median 19.9 · max 20.0
players in zone: 150
players VISIBLE per client — min 2 · avg 27.7 · max 46
```

Every client held the full 20Hz tick rate with no drops while carrying an
average of 27.7 players instead of all 150 — interest management cuts what
each client is sent by roughly 80%, and that ratio improves as the zone
fills, because the view radius doesn't grow with the population.

So the 100–150 figure is a conservative starting point, not a ceiling we're
pressed against. Re-run this after any change to the simulation, since it's
the number the whole sharding plan is built on.

## Build order

1. ~~Repo structure + this doc~~
2. ~~Minimal Colyseus zone server (one zone, no sharding/AOI yet) + a
   bare-bones client that can join and see other connected players move~~
3. ~~Battle room handoff — proximity challenge, ephemeral battle room,
   result back to the zone. The battle *itself* is a placeholder coin flip;
   the TCG ruleset is a separate piece of work.~~
4. ~~AOI / interest management within a zone.~~
5. Multi-instance sharding + matchmaker + Redis registry.
6. Wire to the portal (see `docs/INTEGRATION.md`).
