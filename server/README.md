# Zone server

Colyseus zone server: one room per zone instance, server-authoritative
movement at 20Hz, capped at 150 players (`ZONE_CAPACITY`).

```bash
npm install          # from the repo root
npm run dev          # watches and restarts — http://localhost:2567
```

Then open http://localhost:2567 in two tabs to see two players share a zone.

## Zones, instances and processes

`src/zones.ts` is the world map: six zones, one per chapter of The Covenant's
story mode (Genesis through Revelation), connected west to east, each themed
to its chapter's energy type — see `docs/ARCHITECTURE.md` for the table. A
zone may be running as several **instances** at once — they're ordinary rooms
filtered by `zoneId`, so a player asking for "genesis" joins a genesis
instance with space, and the matchmaker opens another when they're all full.
Players in different instances of the same zone never see each other.

Walking into an edge that leads somewhere sends `zone:travel`, and the client
joins an instance of the neighbouring zone, entering from the matching edge.

```bash
npm run dev                                  # one process, local registry

REDIS_URL=redis://127.0.0.1:6379 \
PUBLIC_ADDRESS=localhost:2567 PORT=2567 npm start   # process 1
REDIS_URL=redis://127.0.0.1:6379 \
PUBLIC_ADDRESS=localhost:2568 PORT=2568 npm start   # process 2
```

With `REDIS_URL` the processes share one room registry: a player can connect
to either and be routed to the instance they need, whichever process is
actually hosting it. `PUBLIC_ADDRESS` is how a process tells clients to reach
rooms it hosts. In production something has to spread incoming connections
across the fleet — that part isn't built.

`ZONE_CAPACITY` (default 150) sets the per-instance cap; set it low to watch
sharding happen with a handful of clients.

## What's here

- `src/config.ts` — walk speed, tick rate, capacity, view and challenge range.
- `src/zones.ts` — the six zones (one per story chapter) and how they connect.
- `src/terrain.ts` — one terrain generator per zone, and the collision table.
- `src/rooms/ZoneRoom.ts` — the overworld: state schema, input, simulation, challenges.
- `src/rooms/BattleRoom.ts` — one ephemeral room per battle.
- `src/index.ts` — boots the server and serves the test client.
- `scripts/load-test.mjs` — fills a zone with synthetic clients:
  `node scripts/load-test.mjs 150 15` (150 clients, 15 seconds).

## Interest management

A client is only sent the players within `VIEW_RADIUS` (18 tiles) of it. The
`players` map is `.view()`-tagged, each client gets a `StateView`, and the
room adds and removes entries as players move — recomputed at 5Hz against a
grid of view-radius cells, with a little hysteresis so anyone hovering on the
boundary doesn't flicker in and out.

That means `room.state.players.size` is *what you can see*, not how many are
in the zone; `room.state.population` is the real count. At 150 players a
client typically carries ~28 of them.

## How movement works

Movement is **tile-locked**, like the Pokemon games: a player occupies a tile
and steps to the next one over `STEP_DURATION_MS`, four directions only, no
diagonals. Pressing a direction you aren't facing turns you without moving,
so a tap turns on the spot and a hold walks — `TURN_DELAY_MS` is the window
that separates the two.

Clients never send positions, only which direction they're holding (`input`).
The room keeps that intent off-state and decides where it puts you, so
positions are always the server's — which is what makes speed-hacking a
non-issue later.

Because positions are tiles rather than pixels, a walking player produces one
state update per *step* instead of one per tick, and the client slides between
tiles at a matching pace so it still looks continuous.

One client-side subtlety: a held key is reported as held for at least 90ms.
The server samples input on its own 20Hz tick, so a tap shorter than one tick
would otherwise land and clear between two samples and be lost — and tapping
to turn is exactly what the turn delay exists for.

## Terrain and collision

`src/terrain.ts` generates each zone's tiles deterministically from its id, so
every process in a fleet agrees on what's solid without shipping map data
around. The server reads it to decide whether a step is allowed; the client
fetches the same map from `/zones/:zoneId/terrain.json` to draw it. One table
drives both, so a tile that looks solid always is.

It's generated rather than hand-authored because a real game needs a map
editor and this needed something with the right *shape* per zone — Eden's
river, the wilderness's sand, the royal city's street grid, Galilee's lake —
to build collision and rendering against. One generator function per zone id,
not one generic algorithm reskinned six times: Kings' city and Gospel's lake
are structurally different maps.

Walking off the map edge and walking into a tree are deliberately different:
the first is travel to the neighbouring zone, the second is just a wall.
Every zone connects to its neighbour through a carved path at the middle row
— the ford or street a player is meant to follow to cross whatever the
zone's water or buildings put in the way. Terrain elsewhere isn't guaranteed
walkable in a straight line, same as any game with a river or a building in
it.

## Challenges and battles

Stand next to another player (including diagonally) and either of you can
challenge the other. On accept, the zone spawns a `battle` room, reserves a seat for each
player, and freezes both characters in the overworld; when the battle
publishes its result the zone unfreezes them.

```
client → zone    challenge            { targetSessionId }
client → zone    challenge:respond    { from, accept }
zone   → client  challenge:sent | challenge:received | challenge:declined
                 challenge:expired | challenge:failed
zone   → client  battle:start         { reservation }   ← consume to join the battle
zone   → client  battle:result        { outcome, won }
zone   → client  zone:travel          { zoneId, entry } ← rejoin at the named zone
client → battle  ready
```

Both players keep their zone connection throughout — the battle room is a
second room on the same connection, which is what makes returning to the
overworld instant.

**The battle itself is a placeholder**: once both players ready up, the winner
is a coin flip (`BattleRoom.pickWinner`). That's the seam where the real TCG
match goes; everything either side of it — challenge, handoff, freeze,
result, return — is real.

Not built yet: keeping a party together in one instance, the actual card
game, any connection to the portal. See
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
