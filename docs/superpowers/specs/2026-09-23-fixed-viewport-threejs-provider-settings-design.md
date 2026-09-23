# Fixed Viewport Three.js Game and Provider Settings Design

## Goal

Redesign the existing space-shooter demo as a no-scroll 600×800 game panel with a richer Three.js 2.5D presentation, and let the user choose a JEV-compatible provider base URL and model for each new run.

## Current context

- `demo/space-shooter.html` is a self-contained static page with an inline deterministic simulation, a separate djev controller, a Canvas 2D renderer, and a wide dashboard layout.
- `demo/space_shooter_server.py` serves the page and implements the run/decision/event REST API. The upstream endpoint and model currently come from `DJEV_URL` and `DJEV_MODEL` process/environment configuration.
- The Python bridge validates the game protocol and normalizes the provider's three structured choices. It currently appends `/v1/systemone` to the configured base URL and keeps the upstream API key server-side.
- Run manifests and JSONL traces already capture model identity and request/response evidence.

## User-approved direction

- Keep the game's primary experience in a portrait, 600×800 box, with the arena, HUD, and compact decision/dashboard indicators visible together without page scrolling.
- Use Three.js for a polished 2.5D presentation: depth, distinct projectile types, missiles, and explosion effects.
- Add a settings dialog containing Provider URL and Model name. Settings apply to a newly started/restarted run; the API key remains server-side.
- Preserve the existing dark navy visual direction and the already reviewed gameplay/settings concepts. Concept-image text and metrics are illustrative only; UI values must be live values from the running game/API.

## Architecture

### Rendering and simulation boundary

Keep `SpaceDecisionCore` as the source of truth for deterministic simulation state, movement, collisions, scoring, difficulty, and protocol snapshots. Replace only the presentation layer in the page's final inline application script with a Three.js renderer. Render the player, enemy classes, bullet/projectile classes, missiles, background depth, and transient impact/explosion effects as scene objects. Rendering must consume game state and must not feed visual randomness, animation timing, or interpolated positions back into simulation, collision, telemetry, or benchmark decisions.

The gameplay panel has a fixed 600×800 CSS-pixel design size. It contains a compact top HUD, the arena, and a bottom command/status dashboard (including API state, latency, valid decisions, and applied decisions). On smaller browser windows the panel scales down proportionally to fit the available viewport; it does not reflow into a scrollable column. On larger windows it remains centered at its design size. Detailed existing diagnostics remain reachable in a secondary expandable diagnostics surface rather than displacing the game from the primary panel.

### Provider/model selection and request flow

The settings dialog has editable `Provider URL` and `Model name` values, plus Apply & restart run and Cancel. Provider URL is a base URL; the bridge appends `/v1/systemone`. The browser sends the selected URL/model only to this demo's same-origin `/api/run/start`. It never receives or submits the upstream API key. Restart uses the saved settings and creates a fresh run; changing either value during an active run does not silently retarget in-flight requests.

Extend the run-start request with optional provider configuration. Missing values resolve to `DJEV_URL` / `DJEV_MODEL`, preserving CLI and existing clients. Validate the URL as an absolute HTTP(S) URL without embedded credentials, query, or fragment; normalize a trailing slash and reject a URL that would duplicate the required API path. Validate model as a non-empty bounded string. Capture the effective URL (sanitized) and model in the immutable run configuration and run manifest. Store those values on the `RunState`; all decisions for that run use the captured values, not mutable process environment. Existing schema/choice validation and response normalization remain in force. The API key continues to be read only by the bridge from server environment configuration.

### Effects and performance

Use Three.js scene layers/materials and short-lived pooled effect objects for distinct shots, missiles/trails, and explosions. Keep the 60 Hz fixed-step simulation and existing timeout/neutral-command behavior. Cap device pixel ratio and bound transient effects; resize the renderer to the available panel arena dimensions without changing world coordinates. Effects may degrade gracefully on WebGL initialization failure, but simulation and controls must remain usable and failures must be visible rather than silently presenting a frozen game.

## Interaction and error behavior

- Settings are initialized from the server-provided effective defaults and remain in the current page session when the dialog is reopened.
- Applying settings validates required fields locally, then starts a new run with the selected values. The active run is ended/finalized through the existing lifecycle before the new run becomes active.
- A malformed/unreachable provider configuration is reported in the status/diagnostics UI; the game keeps its existing neutral hold plus cease fallback and never fabricates a successful decision.
- The visible provider/model identity updates only after the new run-start acknowledgement. The run trace records the resolved model identity and sanitized endpoint.
- Closing/canceling settings leaves the current run and settings unchanged.
- Keyboard controls, pause, autopilot, restart, difficulty controls, event tracing, score/lives, and qualification invalidation retain their existing semantics.

## Scope boundaries

- No change to game balance, collision geometry, decision prompts, djev choice schema, endpoint response shape, or benchmark qualification rules.
- No API-key field in the browser.
- No alternate model-selection heuristics or client-side interpretation of model output.
- No rewrite of the deterministic simulation into Three.js physics.
- The desktop demo remains served by the existing server; no frontend framework/build pipeline is introduced solely for this redesign.

## Verification and acceptance criteria

1. At a desktop viewport of at least 600×800 CSS pixels, the complete 600×800 game panel (HUD, arena, bottom indicators) is visible without page scrolling. Smaller viewports scale the panel to fit without introducing page scroll.
2. Arena rendering visibly uses Three.js and distinguishes ordinary shots, fast shots, missiles/trails, and explosions. The simulation core's deterministic fixture results remain unchanged.
3. Changing provider URL/model and starting a new run sends those values to the server, uses them for that run's upstream requests, and records them in that run's manifest. A subsequent run can select different values without restarting the server.
4. Legacy run-start requests without provider overrides continue to use environment defaults.
5. API keys do not appear in HTML, browser requests, UI, or run traces. Endpoint credentials/query/fragment and invalid schemes are rejected.
6. Existing choice validation, neutral fallback, timeout handling, trace lifecycle, and offline regression tests continue to pass.
7. Browser QA covers desktop fit/no-scroll, narrow viewport fit/no-scroll, opening/canceling/applying settings, restart, and live status updates.

## Design system notes

- Palette: deep navy/near-black background, cyan primary accent, amber weapon/attention accent, magenta missile accent, green valid/applied status, red damage/failure.
- Typography: system sans-serif for readable HUD/control labels; compact uppercase micro-labels; tabular figures for score, wave, latency, and counters.
- Main container: one centered fixed-aspect panel, not nested dashboard cards. HUD/status bands are integrated into the frame. The settings surface is a single compact modal over a dimmed game scene.
- Motion: restrained parallax/depth drift and brief impact feedback. No animation may alter deterministic gameplay timing.
- UI values are live state, never decorative sample metrics.

