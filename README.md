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

## Status

Repo structure only — no server or client code yet. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the plan; next step is a
minimal Colyseus zone server plus a bare-bones test client.

## Related repos

- [`covenant-tcg-portal`](https://github.com/sk33b33/Covenant-TCG-Portal) — the
  web portal: accounts, save data, leaderboards. This is what Covenant World
  will eventually authenticate against and report results to.
