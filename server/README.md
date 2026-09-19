# Zone server

Colyseus zone server: one room per zone instance, server-authoritative
movement at 20Hz, capped at 150 players (`ZONE_CAPACITY`).

```bash
npm install          # from the repo root
npm run dev          # watches and restarts — http://localhost:2567
```

Then open http://localhost:2567 in two tabs to see two players share a zone.

## What's here

- `src/config.ts` — world size, walk speed, tick rate, capacity.
- `src/rooms/ZoneRoom.ts` — the room: state schema, input handling, simulation.
- `src/index.ts` — boots the server and serves the test client.
- `scripts/load-test.mjs` — fills a zone with synthetic clients:
  `node scripts/load-test.mjs 150 15` (150 clients, 15 seconds).

## How movement works

Clients never send positions — only which direction they're holding
(`input` message). The room stores that intent off-state, integrates it each
tick against the walk speed, and clamps to the world bounds. Positions are
therefore always the server's, which is what makes speed-hacking a
non-issue later.

Not built yet: interest management, zone sharding, battles, any connection to
the portal. See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
