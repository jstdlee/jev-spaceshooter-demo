const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  HARDEST_PROFILE,
  buildManifest,
  hashSourcePair,
  loadSpaceModulesFromHtml,
} = require('./benchmark.cjs');

const htmlPath = join(__dirname, 'space-shooter.html');

function loadModules() {
  return loadSpaceModulesFromHtml(htmlPath);
}

function makeManifest(engineHash = '0'.repeat(64)) {
  return buildManifest({
    seed: 20260920,
    profile: 'hardest',
    difficulty: HARDEST_PROFILE,
    engineHash,
    engineVersion: 'test-engine',
    mode: 'cli',
  });
}

function makeState(tick = 0) {
  return {
    tick,
    sim_ms: tick * (1000 / 60),
    wave: 1,
    difficulty: HARDEST_PROFILE,
    player: { x: 480, y: 540, w: 20, h: 18, lives: 3, cooldown_ms: 0, invulnerability_ms: 0 },
    active_command: null,
    enemy_fire_in_ms: 237.5,
    threat_counts: { enemies: 1, bullets: 1, shown: 2, total: 2 },
    nearest_threats: [
      { kind: 'bullet', x: 480, y: 520, vx: 0, vy: 169, w: 8, h: 8 },
      { kind: 'enemy', x: 480, y: 100, vx: 0, vy: 20, w: 32, h: 24 },
    ],
    recent_commands: [],
    recent_hits: [],
  };
}

function makeForecast(core) {
  return {
    expected_delay_ms: 259,
    latency_samples: 1,
    latency_spread_ms: 0,
    horizon_ms: 759,
    prefix: { authorized_remaining_ms: 120, contact_ms: 80 },
    assumptions: { enemy_motion: 'current_linear', future_spawns_included: false },
    candidates: core.ACTION_IDS.map((id) => ({
      id,
      short: {
        endpoint: { x: 480, y: 540 },
        contact_ms: id === 'down' ? 0 : null,
        clearance_px: id === 'down' ? 0 : 22,
        edge_distances_px: { left: 470, right: 470, top: 531, bottom: 62 },
        shot_eta_ms: id === 'hold' ? 300 : null,
      },
      medium: {
        endpoint: { x: 480, y: 540 },
        contact_ms: id === 'down' ? 0 : null,
        clearance_px: id === 'down' ? 0 : 18,
        edge_distances_px: { left: 470, right: 470, top: 531, bottom: 62 },
        shot_eta_ms: id === 'hold' ? 300 : null,
      },
    })),
  };
}

function begin(controllerApi, controller, core, tick = 0) {
  const request = controllerApi.beginDecision(controller, {
    tick,
    wall_ms: tick * (1000 / 60),
    state: makeState(tick),
    forecast: makeForecast(core),
    checkpoint: { tick, state_hash: `checkpoint-${tick}` },
  });
  assert.equal(request.schema_version, 1);
  assert.ok(Number.isInteger(request.sequence));
  return request;
}

function validReply(request, overrides = {}) {
  return {
    schema_version: 1,
    run_id: request.run_id,
    epoch: request.epoch,
    sequence: request.sequence,
    decision_id: `decision-${request.sequence}`,
    movement: 'hold',
    fire: 'cease',
    lease: 'short',
    intent: 'position',
    valid_choice: true,
    api_ok: true,
    confidence: { movement: 0.5, fire: 0.5, lease: 0.5, intent: 0.5 },
    ...overrides,
  };
}

function finish(controllerApi, controller, request, wall_ms) {
  controllerApi.finishDecision(controller, { sequence: request.sequence, wall_ms });
}

function ruleValue(rules, path, fallbackPath = []) {
  const read = (segments) => segments.reduce((value, key) => (value == null ? undefined : value[key]), rules);
  return read(path) ?? read(fallbackPath);
}

function playerShotEvents(events) {
  return events.filter((event) => event.type === 'shot' && (event.decision_id || event.payload?.decision_id || event.payload?.owner === 'player'));
}

function shotDecisionId(event) {
  return event.decision_id ?? event.payload?.decision_id ?? null;
}

function near(actual, expected, tolerance, label = 'value') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);
}

function cleanForecastGame(core, overrides = {}) {
  const game = core.createGame(makeManifest());
  game.enemies = [];
  game.enemyBullets = [];
  game.playerBullets = [];
  game.enemyFireClock_s = 99;
  game.player.x = overrides.x ?? 200;
  game.player.y = overrides.y ?? 300;
  game.player.cooldown_s = overrides.cooldown_s ?? 0;
  game.player.invincible_s = overrides.invincible_s ?? 0;
  return game;
}

function observeForForecast(core, game, context = {}) {
  return core.observeGame(game, {
    expected_delay_ms: context.expected_delay_ms ?? 100,
    latency_samples: 0,
    latency_spread_ms: 0,
    active_command: null,
    recent_commands: [],
    recent_hits: [],
    ...context,
  });
}

function candidate(observed, id) {
  const found = observed.forecast.candidates.find((item) => item.id === id);
  assert.ok(found, `missing candidate ${id}`);
  return found;
}

function bullet({ id, x = 200, y = 300, vx = 0, vy = 0 }) {
  return { id, x, y, vx, vy, radius: 4, fast: false, from_enemy_id: 'fixture-enemy' };
}

function scoutEnemy({ id = 'enemy-fixture', x = 260, y = 300 }) {
  return { id, type: 'scout', x, y, vx: 0, phase: 0, w: 32, h: 24, hp: 2, maxHp: 2 };
}

function mockThree({ failWebGL = false } = {}) {
  const vector = () => ({ x:0, y:0, z:0, set(x, y, z = 0) { this.x = x; this.y = y; this.z = z; } });
  class Scene { constructor() { this.children = []; } add(item) { this.children.push(item); } remove(item) { this.children = this.children.filter((child) => child !== item); } }
  class Camera { constructor() { this.position = vector(); } updateProjectionMatrix() {} }
  class Renderer {
    constructor() { if (failWebGL) throw new Error('WebGL unavailable'); this.domElement = { style:{}, addEventListener() {} }; }
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  }
  class TextureLoader { load(_path, onLoad) { const texture = { offset:vector(), repeat:vector(), clone() { return { offset:vector(), repeat:vector(), dispose() {} }; }, dispose() {} }; onLoad?.(texture); return texture; } }
  class SpriteMaterial { constructor(options) { Object.assign(this, options); } dispose() {} }
  class Sprite { constructor(material) { this.material = material; this.position = vector(); this.scale = vector(); this.visible = true; this.rotation = { z:0 }; } }
  class BufferGeometry { setAttribute() {} dispose() {} }
  class Float32BufferAttribute { constructor(array, size) { this.array = array; this.size = size; } }
  class PointsMaterial { constructor(options) { Object.assign(this, options); } dispose() {} }
  class Points { constructor(geometry, material) { this.geometry = geometry; this.material = material; this.position = vector(); } }
  class Color { constructor(value) { this.value = value; } }
  return {
    Scene, OrthographicCamera:Camera, WebGLRenderer:Renderer, TextureLoader, SpriteMaterial, Sprite,
    BufferGeometry, Float32BufferAttribute, PointsMaterial, Points, Color,
    SRGBColorSpace:'srgb', AdditiveBlending:1, ClampToEdgeWrapping:2,
  };
}

// Exercise the actual adapter with a stub DOM and no bootstrap or animation.
// Lifecycle tests supply mocked transport; no test can reach a real HTTP service.
function loadBrowserAdapter(modules, game, controller, options = {}) {
  const elements = new Map();
    const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', innerHTML: '', width: 960, height: 620,
      value: '', title: '', open: false, listeners: {}, style: {},
      getContext: () => ({}), addEventListener(type, fn) { this.listeners[type] = fn; },
      showModal() { this.open = true; }, close() { this.open = false; },
      classList: { toggle() {}, add() {}, remove() {} },
    });
    return elements.get(id);
  };
  const sandbox = {
    SpaceDecisionCore: modules.core,
    SpaceDjevController: modules.controller,
    document: { getElementById: element },
    window: { innerWidth:600, innerHeight:800, addEventListener() {} },
    location: { protocol: options.fetch ? 'http:' : 'file:' },
    performance: { now: () => options.clock?.now ?? 100 },
    fetch: options.fetch || (() => { throw new Error('browser unit tests must never call HTTP'); }),
    sessionStorage: options.sessionStorage || (() => {
      const data = new Map();
      return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
    })(),
    URL,
    TextEncoder, AbortController,
    crypto: require('node:crypto').webcrypto,
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      options.t?.after(() => clearTimeout(timer));
      return timer;
    },
    clearTimeout,
    requestAnimationFrame() { throw new Error('browser unit tests must never start animation'); },
    fixtureGame: game, fixtureController: controller,
  };
  const adapterScript = modules.html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const bootstrap = /    resizeGameFrame\(\);\s*syncDifficultyControls\(\);\s*restartRun\(\);\s*initializeRenderer\(\);\s*requestAnimationFrame\(frame\);\s*\}\)\(\);\s*$/;
  assert.ok(bootstrap.test(adapterScript), 'adapter bootstrap must be excluded from this offline harness');
  vm.runInNewContext(adapterScript.replace(bootstrap, `
    game = fixtureGame;
    controller = fixtureController;
    runStartPerf = 0;
    globalThis.adapter = {
      currentObservation, updateRecentFromEvents, updatePanel, setPaused,
      restartRun, maybeBeginDecision, endRun, processTick, enqueueEvents, drainTrace,
      loadProviderSettings, openSettings, cancelSettings, applySettingsAndRestart,
      getState: () => ({ game, controller, runId, qualification, lastApi,
        completionEvents, history, nextRequestAllowedWallMs, providerSettings }),
    };
  })();`), sandbox);
  element('space-decision-core').textContent = modules.coreScript;
  element('space-djev-controller').textContent = modules.controllerScript;
  return { adapter: sandbox.adapter, element };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const jsonResponse = (body) => ({ ok: true, json: async () => body });
const plain = (value) => JSON.parse(JSON.stringify(value));

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('mock browser work did not settle');
}

function browserTransport() {
  const calls = [];
  let starts = 0;
  const transport = {
    calls, deferStarts: false, deferEvents: false, deferEnds: false,
    fetch: (route, init) => {
      const call = { route, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null, ...deferred() };
      calls.push(call);
      if (route === '/api/config') {
        call.resolve(jsonResponse({ schema_version: 1, provider: { url: 'http://127.0.0.1:8011', model: 'jev-latest' } }));
      } else if (route === '/api/run/start') {
        const run_id = `browser-run-${++starts}`;
        if (!transport.deferStarts) call.resolve(jsonResponse({ schema_version: 1, run_id, trace_path: `runs/${run_id}` }));
      } else if (route === '/api/run/event') {
        if (!transport.deferEvents) call.resolve(jsonResponse({ schema_version: 1, run_id: call.body.run_id, acked_event_id: call.body.events.at(-1).event_id }));
      } else if (route === '/api/run/end') {
        if (!transport.deferEnds) call.resolve(jsonResponse({ schema_version: 1, run_id: call.body.run_id, complete: true }));
      } else assert.equal(route, '/api/decision');
      return call.promise;
    },
    decisions: () => calls.filter((call) => call.route === '/api/decision'),
    ends: () => calls.filter((call) => call.route === '/api/run/end'),
    events: (runId) => calls.filter((call) => call.route === '/api/run/event' && call.body.run_id === runId).flatMap((call) => call.body.events),
    accept: (call) => call.resolve(jsonResponse(validReply(call.body))),
  };
  return transport;
}

test('run integrity shows recording only after the start acknowledgement', async (t) => {
  const bridge = browserTransport();
  bridge.deferStarts = true;
  const { adapter, element } = loadBrowserAdapter(loadModules(), null, null, { fetch: bridge.fetch, clock: { now: 0 }, t });
  const starting = adapter.restartRun();
  await waitUntil(() => bridge.calls.some((call) => call.route === '/api/run/start'));
  adapter.updatePanel();
  assert.equal(element('qualification').textContent, 'pending trace');
  bridge.calls.find((call) => call.route === '/api/run/start').resolve(jsonResponse({ schema_version: 1, run_id: 'integrity-start', trace_path: 'test-trace' }));
  await starting;
  adapter.updatePanel();
  assert.equal(element('qualification').textContent, 'recording');
  bridge.accept(bridge.decisions()[0]);
  await waitUntil(() => !adapter.getState().controller.pending);
  await adapter.endRun('aborted');
});

test('provider defaults and saved per-run settings are applied only after dialog confirmation', async (t) => {
  const bridge = browserTransport();
  const session = (() => {
    const data = new Map();
    return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  })();
  const { adapter, element } = loadBrowserAdapter(loadModules(), null, null,
    { fetch: bridge.fetch, sessionStorage: session, clock: { now: 0 }, t });

  await adapter.restartRun();
  assert.deepEqual(bridge.calls.find((call) => call.route === '/api/run/start').body.provider,
    { url: 'http://127.0.0.1:8011', model: 'jev-latest' });
  assert.equal(bridge.calls.some((call) => call.body && Object.hasOwn(call.body, 'api_key')), false);

  await adapter.openSettings();
  element('setting-provider-url').value = 'https://cancelled.example';
  element('setting-model-name').value = 'cancelled-model';
  adapter.cancelSettings();
  await adapter.restartRun();
  assert.deepEqual(bridge.calls.filter((call) => call.route === '/api/run/start')[1].body.provider,
    { url: 'http://127.0.0.1:8011', model: 'jev-latest' });

  await adapter.openSettings();
  element('setting-provider-url').value = 'https://provider.example/api/jev/';
  element('setting-model-name').value = 'fast-model';
  await adapter.applySettingsAndRestart();
  const starts = bridge.calls.filter((call) => call.route === '/api/run/start');
  assert.deepEqual(starts[2].body.provider,
    { url: 'https://provider.example/api/jev', model: 'fast-model' });
  assert.deepEqual(JSON.parse(session.getItem('spaceShooterProviderSettings')),
    { url: 'https://provider.example/api/jev', model: 'fast-model' });
  assert.equal(element('hud-provider').textContent, 'fast-model');
  assert.equal(JSON.stringify(bridge.calls).includes('api_key'), false);
});

test('Three.js renderer is read-only with deterministic state and reports WebGL initialization failure', async () => {
  const rendererSource = readFileSync(join(__dirname, 'space-shooter-renderer.js'), 'utf8');
  assert.doesNotMatch(rendererSource, /space-decision-core/);
  assert.doesNotMatch(rendererSource, /\bgame\.[\w$]+\s*=/, 'renderer must not mutate canonical game properties');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(rendererSource).toString('base64')}`;
  const rendererModule = await import(moduleUrl);
  const host = { clientWidth:598, clientHeight:386, appendChild() {} };
  const renderer = rendererModule.createSpaceShooterRenderer({ THREE:mockThree(), host, width:960, height:620, onError(error) { throw error; } });
  const left = loadModules().core.createGame({ seed:311 });
  const right = loadModules().core.createGame({ seed:311 });
  const core = loadModules().core;
  for (let tick = 0; tick < 12; tick += 1) {
    core.stepGame(left, null);
    core.stepGame(right, null);
    renderer.render(left, left.events, tick / 60);
    assert.equal(core.hashGame(left), core.hashGame(right));
  }
  const failed = [];
  const fallbackRenderer = rendererModule.createSpaceShooterRenderer({
    THREE:mockThree({ failWebGL:true }), host, width:960, height:620, onError(error) { failed.push(error.message); },
  });
  assert.deepEqual(failed, ['WebGL unavailable']);
  core.stepGame(left, null);
  assert.equal(left.tick, 13, 'simulation remains callable after renderer failure');
  renderer.dispose();
  fallbackRenderer.dispose();
});

test('run integrity reports the ending reason only after a complete end acknowledgement', async (t) => {
  const bridge = browserTransport();
  bridge.deferEnds = true;
  const { adapter, element } = loadBrowserAdapter(loadModules(), null, null, { fetch: bridge.fetch, clock: { now: 0 }, t });
  await adapter.restartRun();
  bridge.accept(bridge.decisions()[0]);
  await waitUntil(() => !adapter.getState().controller.pending);
  const ending = adapter.endRun('death');
  await waitUntil(() => bridge.ends().length === 1);
  adapter.updatePanel();
  assert.notEqual(element('qualification').textContent, 'trace complete · death');
  const end = bridge.ends()[0];
  end.resolve(jsonResponse({ schema_version: 1, run_id: end.body.run_id, complete: true }));
  await ending;
  adapter.updatePanel();
  assert.equal(element('qualification').textContent, 'trace complete · death');
});

for (const pauseAt of ['before_start_ack', 'after_start_ack']) {
  test(`run integrity preserves invalid reasons through start and end acknowledgements (${pauseAt})`, async (t) => {
    const bridge = browserTransport();
    bridge.deferStarts = true;
    const { adapter, element } = loadBrowserAdapter(loadModules(), null, null, { fetch: bridge.fetch, clock: { now: 0 }, t });
    const starting = adapter.restartRun();
    await waitUntil(() => bridge.calls.some((call) => call.route === '/api/run/start'));
    if (pauseAt === 'before_start_ack') adapter.setPaused(true);
    bridge.calls.find((call) => call.route === '/api/run/start').resolve(jsonResponse({ schema_version: 1, run_id: 'integrity-invalid', trace_path: 'test-trace' }));
    await starting;
    if (pauseAt === 'after_start_ack') {
      bridge.accept(bridge.decisions()[0]);
      await waitUntil(() => !adapter.getState().controller.pending);
      adapter.setPaused(true);
    }
    adapter.updatePanel();
    assert.equal(element('qualification').textContent, 'invalid · paused');
    await adapter.endRun('aborted');
    adapter.updatePanel();
    assert.equal(element('qualification').textContent, 'invalid · paused');
    assert.deepEqual(bridge.ends()[0].body.terminal.qualification_violations, ['paused']);
  });
}

test('browser finalizes first and second runs once each with exact final checkpoints', async (t) => {
  const modules = loadModules();
  const bridge = browserTransport();
  const clock = { now: 0 };
  const { adapter } = loadBrowserAdapter(modules, null, null, { fetch: bridge.fetch, clock, t });
  for (const [index, steps] of [[0, 7], [1, 13]]) {
    await adapter.restartRun();
    bridge.accept(bridge.decisions()[index]);
    await waitUntil(() => !adapter.getState().controller.pending);
    const { game, runId } = adapter.getState();
    for (let tick = 0; tick < steps; tick += 1) modules.core.stepGame(game, null);
    clock.now += 300;
    const expectedHash = modules.core.hashGame(game);
    await adapter.endRun('aborted');
    await adapter.endRun('aborted');
    assert.equal(bridge.ends().length, index + 1, 'each run must finalize exactly once');
    const terminal = bridge.ends().at(-1).body.terminal;
    assert.equal(terminal.tick, steps);
    const finalCheckpoint = bridge.events(runId).filter((event) => event.type === 'checkpoint').at(-1);
    assert.equal(finalCheckpoint.tick, steps);
    assert.equal(finalCheckpoint.payload.checkpoint.tick, steps);
    assert.equal(finalCheckpoint.payload.hash, expectedHash);
    assert.equal(finalCheckpoint.sim_ms, terminal.sim_ms);
    assert.ok(bridge.ends().at(-1).body.last_event_id >= finalCheckpoint.event_id);
  }
});

for (const outcome of ['success', 'rejected', 'error']) {
  test(`old same-sequence decision ${outcome} after restart cannot mutate new authority or trace`, async (t) => {
    const modules = loadModules();
    const bridge = browserTransport();
    const clock = { now: 0 };
    const { adapter } = loadBrowserAdapter(modules, null, null, { fetch: bridge.fetch, clock, t });
    await adapter.restartRun();
    const oldCall = bridge.decisions()[0];
    const oldGame = adapter.getState().game;
    for (let tick = 0; tick < 7; tick += 1) modules.core.stepGame(oldGame, null);
    const oldHash = modules.core.hashGame(oldGame);
    clock.now = 120;
    await adapter.restartRun();
    const newCall = bridge.decisions()[1];
    assert.equal(oldCall.body.sequence, 1);
    assert.equal(newCall.body.sequence, 1);
    const before = adapter.getState();
    const pending = before.controller.pending;
    const counters = plain(before.controller.counters);
    const history = plain(before.history);
    if (outcome === 'error') oldCall.reject(new Error('old transport failed'));
    else oldCall.resolve(jsonResponse(validReply(oldCall.body, outcome === 'rejected' ? { api_ok: false, valid_choice: false } : {})));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = adapter.getState();
    assert.ok(after.controller.pending === pending, 'old completion must not settle sequence 1 of the new run');
    assert.deepEqual(plain(after.controller.counters), counters);
    assert.deepEqual(plain(after.history), history);
    assert.equal(after.controller.queued, null);
    assert.equal(after.nextRequestAllowedWallMs, 0);
    assert.equal(after.completionEvents.length, 0);
    assert.equal(after.lastApi.latency_ms, null);
    assert.equal(bridge.events(after.runId).some((event) => ['response_received', 'response_rejected'].includes(event.type)), false);
    bridge.accept(newCall);
    await waitUntil(() => !after.controller.pending);
    await adapter.endRun('aborted');
    await waitUntil(() => bridge.ends().length === 2);
    const oldEnd = bridge.ends().find((call) => call.body.run_id === oldCall.body.run_id);
    assert.equal(oldEnd.body.terminal.tick, 7);
    assert.equal(oldEnd.body.terminal.wall_ms, 120);
    const finalCheckpoint = bridge.events(oldCall.body.run_id).filter((event) => event.type === 'checkpoint').at(-1);
    assert.equal(finalCheckpoint.payload.hash, oldHash);
    assert.equal(finalCheckpoint.tick, 7);
  });
}

test('late run-start response after restart cannot install old identity or start an old decision', async (t) => {
  const modules = loadModules();
  const bridge = browserTransport();
  bridge.deferStarts = true;
  const { adapter } = loadBrowserAdapter(modules, null, null, { fetch: bridge.fetch, clock: { now: 0 }, t });
  const firstStart = adapter.restartRun();
  await waitUntil(() => bridge.calls.filter((call) => call.route === '/api/run/start').length === 1);
  const secondStart = adapter.restartRun();
  await waitUntil(() => bridge.calls.filter((call) => call.route === '/api/run/start').length === 2);
  const starts = bridge.calls.filter((call) => call.route === '/api/run/start');
  starts[1].resolve(jsonResponse({ schema_version: 1, run_id: 'new-start', trace_path: 'new-trace' }));
  await secondStart;
  const current = adapter.getState().controller;
  const pending = current.pending;
  starts[0].resolve(jsonResponse({ schema_version: 1, run_id: 'old-start', trace_path: 'old-trace' }));
  await firstStart;
  assert.equal(adapter.getState().runId, 'new-start');
  assert.equal(current.run_id, 'new-start');
  assert.equal(current.pending, pending);
  assert.equal(bridge.decisions().length, 1);
  bridge.accept(bridge.decisions()[0]);
  await waitUntil(() => !current.pending);
  await adapter.endRun('aborted');
  await waitUntil(() => bridge.ends().length === 2);
  assert.equal(bridge.ends().find((call) => call.body.run_id === 'old-start').body.terminal.tick, 0);
});

for (const outcome of ['ack', 'error']) {
  test(`old trace ${outcome} after restart keeps new-run events and qualification isolated`, async (t) => {
    const modules = loadModules();
    const bridge = browserTransport();
    bridge.deferEvents = true;
    const { adapter } = loadBrowserAdapter(modules, null, null, { fetch: bridge.fetch, clock: { now: 0 }, t });
    await adapter.restartRun();
    const oldEvent = bridge.calls.find((call) => call.route === '/api/run/event');
    await adapter.restartRun();
    const newRunId = adapter.getState().runId;
    if (outcome === 'error') oldEvent.reject(new Error('old trace failed'));
    else oldEvent.resolve(jsonResponse({ schema_version: 1, run_id: oldEvent.body.run_id, acked_event_id: oldEvent.body.events.at(-1).event_id }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(adapter.getState().qualification.valid, true);
    bridge.deferEvents = false;
    for (const call of bridge.calls.filter((item) => item.route === '/api/run/event' && item !== oldEvent)) {
      call.resolve(jsonResponse({ schema_version: 1, run_id: call.body.run_id, acked_event_id: call.body.events.at(-1).event_id }));
    }
    for (const call of bridge.decisions()) bridge.accept(call);
    await waitUntil(() => !adapter.getState().controller.pending);
    await adapter.endRun('aborted');
    await waitUntil(() => bridge.ends().length === 2);
    const events = bridge.events(newRunId);
    assert.equal(events.some((event) => event.type === 'qualification_invalidated'), false);
    const ids = [...new Set(events.map((event) => event.event_id))];
    assert.deepEqual(ids, Array.from({ length: ids.at(-1) }, (_, index) => index + 1));
    assert.equal(events.filter((event) => event.type === 'terminal').length, 1);
  });
}

test('browser death checkpoint captures the completed fatal tick and does not count finalization time', async (t) => {
  const modules = loadModules();
  const bridge = browserTransport();
  const clock = { now: 0 };
  const { adapter } = loadBrowserAdapter(modules, null, null, { fetch: bridge.fetch, clock, t });
  await adapter.restartRun();
  bridge.accept(bridge.decisions()[0]);
  await waitUntil(() => !adapter.getState().controller.pending);
  const { game, runId } = adapter.getState();
  for (let tick = 0; tick < 7; tick += 1) modules.core.stepGame(game, null);
  game.player.lives = 1;
  game.enemyBullets = [bullet({ id: 'fatal-fixture', x: game.player.x, y: game.player.y })];
  clock.now = 134;
  adapter.processTick();
  const terminalHash = modules.core.hashGame(game);
  clock.now = 900;
  await adapter.endRun('death');
  await waitUntil(() => bridge.ends().length === 1);
  const terminal = bridge.ends()[0].body.terminal;
  assert.equal(terminal.tick, 8);
  assert.equal(terminal.wall_ms, 134);
  const checkpoint = bridge.events(runId).filter((event) => event.type === 'checkpoint').at(-1);
  assert.equal(checkpoint.tick, 8);
  assert.equal(checkpoint.payload.checkpoint.tick, 8);
  assert.equal(checkpoint.payload.checkpoint.player.lives, 0);
  assert.equal(checkpoint.payload.hash, terminalHash);
  assert.equal(bridge.events(runId).filter((event) => event.type === 'terminal').at(-1).tick, 8);
});

test('requests offer all nine fixed-medium paths, both fire choices, and all three intents atomically', () => {
  const { core, controller: api } = loadModules();
  const controller = api.createController({ run_id: 'intent-request', epoch: 1 });
  const request = begin(api, controller, core);
  assert.equal(request.prompt_version, 'djev-authoritative-v2');
  assert.equal(request.context_version, 'djev-observation-v2');
  assert.deepEqual(Object.keys(request.questions), ['path', 'fire', 'intent']);
  assert.deepEqual(Object.keys(request.questions.path.criteria), [
    'hold__medium', 'left__medium', 'right__medium', 'up__medium', 'down__medium',
    'up_left__medium', 'up_right__medium', 'down_left__medium', 'down_right__medium',
  ]);
  assert.deepEqual(Object.keys(request.questions.fire.criteria), ['shoot', 'cease']);
  assert.deepEqual(Object.keys(request.questions.intent.criteria), ['evade', 'recover', 'position']);
});

test('missing or unknown intent atomically ends current authority and cannot move or shoot', () => {
  const { core, controller: api } = loadModules();
  for (const intent of [undefined, null, '', 'unknown', 'Recover', 0, false, {}]) {
    const controller = api.createController({ run_id: 'invalid-intent', epoch: 1 });
    const previous = begin(api, controller, core);
    api.receiveDecision(controller, validReply(previous, { movement: 'left', fire: 'shoot', intent: 'evade' }), { tick: 0, wall_ms: 10 });
    finish(api, controller, previous, 10);
    api.commandForTick(controller, { tick: 0, wall_ms: 11 });
    const request = begin(api, controller, core, 1);
    const reply = validReply(request, { movement: 'right', fire: 'shoot', intent });
    if (intent === undefined) delete reply.intent;
    const received = api.receiveDecision(controller, reply, { tick: 1, wall_ms: 30 });
    assert.equal(received.events[0].type, 'response_rejected');
    assert.equal(received.events[0].reason, 'unknown_intent');
    finish(api, controller, request, 30);
    const result = api.commandForTick(controller, { tick: 1, wall_ms: 31 });
    assert.equal(result.command, null);
    assert.equal(result.events.some((event) => event.type === 'command_applied'), false);
    assert.equal(result.events.find((event) => event.type === 'command_ended').intent, 'evade');
    assert.equal(controller.lastAppliedIntent, 'evade', 'invalid replies must not replace factual history');
    const game = cleanForecastGame(core);
    core.stepGame(game, result.command);
    assert.equal(game.player.x, 200);
    assert.equal(game.player.y, 300);
    assert.equal(game.playerBullets.length, 0);
  }
});

test('every valid intent follows response, application, shot, observation, and lease-ended history', () => {
  const { core, controller: api } = loadModules();
  for (const intent of ['evade', 'recover', 'position']) {
    const controller = api.createController({ run_id: 'intent-history', epoch: 1 });
    assert.equal(controller.lastAppliedIntent, null);
    const request = begin(api, controller, core);
    const received = api.receiveDecision(controller, validReply(request, { fire: 'shoot', intent }), { tick: 0, wall_ms: 10 });
    assert.equal(received.events[0].intent, intent);
    assert.equal(controller.queued.decision.intent, intent);
    assert.equal(controller.lastAppliedIntent, null, 'receiving is not applying');
    finish(api, controller, request, 10);
    const applied = api.commandForTick(controller, { tick: 0, wall_ms: 11 });
    assert.equal(applied.command.intent, intent);
    assert.equal(applied.events.find((event) => event.type === 'command_applied').command.intent, intent);
    assert.equal(controller.lastAppliedIntent, intent);
    const game = cleanForecastGame(core);
    game.enemies = [scoutEnemy({ x: 800, y: 50 })];
    core.stepGame(game, applied.command);
    assert.equal(game.playerBullets[0].authorizedBy.intent, intent);
    assert.equal(game.playerBullets[0].authorizedBy.decision_id, 'decision-1');
    const restored = core.restoreGame(core.serializeGame(game));
    assert.equal(restored.playerBullets[0].authorizedBy.intent, intent);
    const observed = observeForForecast(core, game, {
      last_intent: controller.lastAppliedIntent,
      active_command: { ...applied.command, remaining_ms: 230 },
      recent_commands: [{ ...applied.command, source: 'djev', elapsed_ms: 16.7, dx: 0, dy: 0 }],
    });
    assert.equal(observed.state.last_intent, intent);
    assert.equal(observed.state.active_command.intent, intent);
    assert.equal(observed.state.recent_commands[0].intent, intent);
    const expired = api.commandForTick(controller, { tick: 15, wall_ms: 261 });
    assert.equal(expired.command, null);
    assert.equal(expired.events.find((event) => event.type === 'command_ended').intent, intent);
    assert.equal(expired.events.find((event) => event.type === 'command_ended').confidence?.intent, 0.5);
    assert.equal(controller.lastAppliedIntent, intent, 'lease expiry retains applied history');
    core.stepGame(game, expired.command);
    assert.equal(game.playerBullets[0].authorizedBy.intent, intent, 'expiry does not rewrite shot provenance');
  }
});

test('queued, stale, or invalidated decisions never invent or retain an unapplied intent', () => {
  const { core, controller: api } = loadModules();
  const controller = api.createController({ run_id: 'intent-reset', epoch: 1 });
  const game = cleanForecastGame(core);
  assert.equal(observeForForecast(core, game).state.last_intent, null);
  assert.equal(api.commandForTick(controller, { tick: 0, wall_ms: 0 }).command, null);
  assert.equal(controller.lastAppliedIntent, null);
  const request = begin(api, controller, core);
  api.receiveDecision(controller, validReply(request, { intent: 'recover' }), { tick: 0, wall_ms: 590 });
  finish(api, controller, request, 590);
  assert.equal(api.commandForTick(controller, { tick: 0, wall_ms: 601 }).command, null);
  assert.equal(controller.lastAppliedIntent, null, 'queued reply expired before application');

  const next = begin(api, controller, core, 40);
  api.receiveDecision(controller, validReply(next, { intent: 'position', lease: 'medium' }), { tick: 40, wall_ms: 680 });
  finish(api, controller, next, 680);
  api.commandForTick(controller, { tick: 40, wall_ms: 681 });
  assert.equal(controller.lastAppliedIntent, 'position');
  const invalidated = api.invalidateController(controller, 'paused');
  assert.equal(invalidated.events.find((event) => event.type === 'command_ended').intent, 'position');
  assert.equal(controller.lastAppliedIntent, null);
  assert.equal(controller.active, null);
  api.receiveDecision(controller, validReply(next, { intent: 'evade' }), { tick: 40, wall_ms: 682 });
  assert.equal(controller.lastAppliedIntent, null);
  assert.equal(api.commandForTick(controller, { tick: 40, wall_ms: 683 }).command, null);
  assert.equal(api.createController({ run_id: 'new-run', epoch: 1 }).lastAppliedIntent, null);
});

test('intent is optional on observed historical spans and never defaults neutral history to a model intent', () => {
  const { core } = loadModules();
  const game = cleanForecastGame(core);
  const observed = observeForForecast(core, game, {
    active_command: { movement: 'hold', fire: 'cease', lease: 'short', remaining_ms: 50 },
    recent_commands: [
      { movement: 'left', fire: 'cease', lease: 'short', source: 'djev' },
      { movement: 'hold', fire: 'cease', lease: null, source: 'neutral' },
    ],
  });
  assert.equal(observed.state.last_intent, null);
  assert.equal(Object.hasOwn(observed.state.active_command, 'intent'), false);
  assert.equal(observed.state.recent_commands.some((span) => Object.hasOwn(span, 'intent')), false);
});

test('browser sends applied intent history and renders Chinese plus enum without starting a run', () => {
  const modules = loadModules();
  const { core, controller: api } = modules;
  const game = cleanForecastGame(core);
  const controller = api.createController({ run_id: 'browser-intent', epoch: 1 });
  const { adapter, element } = loadBrowserAdapter(modules, game, controller);
  for (const [index, intent, label, probability] of [[0, 'evade', '避险', 0], [1, 'recover', '回中', 0.73], [2, 'position', '稳定站位', undefined]]) {
    const request = begin(api, controller, core, index);
    const received = api.receiveDecision(controller, validReply(request, { movement: 'left', intent, lease: 'medium', confidence: { intent: probability } }), { tick: index, wall_ms: 80 + index });
    adapter.updateRecentFromEvents(received.events);
    finish(api, controller, request, 80 + index);
    const applied = api.commandForTick(controller, { tick: index, wall_ms: 90 + index });
    adapter.updateRecentFromEvents(applied.events);
    const observed = adapter.currentObservation();
    assert.equal(observed.state.last_intent, intent);
    assert.equal(observed.state.active_command.intent, intent);
    assert.equal(observed.state.recent_commands.at(-1).intent, intent);
    adapter.updatePanel();
    for (const text of [element('selected').textContent, element('executed').textContent, element('history').innerHTML]) {
      assert.ok(text.includes(`${label} (${intent})`), text);
      assert.ok(text.includes(`API p=${probability === undefined ? '—' : probability.toFixed(3)}`), text);
    }
  }
  game.terminal = { reason: 'death' };
  adapter.updatePanel();
  assert.equal(element('neutral-reason').textContent, 'ended · no active command');
  game.terminal = null;
  adapter.setPaused(true);
  assert.equal(adapter.currentObservation().state.last_intent, null);
  assert.equal(adapter.currentObservation().state.active_command, null);
});

test('inline modules expose the frozen authoritative runtime contract', () => {
  const { core, controller, coreScript, controllerScript, engineHash } = loadModules();
  assert.equal(engineHash, hashSourcePair(coreScript, controllerScript));
  assert.deepEqual([...core.ACTION_IDS], ['hold', 'left', 'right', 'up', 'down', 'up_left', 'up_right', 'down_left', 'down_right']);
  assert.deepEqual({ ...core.LEASE_TICKS }, { short: 15, medium: 30 });
  assert.equal(core.DT_MS, 1000 / 60);
  assert.deepEqual({ ...core.HARDEST_DIFFICULTY }, HARDEST_PROFILE);
  assert.equal(ruleValue(core.RULES, ['enemy_fire_interval', 'baseline_s'], ['enemy_fire_baseline_s']), 0.95);
  assert.equal(ruleValue(core.RULES, ['leases_ticks', 'short'], ['lease_ticks', 'short']), 15);
  for (const name of ['createGame', 'stepGame', 'observeGame', 'serializeGame', 'restoreGame', 'hashGame', 'gameStatus']) {
    assert.equal(typeof core[name], 'function', `SpaceDecisionCore.${name}`);
  }
  for (const name of ['createController', 'beginDecision', 'receiveDecision', 'commandForTick', 'finishDecision', 'invalidateController']) {
    assert.equal(typeof controller[name], 'function', `SpaceDjevController.${name}`);
  }
});

test('difficulty settings preserve the hardest profile and doubled baseline fire rate', () => {
  const { engineHash, core } = loadModules();
  const manifest = makeManifest(engineHash);
  assert.deepEqual(manifest.difficulty, {
    bulletDensity: 4,
    enemyDensity: 3,
    fastBulletRatio: 0.85,
    fastBulletSpeed: 2.4,
  });
  assert.equal(manifest.rules.enemy_fire_baseline_s, 0.95);
  assert.equal(manifest.rules.hardest_enemy_fire_interval_s, 0.2375);
  assert.equal(manifest.rules.player_speed_px_s, 112);
  assert.equal(manifest.rules.player_lives, 3);
  assert.equal(manifest.rules.shot_cooldown_s, 0.17);
  const game = core.createGame(manifest);
  const status = core.gameStatus(game);
  assert.equal(typeof status.counters, 'object');
  assert.equal(Array.isArray(status.counters), false);
  assert.equal(status.tick, 0);
  assert.equal(status.sim_ms, 0);
  assert.equal(status.lives, 3);
  assert.equal(status.wave, 1);
  assert.equal(status.game_over, false);
  const observed = core.observeGame(game, {
    expected_delay_ms: 260,
    active_command: null,
    recent_commands: [],
    recent_hits: [],
  });
  assert.equal(observed.state.difficulty.bulletDensity, 4);
});

test('all movement and lease pairs stay visible even when candidates collide or hit walls', () => {
  const { core } = loadModules();
  const game = core.createGame(makeManifest());
  const observed = core.observeGame(game, {
    expected_delay_ms: 260,
    active_command: null,
    recent_commands: [],
    recent_hits: [],
  });
  assert.equal(observed.forecast.candidates.length, 9);
  assert.deepEqual(observed.forecast.candidates.map((candidate) => candidate.id), core.ACTION_IDS);
  for (const candidate of observed.forecast.candidates) {
    assert.ok(candidate.short);
    assert.ok(candidate.medium);
    assert.ok(Object.hasOwn(candidate.short, 'contact_ms'));
    assert.ok(Object.hasOwn(candidate.medium, 'contact_ms'));
  }
});

test('forecast reports candidate-path bullet contacts on global time after response delay', () => {
  const { core } = loadModules();
  const game = cleanForecastGame(core, { x: 200, y: 300 });
  game.enemyBullets = [bullet({ id: 'global-crossing', x: 240, y: 300 })];
  const observed = observeForForecast(core, game, { expected_delay_ms: 200 });
  assert.equal(observed.forecast.prefix.contact_ms, null);
  near(candidate(observed, 'right').short.contact_ms, 396.4, 1.5, 'right short contact_ms');
});

test('forecast keeps raw prefix collision separate and does not mask later clear candidate paths', () => {
  const { core } = loadModules();
  const game = cleanForecastGame(core, { x: 200, y: 300 });
  game.enemyBullets = [bullet({ id: 'prefix-only', x: 200, y: 267, vy: 400 })];
  const observed = observeForForecast(core, game, { expected_delay_ms: 300 });
  assert.ok(observed.forecast.prefix.contact_ms > 20 && observed.forecast.prefix.contact_ms < 60);
  assert.equal(candidate(observed, 'right').short.contact_ms, null);
  assert.equal(candidate(observed, 'up').medium.contact_ms, null);
});

test('forecast ignores contacts only during known current invulnerability, not after expiry', () => {
  const { core } = loadModules();
  const game = cleanForecastGame(core, { x: 200, y: 300, invincible_s: 0.25 });
  game.enemyBullets = [
    bullet({ id: 'ignored-during-current-invuln', x: 200, y: 183, vy: 1000 }),
    bullet({ id: 'counted-after-current-invuln', x: 200, y: -67, vy: 1000 }),
  ];
  const observed = observeForForecast(core, game, { expected_delay_ms: 50 });
  near(candidate(observed, 'hold').short.contact_ms, 350, 2, 'known invulnerability expiry contact_ms');
});

test('forecast does not invent future invulnerability from prefix collisions to hide later candidate contact', () => {
  const { core } = loadModules();
  const game = cleanForecastGame(core, { x: 200, y: 300, invincible_s: 0 });
  game.enemyBullets = [
    bullet({ id: 'prefix-damage-would-happen', x: 200, y: 250, vy: 1000 }),
    bullet({ id: 'later-still-counts', x: 200, y: -67, vy: 1000 }),
  ];
  const observed = observeForForecast(core, game, { expected_delay_ms: 100 });
  assert.ok(observed.forecast.prefix.contact_ms > 20 && observed.forecast.prefix.contact_ms < 60);
  near(candidate(observed, 'hold').short.contact_ms, 350, 2, 'future invulnerability must not mask later contact');
});

test('forecast keeps stopped neutral tail through horizon for short-lease contacts', () => {
  const { core } = loadModules();
  const game = cleanForecastGame(core, { x: 200, y: 300 });
  game.enemyBullets = [bullet({ id: 'tail-crossing', x: 228, y: -167, vy: 1000 })];
  const observed = observeForForecast(core, game, { expected_delay_ms: 100 });
  near(candidate(observed, 'right').short.contact_ms, 450, 2, 'short stopped-tail contact_ms');
});

test('forecast exposes factual enemy_clearance_px for every movement and lease independent of invulnerability', () => {
  const { core } = loadModules();
  const game = cleanForecastGame(core, { x: 200, y: 300, invincible_s: 1.0 });
  game.enemies = [scoutEnemy({ x: 260, y: 300 })];
  const observed = observeForForecast(core, game, { expected_delay_ms: 100 });
  for (const item of observed.forecast.candidates) {
    for (const lease of ['short', 'medium']) {
      assert.equal(Object.hasOwn(item[lease], 'enemy_clearance_px'), true, `${item.id} ${lease} missing enemy_clearance_px`);
      assert.equal(Number.isFinite(item[lease].enemy_clearance_px), true, `${item.id} ${lease} enemy_clearance_px must be finite`);
      assert.ok(item[lease].enemy_clearance_px >= 0, `${item.id} ${lease} enemy_clearance_px must be non-negative`);
    }
  }
});

test('a dangerous valid recover action moves into contact unchanged and starts the requested lease', () => {
  const { core, controller: controllerApi } = loadModules();
  const controller = controllerApi.createController({ run_id: 'unit-run', epoch: 3 });
  const request = begin(controllerApi, controller, core, 0);
  controllerApi.receiveDecision(controller, validReply(request, {
    decision_id: 'decision-danger',
    movement: 'down',
    fire: 'shoot',
    lease: 'short',
    intent: 'recover',
    confidence: { movement: 0.2, fire: 0.9, lease: 0.7 },
  }), { tick: 0, wall_ms: 121 });
  finish(controllerApi, controller, request, 121);
  const applied = controllerApi.commandForTick(controller, { tick: 0, wall_ms: 122 });
  assert.equal(applied.command.movement, 'down');
  assert.equal(applied.command.fire, 'shoot');
  assert.equal(applied.command.intent, 'recover');
  assert.equal(applied.command.decision_id, 'decision-danger');
  assert.equal(applied.command.start_tick, 0);
  assert.equal(applied.command.end_tick, 15);
  const game = cleanForecastGame(core);
  game.enemyBullets = [bullet({ id: 'danger-below', x: 200, y: 314 })];
  const stepped = core.stepGame(game, applied.command);
  near(game.player.y, 301.8666666666667, 1e-9);
  assert.equal(game.player.x, 200);
  assert.equal(game.player.lives, 2, 'the locally dangerous API choice must not be vetoed');
  assert.ok(stepped.events.some((event) => event.type === 'hit'));
});

test('missing, invalid, and stale atomic replies produce neutral command state', () => {
  const { core, controller: controllerApi } = loadModules();
  for (const reply of [
    { movement: 'left', fire: null, lease: 'short', valid_choice: false, api_ok: true },
    { movement: 'left', fire: 'shoot', lease: 'long', valid_choice: true, api_ok: true },
    { movement: 'left', fire: 'shoot', lease: 'short', valid_choice: true, api_ok: false },
  ]) {
    const controller = controllerApi.createController({ run_id: 'unit-run', epoch: 4 });
    const request = begin(controllerApi, controller, core, 4);
    controllerApi.receiveDecision(controller, validReply(request, {
      decision_id: 'bad-decision',
      ...reply,
    }), { tick: 4, wall_ms: 100 });
    finish(controllerApi, controller, request, 100);
    const result = controllerApi.commandForTick(controller, { tick: 4, wall_ms: 101 });
    assert.equal(result.command, null);
  }

  const stale = controllerApi.createController({ run_id: 'unit-run', epoch: 5 });
  const staleRequest = begin(controllerApi, stale, core, 0);
  controllerApi.receiveDecision(stale, validReply(staleRequest, {
    decision_id: 'stale-decision',
    movement: 'left',
    fire: 'shoot',
    lease: 'short',
  }), { tick: 0, wall_ms: 601 });
  finish(controllerApi, stale, staleRequest, 601);
  assert.equal(controllerApi.commandForTick(stale, { tick: 0, wall_ms: 602 }).command, null);
});

test('lease expiry and old callbacks cannot extend or cancel newer authority', () => {
  const { core, controller: controllerApi } = loadModules();
  const controller = controllerApi.createController({ run_id: 'unit-run', epoch: 8 });
  const oldRequest = begin(controllerApi, controller, core, 0);
  controllerApi.invalidateController(controller, 'manual-reset');
  const currentRequest = begin(controllerApi, controller, core, 1);
  controllerApi.receiveDecision(controller, validReply(oldRequest, {
    decision_id: 'old-decision',
    movement: 'left',
    fire: 'shoot',
    lease: 'medium',
  }), { tick: 1, wall_ms: 110 });
  controllerApi.receiveDecision(controller, validReply(currentRequest, {
    decision_id: 'current-decision',
    movement: 'right',
    fire: 'cease',
    lease: 'short',
  }), { tick: 1, wall_ms: 120 });
  finish(controllerApi, controller, currentRequest, 120);
  assert.equal(controllerApi.commandForTick(controller, { tick: 1, wall_ms: 121 }).command.movement, 'right');
  assert.equal(controllerApi.commandForTick(controller, { tick: 15, wall_ms: 360 }).command.movement, 'right');
  assert.equal(controllerApi.commandForTick(controller, { tick: 16, wall_ms: 377 }).command, null);
});

test('stale old replies cannot neutralize a newer active command', () => {
  const { core, controller: controllerApi } = loadModules();
  const controller = controllerApi.createController({ run_id: 'unit-run', epoch: 11 });
  const oldRequest = begin(controllerApi, controller, core, 0);
  controllerApi.invalidateController(controller, 'restart');
  const currentRequest = begin(controllerApi, controller, core, 1);
  controllerApi.receiveDecision(controller, validReply(currentRequest, {
    decision_id: 'current-authority',
    movement: 'up',
    fire: 'shoot',
    lease: 'medium',
  }), { tick: 1, wall_ms: 100 });
  finish(controllerApi, controller, currentRequest, 100);
  assert.equal(controllerApi.commandForTick(controller, { tick: 1, wall_ms: 101 }).command.decision_id, 'current-authority');

  controllerApi.receiveDecision(controller, validReply(oldRequest, {
    decision_id: 'obsolete-neutralizer',
    movement: 'left',
    fire: 'cease',
    lease: 'short',
    api_ok: false,
    valid_choice: false,
  }), { tick: 2, wall_ms: 120 });
  const afterOldReply = controllerApi.commandForTick(controller, { tick: 2, wall_ms: 121 });
  assert.equal(afterOldReply.command.decision_id, 'current-authority');
  assert.equal(afterOldReply.command.movement, 'up');
});

test('missing run_id or decision_id is rejected without inventing command authority', () => {
  const { core, controller: controllerApi } = loadModules();
  for (const replyPatch of [
    { run_id: undefined },
    { run_id: 'wrong-run' },
    { decision_id: undefined },
    { decision_id: '' },
  ]) {
    const controller = controllerApi.createController({ run_id: 'unit-run', epoch: 12 });
    const request = begin(controllerApi, controller, core, 0);
    controllerApi.receiveDecision(controller, validReply(request, replyPatch), { tick: 0, wall_ms: 100 });
    finish(controllerApi, controller, request, 100);
    const result = controllerApi.commandForTick(controller, { tick: 0, wall_ms: 101 });
    assert.equal(result.command, null);
    assert.equal(result.events.some((event) => event.type === 'command_applied'), false);
  }
});

test('neutral ticks do not autofire and shots link to an authorizing decision', () => {
  const { core } = loadModules();
  const game = core.createGame(makeManifest());
  for (let i = 0; i < 20; i += 1) {
    const { events } = core.stepGame(game, null);
    const unauthorizedShots = playerShotEvents(events);
    assert.equal(unauthorizedShots.length, 0);
  }

  const command = {
    decision_id: 'run-unit:1:1',
    sequence: 1,
    movement: 'hold',
    fire: 'shoot',
    lease: 'short',
    start_tick: 20,
    end_tick: 35,
    applied_wall_ms: 333.4,
    expires_wall_ms: 583.4,
  };
  let sawShot = false;
  for (let tick = 20; tick < 35; tick += 1) {
    const { events } = core.stepGame(game, command);
    for (const event of playerShotEvents(events)) {
      sawShot = true;
      assert.equal(shotDecisionId(event), 'run-unit:1:1');
    }
  }
  assert.equal(sawShot, true);
});

test('shoot cooldown continues through cease and never banks extra shots', () => {
  const { core } = loadModules();
  const game = core.createGame(makeManifest());
  const shoot = {
    decision_id: 'cooldown-shoot',
    sequence: 1,
    movement: 'hold',
    fire: 'shoot',
    lease: 'medium',
    start_tick: 0,
    end_tick: 30,
    applied_wall_ms: 0,
    expires_wall_ms: 500,
  };
  const firstShotTicks = [];
  for (let tick = 0; tick < 30; tick += 1) {
    const { events } = core.stepGame(game, shoot);
    for (const event of playerShotEvents(events)) firstShotTicks.push(event.tick);
  }
  assert.deepEqual(firstShotTicks, [0, 11, 22]);

  for (let tick = 30; tick < 60; tick += 1) {
    const { events } = core.stepGame(game, null);
    assert.equal(playerShotEvents(events).length, 0);
  }

  const resumed = { ...shoot, decision_id: 'cooldown-resume', sequence: 2, start_tick: 60, end_tick: 75, applied_wall_ms: 1000, expires_wall_ms: 1250 };
  const { events } = core.stepGame(game, resumed);
  const resumedShots = playerShotEvents(events);
  assert.equal(resumedShots.length, 1);
  assert.equal(shotDecisionId(resumedShots[0]), 'cooldown-resume');
});

test('serialize, restore, and hash form a deterministic replay boundary', () => {
  const { core } = loadModules();
  const game = core.createGame(makeManifest());
  const command = {
    decision_id: 'move-decision',
    sequence: 1,
    movement: 'up_left',
    fire: 'cease',
    lease: 'medium',
    start_tick: 0,
    end_tick: 30,
    applied_wall_ms: 0,
    expires_wall_ms: 500,
  };
  for (let i = 0; i < 12; i += 1) core.stepGame(game, command);
  const checkpoint = core.serializeGame(game);
  const restored = core.restoreGame(checkpoint);
  assert.equal(core.hashGame(restored), core.hashGame(game));
  assert.deepEqual(core.serializeGame(restored), checkpoint);
});
