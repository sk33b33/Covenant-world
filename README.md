# Covenant World

A roaming, Pokemon-style overworld for Covenant: players walk around a shared
map, run into each other, and challenge one another to a TCG battle.

This is a standalone prototype — it does not yet talk to any other Covenant
service. It runs and is testable entirely on its own. Once the core loop
(walk around, see other players, trigger a battle) is proven out, it gets
wired to the existing portal for real accounts, save data, and match
recording. See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for exactly what
that wiring will look like and why it's deferred.

## Deploying

The zone server holds the live world in memory and keeps a WebSocket open per
player, so it needs a container host — not a serverless one. `Dockerfile` and
`fly.toml` are set up for Fly.io; see [`docs/DEPLOY.md`](docs/DEPLOY.md),
which also explains why Vercel can't run it.

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
or walk east to cross into the next zone. Add `?zone=kings` to a URL to start
somewhere other than the beginning.

## World

Six zones, one per chapter of [The Covenant](https://github.com/sk33b33/The-Covenant)'s
card game story mode, Genesis through Revelation, connected in that order —
so walking the map retraces the story. Each chapter already has an energy
type in the card game (light, fire, earth, spirit, water, shadow); that theme
drives the zone's generated terrain and the client's palette:

**Genesis** — Eden, a garden fed by a river · **Exodus** — the wilderness,
sand and one oasis · **Kings** — the royal city, streets and stone ·
**Prophets** — the highlands, dry and windswept · **Gospel** — Galilee, a
great lake · **Revelation** — the new creation, scorched and unquiet.

The card game only has Genesis and Exodus written yet; the overworld doesn't
need encounter data to exist as a place, so all six zones are built. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how terrain generation
works per zone.

## Status

Tile-locked movement across terrain you have to walk around; interest
management so each client is only sent the players near it; the full
challenge → battle → back-to-the-overworld handoff; and zones that shard into
as many instances as the population needs, across as many server processes as
you run.

The look is drawn in canvas code rather than made from art assets — it reads
as a game rather than a debug view, but real polish needs a sprite sheet.

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
