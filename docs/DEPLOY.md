# Deploying the zone server

## Why not Vercel (or any serverless host)

A zone server is a long-lived process. It holds the live world in memory —
who is standing on which tile, which instances exist, which battles are
running — and keeps a WebSocket open for each player for the whole session.

Serverless functions are the opposite: they start per request, can't hold
state between invocations, and on Vercel don't support persistent WebSocket
servers at all. Deploying this there fails with `FUNCTION_INVOCATION_FAILED`,
because `gameServer.listen()` isn't a request handler.

The Covenant *portal* is a Next.js app and belongs on Vercel. The world
server needs a container host. They're different shapes of program.

## Fly.io

`Dockerfile` and `fly.toml` in the repo root are set up for this.

```bash
fly launch --no-deploy     # first time: creates the app, keeps our fly.toml
fly deploy
fly open                   # opens the deployed client
```

Notes on the config:

- **`auto_stop_machines = false`.** Fly can sleep idle machines to save money.
  A sleeping zone server drops everyone in it and loses the rooms, so it stays
  up.
- **512MB** is comfortable for one instance at the 150-player cap; the world
  itself is small, the memory goes on connections.
- **WebSockets** need nothing special — Fly's proxy handles them over the
  normal `http_service`.
- Pick a `primary_region` near your players. Round-trip time is felt directly
  when walking, since movement is server-authoritative.

## Environment variables

| Variable | Needed | Purpose |
| --- | --- | --- |
| `PORT` | set in `fly.toml` | Port to listen on. |
| `HOST` | no | Defaults to `0.0.0.0`, which is what containers need. |
| `ZONE_CAPACITY` | no | Players per zone instance (default 150). |
| `REDIS_URL` | only for multiple processes | Shared room registry and presence. |
| `PUBLIC_ADDRESS` | only for multiple processes | How clients reach rooms hosted by *this* process. |

With one machine, leave the last two unset — the registry is in-process and
everything works.

## Scaling past one machine

The code supports it: with `REDIS_URL` set, processes share a room registry,
and a player connecting to any process is routed to the instance they need
wherever it's running. That's verified locally with two processes against one
Redis (see `docs/ARCHITECTURE.md`).

The unsolved part is *addressing* on Fly specifically. Colyseus hands a client
the address of the process hosting its room, via `PUBLIC_ADDRESS`. Fly's proxy
load-balances across machines behind one hostname, so a machine has no public
address of its own to advertise. Options, none of them tried yet:

- Route with Fly's `fly-force-instance-id` header or `fly-replay`, so the
  proxy forwards to the machine that owns the room.
- Give each machine a dedicated IP/hostname and set `PUBLIC_ADDRESS` per
  machine.
- Put the fleet behind a proxy that supports sticky per-room routing.

Until one of those is in place, run a single machine — that's 150 concurrent
players, which is well past what this needs for now.

Add Redis (Upstash works, `fly redis create`) at the same time you go
multi-machine, not before.
