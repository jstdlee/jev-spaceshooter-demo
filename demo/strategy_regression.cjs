#!/usr/bin/env node

const path = require('node:path');
const { performance } = require('node:perf_hooks');

const {
  BENCHMARK_PROFILES,
  SCHEMA_VERSION,
  buildManifest,
  loadSpaceModulesFromHtml,
} = require('./benchmark.cjs');

const CENTER_ZONE = Object.freeze({ minX: 360, maxX: 600, minY: 230, maxY: 390 });
const ARENA = Object.freeze({ width: 960, height: 620 });
const CENTER_POINT = Object.freeze({
  x: (CENTER_ZONE.minX + CENTER_ZONE.maxX) / 2,
  y: (CENTER_ZONE.minY + CENTER_ZONE.maxY) / 2,
});
const SCENARIO_VIOLATION = 'scenario_regression_not_gameplay';

function bullet({ id, x, y, vx = 0, vy = 0 }) {
  return { id, x, y, vx, vy, radius: 4, fast: false, from_enemy_id: 'strategy-fixture' };
}

function enemy({ id, x, y, vx = 0, w = 28, h = 24, hp = 1, type = 'scout' }) {
  return { id, type, x, y, vx, phase: 0, w, h, hp, maxHp: hp };
}

const STRATEGY_SCENARIOS = Object.freeze([
  {
    id: 'corner-top-left-clear',
    player: { x: 10, y: 9 },
    expected: { intent: 'recover', movement: 'down_right', inwardAxes: ['x', 'y'], distance_center_decreases: true, room_increases: true },
  },
  {
    id: 'corner-top-right-clear',
    player: { x: 950, y: 9 },
    expected: { intent: 'recover', movement: 'down_left', inwardAxes: ['x', 'y'], distance_center_decreases: true, room_increases: true },
  },
  {
    id: 'corner-bottom-left-clear',
    player: { x: 10, y: 611 },
    expected: { intent: 'recover', movement: 'up_right', inwardAxes: ['x', 'y'], distance_center_decreases: true, room_increases: true },
  },
  {
    id: 'corner-bottom-right-clear',
    player: { x: 950, y: 611 },
    expected: { intent: 'recover', movement: 'up_left', inwardAxes: ['x', 'y'], distance_center_decreases: true, room_increases: true },
  },
  {
    id: 'clear-center-position',
    player: { x: 480, y: 310 },
    expected: { intent: 'position', movement: 'hold' },
  },
  {
    id: 'center-bullet-above-evades-clear-lateral',
    player: { x: 480, y: 310 },
    expected_delay_ms: 0,
    bullets: [bullet({ id: 'center-bullet-above', x: 480, y: 250, vx: 0, vy: 180 })],
    expected: {
      intent: 'evade',
      allowedMovements: ['left', 'right', 'down_left', 'down_right'],
      forbiddenMovements: ['hold'],
      forecast: {
        contactNumeric: ['hold'],
        contactClear: ['left', 'right'],
      },
    },
  },
  {
    id: 'left-boundary-outside-recover-after-evade',
    player: { x: 350, y: 310 },
    last_intent: 'evade',
    expected: { intent: 'recover', movement: 'right', distance_center_decreases: true },
  },
  {
    id: 'left-boundary-inside-position',
    player: { x: 370, y: 310 },
    expected: { intent: 'position', movement: 'hold' },
  },
  {
    id: 'right-boundary-outside-recover',
    player: { x: 610, y: 310 },
    expected: { intent: 'recover', movement: 'left', distance_center_decreases: true },
  },
  {
    id: 'right-boundary-inside-position',
    player: { x: 590, y: 310 },
    expected: { intent: 'position', movement: 'hold' },
  },
  {
    id: 'top-boundary-outside-recover',
    player: { x: 480, y: 220 },
    expected: { intent: 'recover', movement: 'down', distance_center_decreases: true },
  },
  {
    id: 'top-boundary-inside-position',
    player: { x: 480, y: 240 },
    expected: { intent: 'position', movement: 'hold' },
  },
  {
    id: 'bottom-boundary-outside-recover',
    player: { x: 480, y: 400 },
    expected: { intent: 'recover', movement: 'up', distance_center_decreases: true },
  },
  {
    id: 'bottom-boundary-inside-position',
    player: { x: 480, y: 380 },
    expected: { intent: 'position', movement: 'hold' },
  },
  {
    id: 'clear-bottom-with-far-enemy-recovers-up',
    player: { x: 480, y: 550 },
    enemies: [enemy({ id: 'far-high-enemy', x: 480, y: 40 })],
    expected: {
      intent: 'recover',
      movement: 'up',
      distance_center_decreases: true,
      forecast: {
        contactClear: ['hold', 'left', 'right', 'up', 'down', 'up_left', 'up_right', 'down_left', 'down_right'],
      },
    },
  },
  {
    id: 'centerward-bullet-blocks-diagonal-recovery',
    player: { x: 320, y: 200 },
    bullets: [bullet({ id: 'centerward-diagonal-blocker', x: 340, y: 220, vx: 40, vy: 40 })],
    expected: {
      intent: 'recover',
      allowedMovements: ['right', 'down'],
      forbiddenMovements: ['down_right'],
      forecast: {
        contactNumeric: ['down_right'],
        contactClear: ['right', 'down'],
      },
    },
  },
]);

function movementVector(movement) {
  const vectors = {
    hold: { dx: 0, dy: 0 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
    up: { dx: 0, dy: -1 },
    down: { dx: 0, dy: 1 },
    up_left: { dx: -1, dy: -1 },
    up_right: { dx: 1, dy: -1 },
    down_left: { dx: -1, dy: 1 },
    down_right: { dx: 1, dy: 1 },
  };
  return vectors[movement] || null;
}

function applyMovement(point, movement, distance = 28) {
  const vector = movementVector(movement);
  if (!vector) throw new Error(`unknown movement: ${movement}`);
  const diagonal = vector.dx !== 0 && vector.dy !== 0 ? Math.SQRT1_2 : 1;
  return {
    x: point.x + vector.dx * distance * diagonal,
    y: point.y + vector.dy * distance * diagonal,
  };
}

function distanceToCenter(point) {
  return Math.hypot(point.x - CENTER_POINT.x, point.y - CENTER_POINT.y);
}

function roomScore(point) {
  return Math.min(point.x - 10, ARENA.width - 10 - point.x, point.y - 9, ARENA.height - 9 - point.y);
}

function isInsideCenterZone(point) {
  return point.x >= CENTER_ZONE.minX
    && point.x <= CENTER_ZONE.maxX
    && point.y >= CENTER_ZONE.minY
    && point.y <= CENTER_ZONE.maxY;
}

function movementMovesInward(point, movement, axes = ['x', 'y']) {
  const moved = applyMovement(point, movement);
  return axes.every((axis) => {
    if (point[axis] < CENTER_POINT[axis]) return moved[axis] > point[axis];
    if (point[axis] > CENTER_POINT[axis]) return moved[axis] < point[axis];
    return moved[axis] === point[axis];
  });
}

function expectedChoiceForScenario(scenario) {
  return { ...scenario.expected };
}

function normalizeChoice(reply) {
  const normalized = reply?.normalized && typeof reply.normalized === 'object' ? reply.normalized : reply;
  return {
    movement: normalized?.movement ?? null,
    fire: normalized?.fire ?? null,
    lease: normalized?.lease ?? null,
    intent: normalized?.intent ?? null,
  };
}

function candidateById(observed, id) {
  return observed.forecast.candidates.find((candidate) => candidate.id === id) || null;
}

function forecastFacts(observed, lease = 'medium') {
  const contacts = {};
  for (const candidate of observed.forecast.candidates || []) {
    contacts[candidate.id] = candidate[lease]?.contact_ms ?? null;
  }
  return {
    lease,
    contacts,
  };
}

function buildCurrentManifest({ core, engineHash, seed = 20260920, profile = 'dense-mid-speed' }) {
  const difficulty = BENCHMARK_PROFILES[profile];
  if (!difficulty) throw new Error(`unknown profile: ${profile}`);
  const manifest = buildManifest({
    seed,
    profile,
    difficulty,
    engineHash,
    engineVersion: core.ENGINE_VERSION,
    mode: 'cli',
    rules: core.RULES,
  });
  manifest.metadata = {
    ...(manifest.metadata || {}),
    scenario_regression: true,
    qualification_violation: SCENARIO_VIOLATION,
  };
  return manifest;
}

function buildScenarioGame(core, manifest, scenario) {
  const game = core.createGame(manifest);
  game.enemies = (scenario.enemies || []).map((item) => ({ ...item }));
  game.enemyBullets = (scenario.bullets || []).map((item) => ({ ...item }));
  game.playerBullets = [];
  game.enemyFireClock_s = 99;
  game.player.x = scenario.player.x;
  game.player.y = scenario.player.y;
  game.player.cooldown_s = 0;
  game.player.invincible_s = 0;
  return game;
}

function observeScenario(core, game, scenario) {
  const lastIntent = scenario.last_intent ?? null;
  return core.observeGame(game, {
    expected_delay_ms: scenario.expected_delay_ms ?? 0,
    latency_samples: 0,
    latency_spread_ms: 0,
    active_command: null,
    recent_commands: [],
    recent_hits: [],
    last_intent: lastIntent,
    last_applied_intent: lastIntent,
    lastAppliedIntent: lastIntent,
  });
}

function evaluateChoiceAgainstScenario(choice, scenario, observed) {
  const expected = expectedChoiceForScenario(scenario);
  const failures = [];
  if (expected.intent && choice.intent !== expected.intent) failures.push(`intent:${choice.intent}!=${expected.intent}`);
  if (expected.movement && choice.movement !== expected.movement) failures.push(`movement:${choice.movement}!=${expected.movement}`);
  if (expected.allowedMovements && !expected.allowedMovements.includes(choice.movement)) {
    failures.push(`movement:${choice.movement}:not_allowed`);
  }
  if (expected.forbiddenMovements && expected.forbiddenMovements.includes(choice.movement)) {
    failures.push(`movement:${choice.movement}:forbidden`);
  }
  if (expected.distance_center_decreases) {
    const moved = applyMovement(scenario.player, choice.movement || 'hold');
    if (!(distanceToCenter(moved) < distanceToCenter(scenario.player))) failures.push('distance_center_not_decreased');
  }
  if (expected.room_increases) {
    const moved = applyMovement(scenario.player, choice.movement || 'hold');
    if (!(roomScore(moved) > roomScore(scenario.player))) failures.push('room_not_increased');
  }
  if (expected.forecast && observed) {
    const facts = forecastFacts(observed);
    for (const movement of expected.forecast.contactNumeric || []) {
      if (typeof facts.contacts[movement] !== 'number') failures.push(`forecast:${movement}:contact_not_numeric`);
    }
    for (const movement of expected.forecast.contactClear || []) {
      if (facts.contacts[movement] !== null) failures.push(`forecast:${movement}:not_clear`);
    }
  }
  return { ok: failures.length === 0, failures };
}

function scenarioSummary(core, manifest, scenario) {
  const game = buildScenarioGame(core, manifest, scenario);
  const observed = observeScenario(core, game, scenario);
  return {
    scenario,
    observed,
    facts: forecastFacts(observed),
    checkpoint: core.serializeGame(game),
    status: core.gameStatus(game),
  };
}

function normalizeBaseUrl(url) {
  if (!url) throw new Error('--url is required');
  return url.replace(/\/+$/, '');
}

async function postJson(baseUrl, route, body, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(normalizeBaseUrl(baseUrl) + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw_text: text };
    }
    if (!response.ok) {
      const error = new Error(`${route} HTTP ${response.status}`);
      error.response = parsed;
      throw error;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function runStrategyRegression({
  url,
  htmlPath = path.join(__dirname, 'space-shooter.html'),
  seed = 20260920,
  profile = 'dense-mid-speed',
  scenarios = STRATEGY_SCENARIOS,
} = {}) {
  const { core, controller: controllerApi, engineHash } = loadSpaceModulesFromHtml(htmlPath);
  const schemaVersion = controllerApi.SCHEMA_VERSION ?? SCHEMA_VERSION;
  const manifest = buildCurrentManifest({ core, engineHash, seed, profile });
  const started = await postJson(url, '/api/run/start', { schema_version: schemaVersion, manifest }, 5000);
  const runId = started.run_id;
  if (!runId) throw new Error('/api/run/start did not return run_id');
  const control = controllerApi.createController({ run_id: runId, epoch: 1 });
  const startedAt = performance.now();
  let eventId = 1;
  let lastAckedEventId = 0;
  const cases = [];

  try {
    for (const [index, scenario] of scenarios.entries()) {
      const summary = scenarioSummary(core, manifest, scenario);
      const wallMs = performance.now() - startedAt;
      const request = controllerApi.beginDecision(control, {
        tick: index,
        wall_ms: wallMs,
        state: summary.observed.state,
        forecast: summary.observed.forecast,
        checkpoint: summary.checkpoint,
      });
      const response = await postJson(url, '/api/decision', request, 2600);
      controllerApi.finishDecision(control, { sequence: request.sequence, wall_ms: performance.now() - startedAt });
      const actual = normalizeChoice(response);
      const check = evaluateChoiceAgainstScenario(actual, scenario, summary.observed);
      const record = {
        event_id: eventId,
        epoch: control.epoch,
        sequence: request.sequence,
        type: 'strategy_regression_case',
        tick: index,
        sim_ms: index * (1000 / 60),
        wall_ms: performance.now() - startedAt,
        payload: {
          scenario_id: scenario.id,
          expected: expectedChoiceForScenario(scenario),
          actual,
          passed: check.ok,
          failures: check.failures,
          raw_request: request,
          raw_response: response,
          facts: summary.facts,
        },
      };
      eventId += 1;
      const eventAck = await postJson(url, '/api/run/event', { schema_version: schemaVersion, run_id: runId, events: [record] }, 5000);
      lastAckedEventId = Number.isInteger(eventAck?.acked_event_id) ? eventAck.acked_event_id : record.event_id;
      cases.push(record.payload);
    }
  } finally {
    await postJson(url, '/api/run/end', {
      schema_version: schemaVersion,
      run_id: runId,
      last_event_id: lastAckedEventId,
      terminal: {
        reason: 'aborted',
        tick: scenarios.length,
        sim_ms: scenarios.length * (1000 / 60),
        wall_ms: performance.now() - startedAt,
        lives: 0,
        wave: 0,
        score: 0,
        qualification_violations: [SCENARIO_VIOLATION],
      },
    }, 5000);
  }

  return {
    run_id: runId,
    manifest,
    violation: SCENARIO_VIOLATION,
    cases,
    failures: cases.filter((item) => !item.passed),
  };
}

function parseArgs(argv) {
  const options = {
    url: null,
    htmlPath: path.join(__dirname, 'space-shooter.html'),
    seed: 20260920,
    profile: 'dense-mid-speed',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--url') options.url = readValue();
    else if (arg === '--html') options.htmlPath = path.resolve(readValue());
    else if (arg === '--seed') options.seed = Number(readValue());
    else if (arg === '--profile') options.profile = readValue();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return 'Usage: node demo/strategy_regression.cjs --url http://127.0.0.1:7865 [--profile dense-mid-speed]';
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = await runStrategyRegression(options);
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CENTER_POINT,
  CENTER_ZONE,
  SCENARIO_VIOLATION,
  STRATEGY_SCENARIOS,
  applyMovement,
  buildCurrentManifest,
  buildScenarioGame,
  distanceToCenter,
  evaluateChoiceAgainstScenario,
  expectedChoiceForScenario,
  forecastFacts,
  isInsideCenterZone,
  movementMovesInward,
  movementVector,
  normalizeChoice,
  observeScenario,
  roomScore,
  runStrategyRegression,
  scenarioSummary,
};
