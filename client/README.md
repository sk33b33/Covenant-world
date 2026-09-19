# Test client

A no-build-step browser client for exercising the zone server: canvas
rendering, WASD/arrow movement, a camera that follows you, and other players
drawn from synchronized state.

It's served by the zone server itself — run that (`npm run dev` in
`../server`) and open http://localhost:2567. `?name=Ash` sets a display name.

- `index.html` — page shell and HUD.
- `main.js` — connection, input, interpolation, rendering.

The Colyseus browser SDK is served from `/vendor` straight out of
`node_modules`, so there's nothing to bundle. Positions arrive at the server's
20Hz tick and are smoothed toward each frame, which is why movement looks
continuous at 60fps.
