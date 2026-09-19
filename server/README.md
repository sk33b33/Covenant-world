# Zone server

Colyseus zone server: one room per zone instance, server-authoritative
movement at 20Hz, capped at 150 players (`ZONE_CAPACITY`).

```bash
npm install          # from the repo root
npm run dev          # watches and restarts — http://localhost:2567
```

Then open http://localhost:2567 in two tabs to see two players share a zone.

## Zones, instances and processes

`src/zones.ts` is the world map: each zone has a size and a set of edges that
lead to other zones. A zone may be running as several **instances** at once —
they're ordinary rooms filtered by `zoneId`, so a player asking for "meadow"
joins a meadow instance with space, and the matchmaker opens another when
they're all full. Players in different instances of the same zone never see
each other.

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
- `src/zones.ts` — the zone definitions and how they connect.
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

Clients never send positions — only which direction they're holding
(`input` message). The room stores that intent off-state, integrates it each
tick against the walk speed, and clamps to the world bounds. Positions are
therefore always the server's, which is what makes speed-hacking a
non-issue later.

## Challenges and battles

Stand within two tiles of another player and either of you can challenge the
other. On accept, the zone spawns a `battle` room, reserves a seat for each
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
