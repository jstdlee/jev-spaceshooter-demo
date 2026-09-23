# Three.js Game and Provider Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved fixed 600×800 no-scroll Three.js shooter panel with per-run JEV-compatible provider URL and model settings.

**Architecture:** Keep the deterministic simulation/controller and server-side choice validation authoritative. Add validated provider/model overrides to each server `RunState` and expose safe defaults to the browser; add a session-scoped settings dialog; move presentation to a dedicated Three.js ES module dynamically loaded by the existing HTML page. Three.js animates game state only and never changes simulation, collision, protocol, or benchmark results.

**Tech Stack:** Existing Python standard-library HTTP bridge, existing inline JavaScript simulation/controller, browser ES modules, Three.js 0.186.0 from the jsDelivr CDN, Python `unittest`, Node built-in test runner, Codex browser QA.

**Spec:** `docs/superpowers/specs/2026-09-23-fixed-viewport-threejs-provider-settings-design.md`

## Global Constraints

- The main game panel is designed at exactly 600×800 CSS pixels and scales proportionally to fit smaller viewports without page scrolling.
- The 60 Hz deterministic simulation remains the authority for game state, collisions, score, and protocol snapshots.
- Provider URL is a base URL; the bridge appends `/v1/systemone`.
- API keys remain server-side and are never sent to the browser or included in traces.
- The browser submits provider/model overrides only to same-origin `/api/run/start`.
- Requests without overrides continue to use `DJEV_URL` and `DJEV_MODEL`.
- Preserve current choice validation/normalization, neutral fallback, timeout, trace lifecycle, and qualification rules.
- Keep the current static-server architecture; do not add a frontend framework or build pipeline.

## Review Focus

- Provider URL with a non-HTTP scheme, credentials, query, fragment, whitespace, or duplicate `/v1/systemone` — reject before creating a run; pin with URL validation tests in Task 1.
- Different provider/model values on successive runs while an earlier run is completing — each run must use only its immutable captured configuration; pin with per-run isolation tests in Task 1.
- Missing provider/model overrides from an older client — resolve to configured defaults and preserve existing API behavior; pin with compatibility tests in Task 1.
- API key present in environment while settings and traces are used — it must never appear in config responses, browser payloads, manifests, or traces; pin with leak assertions in Tasks 1 and 2.
- Missing CDN/WebGL support or narrow browser viewport — keep the game controls/simulation functional and keep the full panel visible without document scrolling; pin fallback behavior and narrow viewport checks in Tasks 3 and 4.

---

## File Structure

- Modify `demo/space_shooter_server.py`: safe config endpoint, provider/model validation, immutable per-run settings, and per-run upstream transport.
- Modify `demo/test_space_shooter.py`: API config/default/validation/isolation/key-redaction regression coverage.
- Modify `demo/space-shooter.html`: 600×800 shell, live compact HUD/status dashboard, settings dialog, session settings behavior, Three.js import map and renderer integration.
- Create `demo/space-shooter-renderer.js`: Three.js scene setup, object mapping, pooled transient effects, resize/dispose lifecycle, and graceful initialization failure.
- Modify `demo/test_space_shooter_logic.cjs`: browser adapter transport/settings assertions and deterministic behavior regression coverage where compatible with the existing VM harness.
- Modify `README.md`: document per-run provider/model settings, URL shape, server-only credentials, Three.js CDN requirement, and updated controls/layout.

### Task 1: Server-side provider settings captured per run

**Files:**
- Modify: `demo/space_shooter_server.py`
- Test: `demo/test_space_shooter.py`

**Interfaces:**
- Add `effective_provider_config() -> dict[str, str]`, returning sanitized `provider_url` and `model` from `DJEV_URL` / `DJEV_MODEL` defaults.
- Add `validate_provider_config(value: Any) -> dict[str, str]`, where absent fields inherit defaults, `provider_url` is absolute HTTP(S) without credentials/query/fragment or an already-appended `/v1/systemone`, and `model` is trimmed, nonempty, and at most `MAX_MODEL_LEN` characters.
- Extend `RunState` with immutable `provider_url: str` and `configured_model: str` fields.
- Extend `start_run(body)` to accept optional `provider: {"url": "<base-url>", "model": "<model>"}`; reject unknown provider keys and put sanitized endpoint/model in the manifest identity.
- Change `_call_djev(payload)` to `_call_djev(run, payload)` and build the request URL/model from that run. Continue reading only the API key from server environment configuration.
- Add `GET /api/config` returning `{"schema_version": 1, "provider": {"url": "<base-url>", "model": "<model>"}}` without returning any credential.

- [x] **Step 1: Add failing tests for URL/model validation and fallback**

Add tests to `demo/test_space_shooter.py` that set `DJEV_URL=http://127.0.0.1:8011/` and `DJEV_MODEL=default-model`, then verify an empty provider object resolves to URL `http://127.0.0.1:8011` and model `default-model`. Parameterize rejected URL cases `file:///tmp/api`, `http://user:pass@example.test`, `https://example.test/?token=x`, `https://example.test/#fragment`, `https://example.test/v1/systemone`, `http://[broken`, and `http://example.test:bad`. Reject blank model, a model longer than `MAX_MODEL_LEN`, and an unexpected provider field.

```python
def test_provider_config_uses_environment_defaults_and_rejects_unsafe_urls(self):
    with mock.patch.dict(server.os.environ, {"DJEV_URL": "http://127.0.0.1:8011/", "DJEV_MODEL": "default-model"}, clear=True):
        self.assertEqual(server.validate_provider_config({}), {
            "url": "http://127.0.0.1:8011", "model": "default-model",
        })
        for url in ("file:///tmp/api", "http://user:pass@example.test", "https://example.test/?token=x",
                    "https://example.test/#fragment", "https://example.test/v1/systemone"):
            with self.subTest(url=url), self.assertRaises(server.RequestValidationError):
                server.validate_provider_config({"url": url, "model": "m"})
```

- [x] **Step 2: Run the focused test and confirm it fails**

Run: `python3 demo/test_space_shooter.py`
Expected: new provider-config test fails because `validate_provider_config` is not implemented.

- [x] **Step 3: Implement config validation, safe GET config, and run capture**

Implement the interfaces above. Validate URL with `urllib.parse.urlsplit`; require `http` or `https`, a hostname, no username/password/query/fragment, and reject a normalized path that already ends with `/v1/systemone`. Preserve optional base-path prefixes, strip trailing `/`, then append `/v1/systemone`. In `start_run`, resolve provider values before creating a run directory, store the sanitized endpoint/model in `RunState` and its start manifest, and use them from `_call_djev(run, payload)`. `Handler.do_GET` serves `/api/config` before its existing health/static routes. Preserve environment fallback when `provider` is absent.

```python
def effective_provider_config() -> dict[str, str]:
    return validate_provider_config({})

def validate_provider_config(value: Any) -> dict[str, str]:
    _load_env_file()
    value = _require_object(value, "provider")
    defaults = {"url": os.environ.get("DJEV_URL", DJEV_URL_DEFAULT),
                "model": os.environ.get("DJEV_MODEL", DJEV_MODEL_DEFAULT)}
    unknown = set(value) - {"url", "model"}
    if unknown:
        raise RequestValidationError(f"provider contains unknown fields: {', '.join(sorted(unknown))}")
    raw_url = value.get("url", defaults["url"])
    model = value.get("model", defaults["model"])
    if not isinstance(raw_url, str) or not raw_url or raw_url != raw_url.strip():
        raise RequestValidationError("provider.url must be a trimmed absolute HTTP(S) base URL")
    try:
        parsed = urllib.parse.urlsplit(raw_url)
    except ValueError as exc:
        raise RequestValidationError("provider.url is malformed") from exc
    path = parsed.path.rstrip("/")
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or path.endswith("/v1/systemone")):
        raise RequestValidationError("provider.url must be an HTTP(S) base URL without credentials, query, fragment, or a duplicated /v1/systemone path")
    try:
        parsed.port
    except ValueError as exc:
        raise RequestValidationError("provider.url has an invalid port") from exc
    if not isinstance(model, str):
        raise RequestValidationError("provider.model must be a string")
    model = model.strip()
    if not model or len(model) > MAX_MODEL_LEN:
        raise RequestValidationError(f"provider.model must contain 1 to {MAX_MODEL_LEN} characters")
    return {"url": urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", "")), "model": model}
```

- [x] **Step 4: Test per-run isolation, legacy fallback, and key non-disclosure**

Add tests that create two runs with distinct provider URLs/models, stub `urllib.request.urlopen`, invoke `handle_decision` for each, and assert exact target URLs end in `/v1/systemone` and request JSON contains the run's configured model. Include `https://provider.example/api/jev/` and assert its final request URL is `https://provider.example/api/jev/v1/systemone`. Assert a run started without overrides uses environment defaults. Set `DJEV_API_KEY=secret-fixture` and verify `/api/config` output and serialized run records do not contain it. Verify `GET /api/config` through `Handler` returns the two safe effective values.

- [x] **Step 5: Run the server suite**

Run: `python3 demo/test_space_shooter.py`
Expected: all existing and new tests pass, including exact request-body, protocol-choice, fallback, trace, and lifecycle tests.

- [x] **Step 6: Commit the server/API task**

```bash
git add demo/space_shooter_server.py demo/test_space_shooter.py
git commit -m "feat: support per-run provider settings"
```

### Task 2: Compact game panel and provider/model settings UI

**Files:**
- Modify: `demo/space-shooter.html`
- Test: `demo/test_space_shooter_logic.cjs`

**Interfaces:**
- `providerSettings` is `{ url: string, model: string }`, initialized from `GET /api/config` and stored in `sessionStorage` under `spaceShooterProviderSettings`.
- `startTrace(manifest, run, providerSettings)` posts `{schema_version: 1, manifest, provider: {url, model}}` to `/api/run/start`.
- The existing `restartRun(reason)` reads the saved settings and continues using the existing end/start lifecycle.
- Settings actions are `openSettings()`, `cancelSettings()`, and `applySettingsAndRestart()`; Apply validates fields, saves them for the current tab session, then restarts.

- [x] **Step 1: Add failing browser-adapter tests for provider payload and dialog cancellation**

Extend `demo/test_space_shooter_logic.cjs` so `browserTransport()` handles `GET /api/config` with a JSON response and start requests retain their `provider` object. Test that defaults reach `/api/run/start`, opening then canceling settings does not alter the next run config, and applying new URL/model causes the next `/api/run/start` payload to contain exactly those new settings.

```javascript
assert.deepEqual(bridge.calls.find((call) => call.route === '/api/run/start').body.provider,
  { url: 'http://127.0.0.1:8011', model: 'jev-latest' });
```

- [x] **Step 2: Run the focused Node test and confirm it fails**

Run: `node --test demo/test_space_shooter_logic.cjs`
Expected: provider configuration assertions fail because the UI has no configuration flow.

- [x] **Step 3: Replace wide grid with a 600×800 fixed-design panel**

Restructure `demo/space-shooter.html` into one centered `.game-frame` with fixed design dimensions `600px × 800px`. Compose its height from an integrated top HUD, arena, and compact bottom dashboard/control strip. Put live API state, latency, valid/applied counts in the bottom strip. Move detailed candidate observations, long metrics, and history into a closed-by-default Diagnostics disclosure so the main frame stays within 800px. Set the document viewport to `100dvh`, center the frame, calculate a uniform scale capped at `1`, and apply the scale to a wrapper so the frame never induces document scroll on smaller viewports. Keep keyboard controls and existing button semantics.

- [x] **Step 4: Add settings dialog and per-run browser configuration**

Add a `<dialog>` with labeled Provider URL and Model name inputs, helper text “Base URL; `/v1/systemone` is appended by the bridge.”, and Apply & restart run / Cancel buttons. Fetch `/api/config` on initialization; use the server response unless valid session values exist. Pass a copy of current settings when creating each run object so later edits cannot retarget it. Apply saves settings then invokes the established run finalization/restart path; Cancel closes the dialog without changing current settings. Show the acknowledged model/endpoint identity only after run-start succeeds. Never render or store the server API key.

- [x] **Step 5: Re-run UI/controller tests and check secret boundaries**

Run: `node --test demo/test_space_shooter_logic.cjs`
Expected: provider payload/cancel/apply cases pass, with all existing run-integrity and trace lifecycle tests intact. Assert no browser request body contains a key field.

- [x] **Step 6: Commit the panel/settings UI task**

```bash
git add demo/space-shooter.html demo/test_space_shooter_logic.cjs
git commit -m "feat: add game panel and provider settings"
```

### Task 3: Three.js 2.5D renderer isolated from simulation

**Files:**
- Create: `demo/space-shooter-renderer.js`
- Modify: `demo/space-shooter.html`
- Test: `demo/test_space_shooter_logic.cjs`

**Interfaces:**
- `createSpaceShooterRenderer({ THREE, host, width, height, onError }) -> { render(game, visualEvents, elapsedSeconds), resize(width, height), dispose() }`.
- The renderer reads `game` and visual-only event snapshots; it never mutates game objects or calls simulation APIs.
- The HTML import map pins `three` to `https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.module.js`; renderer module imports `* as THREE from "three"`. The official installation guide supports CDN imports via import maps and advises using a consistent version/CDN ([Three.js installation](https://threejs.org/manual/pages/installation.html)).

- [x] **Step 1: Add renderer contract tests that protect deterministic core behavior**

Add tests around `SpaceDecisionCore`: feed the same seed and input sequence before/after renderer initialization and compare `core.hashGame(game)` at every tick. Add a static contract assertion that renderer source has no imports from `space-decision-core` and does not assign to `game.*`. Exercise init failure via renderer `onError` and confirm app/game update functions remain callable.

```javascript
const before = core.hashGame(game);
renderer.render(game, [], 0.25);
assert.equal(core.hashGame(game), before);
```

- [x] **Step 2: Run renderer/core tests and confirm the renderer contract is missing**

Run: `node --test demo/test_space_shooter_logic.cjs`
Expected: renderer contract fails until the module and adapter hook exist; simulation-only tests remain green.

- [x] **Step 3: Implement a bounded Three.js scene and object synchronization**

Create an orthographic scene mapped to the existing 960×620 world coordinates. Put background stars/nebula depth on a separate visual layer; synchronize player, enemy, friendly shot, enemy bullet, fast projectile, and missile objects from the current simulation arrays. Use color/shape/material differences for ordinary shots, fast shots, and missiles. Use a capped pool for muzzle flashes and explosion particles; expire and reuse effects after a fixed visual lifetime. Clamp renderer pixel ratio to `Math.min(devicePixelRatio || 1, 1.5)`, use `ResizeObserver` for the arena, and dispose geometries/materials/renderer on teardown.

- [x] **Step 4: Integrate asynchronous module loading without coupling simulation startup**

Add the Three import map before scripts. Keep the existing classic inline application script and dynamically import `./space-shooter-renderer.js`; once loaded, construct the renderer and call its `render` from the existing animation frame after the simulation step. Until loaded, display the existing neutral presentation fallback and keep controls/API requests active. If module import or WebGL initialization fails, show an explicit renderer warning and use the retained Canvas 2D draw fallback; do not stop fixed-step simulation. Keep drawing data one-way from game state to renderer.

- [x] **Step 5: Run Node regression tests and verify deterministic hashes**

Run: `node --test demo/test_space_shooter_logic.cjs`
Expected: all existing game/controller regression tests pass, and rendering does not change canonical game hashes for fixed seeds/input sequences.

- [x] **Step 6: Commit the Three.js renderer task**

```bash
git add demo/space-shooter-renderer.js demo/space-shooter.html demo/test_space_shooter_logic.cjs
git commit -m "feat: render shooter with three.js effects"
```

### Task 4: Documentation, browser fit, and end-to-end verification

**Files:**
- Modify: `README.md`
- Test: `demo/test_space_shooter.py`
- Test: `demo/test_space_shooter_logic.cjs`
- Browser QA: `http://127.0.0.1:7865/`

**Interfaces:**
- README documents the current run config names and effective defaults, server-only API key, provider base URL rule, 600×800 panel controls, diagnostics disclosure, and the need for CDN access to pinned Three.js.
- No production/test-only endpoint accepts API credentials from the browser.

- [x] **Step 1: Document provider configuration and demo behavior**

Update README setup/API sections to explain that settings can be changed in the in-game dialog per run; `DJEV_URL`/`DJEV_MODEL` remain defaults; URL must be the service base (bridge appends `/v1/systemone`); `DJEV_API_KEY` stays in server environment; and the page loads pinned Three.js 0.186.0 from jsDelivr. Describe the 600×800 panel, settings dialog, diagnostics disclosure, and renderer fallback without claiming offline CDN operation.

- [x] **Step 2: Run the complete offline test set**

Run: `python3 demo/test_space_shooter.py && node --test demo/test_space_shooter_logic.cjs && node --test demo/test_strategy_regression.cjs demo/test_benchmark.cjs`
Expected: all bridge, deterministic simulation/controller, strategy, and benchmark tests pass.

- [x] **Step 3: Start the isolated demo server and inspect desktop layout**

Run from the repo root using its established command, `python3 demo/space_shooter_server.py --host 127.0.0.1 --port 7865`. Open `http://127.0.0.1:7865/` in the Codex browser. At viewport 600×800 or larger, verify the complete frame is visible and `document.documentElement.scrollHeight === window.innerHeight` when the viewport is set to 600×800.

- [x] **Step 4: Verify small-screen scaling and settings flow in browser**

Set a narrow viewport such as 360×740 and verify the entire 600×800 design scales down with no horizontal or vertical document scrolling; restore 600×800 and open settings. Verify Cancel preserves the current run; change provider/model to a local test fixture, Apply & restart, and verify run ID/model identity updates only after start acknowledgement. Do not send a live game decision to an unintended provider; use a controlled fixture or stop before first autopilot request.

- [x] **Step 5: Inspect rendered game and simulate renderer fallback**

Verify WebGL canvas is active; distinguish slow/fast bullets, missile trail, and explosion on a live or deterministic fixture; confirm HUD counts remain live and unchanged by rendering. Block the Three CDN request or disable WebGL and verify a visible warning appears, Canvas fallback runs, and game controls continue working.

- [x] **Step 6: Commit documentation and any final test adjustments**

```bash
git add README.md demo/test_space_shooter.py demo/test_space_shooter_logic.cjs
git commit -m "docs: describe shooter renderer and provider settings"
```

## Plan Self-Review

- Spec coverage: per-run provider capture and defaults (Task 1), secret boundary and dialog flow (Tasks 1–2), fixed panel and responsive no-scroll behavior (Task 2), render-only Three.js scene and failure fallback (Task 3), README and browser acceptance checks (Task 4).
- Failure coverage: unsafe URL/model inputs and per-run isolation in Task 1; missing defaults/key leakage in Tasks 1–2; renderer no-WebGL and CDN failure plus viewport scaling in Tasks 3–4.
- Interface consistency: Task 1 owns API config and per-run settings. Task 2 sends `{provider:{url,model}}` in run/start. Task 3 owns `createSpaceShooterRenderer` and consumes only game state. Task 4 exercises the same route and UI without changing contracts.
- Dependencies: sequentially integrate server contract → settings UI → renderer → browser/docs so each stage has a runnable regression boundary.
