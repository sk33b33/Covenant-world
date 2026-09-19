# Covenant World

A roaming, Pokemon-style overworld for Covenant: players walk around a shared
map, run into each other, and challenge one another to a TCG battle.

This is a standalone prototype — it does not yet talk to any other Covenant
service. It runs and is testable entirely on its own. Once the core loop
(walk around, see other players, trigger a battle) is proven out, it gets
wired to the existing portal for real accounts, save data, and match
recording. See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for exactly what
that wiring will look like and why it's deferred.

## Repo layout

```
server/   Realtime zone server (Colyseus) — authoritative movement, presence
client/   Test client for walking around a zone and exercising the server
docs/     Architecture and integration design
```

## Running it

```bash
npm install
npm run dev --workspace @covenant-world/server
```

Open http://localhost:2567 in two tabs and walk around with WASD. Stand next
to the other player and press <kbd>E</kbd> to challenge them into a battle,
or walk off the east edge to cross into the next zone.

## Status

Server-authoritative movement at 20Hz; interest management so each client is
only sent the players near it; the full challenge → battle →
back-to-the-overworld handoff; and zones that shard into as many instances as
the population needs, across as many server processes as you run.

Measured: 150 clients in one instance holding the full tick rate while
carrying ~30 players each rather than all 150, and two processes sharing one
Redis registry distributing players across instances on both.

The battle itself is a placeholder coin flip — the TCG ruleset is separate
work, as is any connection to the portal. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for what's left.

## Related repos

- [`covenant-tcg-portal`](https://github.com/sk33b33/Covenant-TCG-Portal) — the
  web portal: accounts, save data, leaderboards. This is what Covenant World
  will eventually authenticate against and report results to.
