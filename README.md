# Jev bounded movement decision demo

This standalone demo focuses on a hard control problem: the game keeps changing while a model request is in flight. The browser evaluates nine short movement actions against every active hostile projectile and enemy, sends only the currently eligible actions to Jev, and then distinguishes the model's **selected** action from the movement actually **executed**.

## Design goal

Demonstrate structured decision selection under changing state, with explicit local safety checking, bounded execution, and honest attribution. This is not a survival benchmark and does not claim that model steering outperforms local-only control.

```text
live state → candidate motion/safety → one Jev choice → freshness + current-state check → bounded execution
                                      local fallback ────────────────────────────────────────┘
```

The browser is the real-time controller. Jev gets one supported `movement` choice question and selects one of the safe candidates supplied in that request. It does not receive raw threats, invent trajectories, set difficulty, or control the command duration. A returned choice is applied only when its epoch, sequence, pending-request identity, age, and current collision check remain valid.

## Why this is difficult

The earlier control approach exposed several common failure mechanisms:

- A closest-approach calculation treated the player as stationary, so a receding projectile could appear immediately dangerous.
- Spatial path samples compared objects at different future times, missing real crossings and flagging harmless ones.
- Averaging risk across threats diluted one collision as harmless objects were added; truncating the threat list could hide the dangerous object entirely.
- A preferred center corridor acted like a hard boundary and blocked legitimate emergency escape into the rest of the arena.
- Model movement labels were displayed but did not directly control motion, while model output changed wave difficulty. That made model influence impossible to attribute.
- Old async replies could cross reset, pause, or manual-control boundaries.

This version uses time-aligned swept axis-aligned collision intervals. Each action moves for at most 240 ms and then remains at its endpoint through a 600 ms lookahead. Collision exclusion happens before center, room, and continuity preferences. All active threats participate; collision is an OR and clearance is a minimum, so harmless objects cannot dilute a dangerous one. The actual arena is the only hard movement boundary.

## Run

Requirements are a modern browser and Python 3.10 or newer (the bridge uses Python union type syntax). No third-party browser or bridge packages are required.

```bash
python3 demo/space_shooter_server.py --host 127.0.0.1 --port 7862
```

Open [http://127.0.0.1:7862](http://127.0.0.1:7862).

The bridge calls `http://127.0.0.1:8011/v1/systemone` by default. See [djev-spark](https://github.com/mmastrac/djev-spark) for model endpoint setup. Configuration can be placed in a repository-root `.env` or exported in the process environment:

```bash
DJEV_URL=http://127.0.0.1:8011
DJEV_API_KEY=
```

Set `DJEV_API_KEY` when the endpoint requires authentication. Do not commit `.env`; `.env.example` is the public template. If the API is unavailable or replies too slowly, local fallback continues to move the ship. Offline fallback does not demonstrate model steering.

Controls:

- **Auto pilot** toggles bounded Jev/local control and manual control.
- **WASD**, arrow keys, or pointer movement steer manually.
- **Space** or **Pause** pauses/resumes and starts a fresh control epoch.
- **Restart run** creates a new run ID and resets simulated elapsed time.

## What the panel means

- **Selected**: the Jev action, epoch/sequence, response age, and rejection status when applicable.
- **Executed**: the actual action, source (`jev`, `local`, or `manual`), remaining authorization, and realized frame displacement.
- **Override**: an explicit reason such as age, stale epoch/sequence, unsafe on arrival, a new collision, arena bound, expiry, pause, or manual takeover.
- **Safety**: eligible actions out of all nine and the earliest predicted contact within the 0.6 s horizon.
- **Candidate grid**: all nine candidate statuses, including safe, predicted contact, and arena-bound actions.
- **Run ID / simulated elapsed**: identity and simulation time for credible observations without hidden resets.

The API cards deliberately separate round-trip latency, reported input/output token counts, failures, accepted choices, and Jev commands physically applied. **API token throughput (input+output)** is `(reported input tokens + reported output tokens) / bridge round-trip seconds`. **Rolling completed requests/s** counts completions in a trailing 10-second window. Neither value is decode TPS. Structured output-token accounting can include answer-canvas rows and thought tokens, so it is not directly equivalent to ordinary autoregressive generated-token throughput.

## Fixed environment

Wave difficulty is independent of model choices. Waves cycle deterministically through scout/aimed, swarm/spray, and tank/sweep profiles at normal difficulty; each profile is frozen when the wave starts. API failure never gates the next wave.

## Tests

```bash
node demo/test_space_shooter_logic.cjs
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s demo -p 'test_space_shooter.py' -v
```

The Node file uses the built-in `node:test` runner and reports all 18 named cases when invoked directly. On Node v22.23.2, wrapping an explicit CommonJS test file with the default process-isolated `node --test <file>` command can collapse its report to one outer file-level test; failures still propagate, but the displayed count is misleading. `node --test --experimental-test-isolation=none demo/test_space_shooter_logic.cjs` is an equivalent verbose invocation for that Node release.

Verified deterministic behavior includes receding and already-overlapping projectiles, time-aligned crossings, stopped-tail contact, zero-relative-axis cases, no risk dilution or truncation, escape outside the old preferred corridor, deterministic room/continuity choices, all-unsafe best effort, direct model-selected displacement, command expiry and frame splitting, current-state overrides, stale lifecycle rejection, old-callback identity safety, pending-request local movement, fixed wave progression, request validation, defensive response normalization, API failure distinctions, and measured rate semantics.

A real local API compatibility smoke used an in-memory credential and returned a valid `hold` choice in one observed 149.9 ms round trip with 343 input and 8 output tokens. That single observation confirms schema compatibility only; it is not a latency or throughput guarantee. The checked-in tests make no live API or browser call.

For another standalone Jev integration example, see the companion [Jev email filter demo](https://github.com/jstdlee/jev-email-filter-demo).

## Tradeoffs and limitations

- Nine finite actions and a 600 ms horizon are intentionally small; this is not a search planner.
- Enemy motion prediction is linear over the short horizon. Sine motion, wall bounces, wraparound, and projectiles not yet fired are not predicted exactly.
- Damage still occurs on discrete game frames, and steering changes direction instantaneously as an arcade simplification.
- A 4 px collision margin and per-frame revalidation reduce exposure but do not prove collision freedom.
- Network delay can make every model reply too old to execute. The browser aborts broken client transport after 2.5 s, while the bridge uses a 2 s upstream timeout; neither implies model-side cancellation.
- Paused, background, or embedded browser renderers can heavily throttle animation frames. A choice that was fresh when received may therefore expire before the next simulation update and will be rejected by the normal freshness guard. Simulated elapsed time is not wall time under throttling; use an active foreground tab for live control and do not infer survival duration from wall-clock time.
- One embedded-browser sample ran at roughly one animation frame per second and applied zero Jev commands despite valid API choices. This is a renderer-throttling observation, not a live-play or survival result.
- When every candidate is predicted to collide, local control chooses the latest-contact best effort and reports that no candidate passed this finite check. It does not claim inevitable loss or guaranteed survival.
- No survival-duration guarantee or controlled model-versus-local performance comparison is included.

The most important boundary is simple: Jev chooses among actions the browser has already judged eligible; the browser owns safety, freshness, execution, wave progression, and fallback.
