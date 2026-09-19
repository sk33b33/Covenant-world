# Zone server

Colyseus zone server: one room per zone instance, server-authoritative
movement at 20Hz, capped at 150 players (`ZONE_CAPACITY`).

```bash
npm install          # from the repo root
npm run dev          # watches and restarts — http://localhost:2567
```

Then open http://localhost:2567 in two tabs to see two players share a zone.

## What's here

- `src/config.ts` — world size, walk speed, tick rate, capacity, challenge range.
- `src/rooms/ZoneRoom.ts` — the overworld: state schema, input, simulation, challenges.
- `src/rooms/BattleRoom.ts` — one ephemeral room per battle.
- `src/index.ts` — boots the server and serves the test client.
- `scripts/load-test.mjs` — fills a zone with synthetic clients:
  `node scripts/load-test.mjs 150 15` (150 clients, 15 seconds).

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
client → battle  ready
```

Both players keep their zone connection throughout — the battle room is a
second room on the same connection, which is what makes returning to the
overworld instant.

**The battle itself is a placeholder**: once both players ready up, the winner
is a coin flip (`BattleRoom.pickWinner`). That's the seam where the real TCG
match goes; everything either side of it — challenge, handoff, freeze,
result, return — is real.

Not built yet: interest management, zone sharding, the actual card game, any
connection to the portal. See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
