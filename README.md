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
to the other player and press <kbd>E</kbd> to challenge them into a battle.

## Status

One zone with server-authoritative movement at 20Hz, interest management so
each client is only sent the players near it, and the full challenge →
battle → back-to-the-overworld handoff. Verified with 150 simultaneous
clients holding the full tick rate while carrying ~28 players each instead
of all 150.

The battle itself is a placeholder coin flip — the TCG ruleset is separate
work. No zone sharding or portal integration yet; see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for what comes next.

## Related repos

- [`covenant-tcg-portal`](https://github.com/sk33b33/Covenant-TCG-Portal) — the
  web portal: accounts, save data, leaderboards. This is what Covenant World
  will eventually authenticate against and report results to.
