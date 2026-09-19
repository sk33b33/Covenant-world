# Integration with the portal (deferred)

This prototype is intentionally standalone — no login, no persistence, no
connection to `covenant-tcg-portal` yet. This document exists so that when
integration does happen, it's a small wiring step against an API that
already exists, not a redesign.

## What the portal already exposes

`covenant-tcg-portal`'s `docs/GAME_INTEGRATION.md` documents an API the
existing game client (thecovenant.game) already uses. Covenant World reuses
the same three routes rather than inventing its own:

```
POST /api/game/auth/login    { email, password } → { token, expiresAt, user }
POST /api/game/auth/logout   Authorization: Bearer <token>
GET  /api/game/save          Authorization: Bearer <token> → { state }
POST /api/game/save          Authorization: Bearer <token>, { patch }
POST /api/game/matches       Authorization: Bearer <GAME_SERVER_API_KEY>, { seasonSlug, winnerGamePlayerId, loserGamePlayerId, playedAt }
```

## How each maps to a Covenant World concept

- **Zone server WS handshake auth**: client logs in against
  `/api/game/auth/login` first (same as any other portal login), then
  presents that bearer token when opening the WebSocket connection to a
  zone server. The zone server doesn't re-implement auth — it just
  validates the token the same way the portal's own `/api/game/*` routes do.
- **Checkpointing overworld state**: `GameSave.state` is opaque JSON from
  the portal's point of view, and writes merge rather than overwrite — a
  good fit for periodically patching `{ lastZone, x, y, inventory }` without
  a new schema. Not called every tick — only on disconnect / periodic
  checkpoint, since this is a cold path, not the realtime movement path.
- **Battle results**: when a proximity challenge resolves in a battle room,
  the zone server (or a small backend service alongside it) reports the
  outcome to `/api/game/matches` exactly like any other TCG match, reusing
  the existing leaderboard math.

## What's deliberately not decided yet

- Whether Covenant World needs any of its *own* database tables on the
  portal side (e.g. zone population for a "players online" stat). Nothing
  in the current plan requires this — skip it until there's a real need.
- Per-instance API keys for multiple zone-server processes vs. the portal's
  current single shared `GAME_SERVER_API_KEY` — the portal's own docs flag
  this as a future concern once there's more than one trusted backend
  calling in. Not a blocker for the prototype.

## Why this is deferred rather than built now

Wiring real auth and persistence into an unproven prototype means every
iteration on movement/zones/AOI also has to keep a login flow and database
working. Building those seams later against a stable, already-documented
API is cheap; the expensive part (does the zone/AOI model actually feel
good and scale) is the part that needs the fast iteration loop now.
