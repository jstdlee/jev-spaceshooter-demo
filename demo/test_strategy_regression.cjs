const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const {
  CONTEXT_VERSION,
  DENSE_MID_SPEED_PROFILE,
  PROMPT_VERSION,
  loadSpaceModulesFromHtml,
} = require('./benchmark.cjs');
const {
  CENTER_ZONE,
  SCENARIO_VIOLATION,
  STRATEGY_SCENARIOS,
  applyMovement,
  buildCurrentManifest,
  distanceToCenter,
  evaluateChoiceAgainstScenario,
  forecastFacts,
  isInsideCenterZone,
  movementMovesInward,
  observeScenario,
  roomScore,
  runStrategyRegression,
  scenarioSummary,
} = require('./strategy_regression.cjs');

function loadScenarioRuntime() {
  const { core, engineHash } = loadSpaceModulesFromHtml(path.join(__dirname, 'space-shooter.html'));
  const manifest = buildCurrentManifest({ core, engineHash });
  return { core, manifest };
}

function byId(id) {
  const scenario = STRATEGY_SCENARIOS.find((item) => item.id === id);
  assert.ok(scenario, `missing scenario ${id}`);
  return scenario;
}

test('strategy runner sends backend-valid event metadata for every decision before ending the run', async (t) => {
  const runId = 'run-strategy-contract-fixture';
  const calls = [];
  const events = [];
  const decisions = [];
  const validator = [
    'import json, sys',
    'import space_shooter_server as server',
    'body = json.loads(sys.argv[1])',
    'try:',
    '    server._require_schema(body)',
    '    for event in body["events"]:',
    '        server._validate_event(event)',
    'except server.ApiError as exc:',
    '    print(json.dumps({"ok": False, "error": str(exc)}))',
    'else:',
    '    print(json.dumps({"ok": True}))',
  ].join('\n');

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname;
    const body = JSON.parse(options.body);
    calls.push({ route, body });
    let reply;
    if (route === '/api/run/start') {
      reply = { schema_version: 1, run_id: runId, prompt_version: PROMPT_VERSION, prompt_hash: 'fixture' };
    } else if (route === '/api/decision') {
      decisions.push(body);
      reply = {
        schema_version: 1, run_id: runId, epoch: body.epoch, sequence: body.sequence,
        decision_id: `fixture-${body.sequence}`, intent: decisions.length === 1 ? 'position' : 'evade',
        movement: decisions.length === 1 ? 'hold' : 'left', fire: 'cease', lease: 'medium',
        api_ok: true, valid_choice: true, error: null, latency_ms: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        confidence: { intent: 0.9, path: 0.9, movement: 0.9, fire: 0.9, lease: 0.9 },
      };
    } else if (route === '/api/run/event') {
      // Exercise the Python bridge's complete event validator without contacting a model or service.
      const { stdout } = await promisify(execFile)('python3', ['-B', '-c', validator, JSON.stringify(body)], {
        cwd: __dirname, encoding: 'utf8', timeout: 5000,
      });
      const checked = JSON.parse(stdout);
      if (!checked.ok) return new Response(JSON.stringify(checked), { status: 400 });
      assert.equal(body.run_id, runId);
      for (const event of body.events) {
        assert.equal(event.epoch, decisions.at(-1).epoch);
        assert.equal(event.sequence, decisions.at(-1).sequence);
        assert.deepEqual(event.payload.raw_request, decisions.at(-1));
        events.push(event);
      }
      reply = { schema_version: 1, run_id: runId, acked_event_id: events.at(-1).event_id };
    } else if (route === '/api/run/end') {
      assert.equal(body.last_event_id, events.at(-1)?.event_id ?? 0);
      reply = { schema_version: 1, run_id: runId, complete: true };
    } else {
      throw new Error(`unexpected route: ${route}`);
    }
    return new Response(JSON.stringify(reply), { status: 200 });
  });

  const report = await runStrategyRegression({
    url: 'http://strategy-fixture.invalid',
    scenarios: [byId('clear-center-position'), byId('center-bullet-above-evades-clear-lateral')],
  }).catch((error) => assert.fail(`${error.message}: ${JSON.stringify(error.response)}`));

  assert.deepEqual(calls.map(({ route }) => route), [
    '/api/run/start', '/api/decision', '/api/run/event', '/api/decision', '/api/run/event', '/api/run/end',
  ]);
  assert.deepEqual(events.map(({ event_id, epoch, sequence, tick, sim_ms }) => ({ event_id, epoch, sequence, tick, sim_ms })), [
    { event_id: 1, epoch: 1, sequence: 1, tick: 0, sim_ms: 0 },
    { event_id: 2, epoch: 1, sequence: 2, tick: 1, sim_ms: 1000 / 60 },
  ]);
  assert.equal(calls.at(-1).body.last_event_id, 2);
  assert.equal(calls.at(-1).body.terminal.reason, 'aborted');
  assert.deepEqual(calls.at(-1).body.terminal.qualification_violations, [SCENARIO_VIOLATION]);
  assert.equal(report.cases.length, 2);
  assert.deepEqual(report.failures, []);
});

test('strategy regression manifest is v2 dense-mid-speed and always non-gameplay', () => {
  const { core, manifest } = loadScenarioRuntime();
  assert.equal(manifest.prompt_version, PROMPT_VERSION);
  assert.equal(manifest.context_version, CONTEXT_VERSION);
  assert.equal(manifest.prompt_version, 'djev-authoritative-v2');
  assert.equal(manifest.context_version, 'djev-observation-v2');
  assert.equal(manifest.profile, 'dense-mid-speed');
  assert.deepEqual(manifest.difficulty, DENSE_MID_SPEED_PROFILE);
  assert.equal(manifest.mode, 'cli');
  assert.deepEqual(manifest.metadata, {
    scenario_regression: true,
    qualification_violation: SCENARIO_VIOLATION,
  });
  assert.equal(core.gameStatus(core.createGame(manifest)).lives, 3);
  assert.equal(SCENARIO_VIOLATION, 'scenario_regression_not_gameplay');
});

test('strategy scenarios are portable hand-literal cases covering corners boundaries center far enemy and one blocker', () => {
  assert.equal(STRATEGY_SCENARIOS.length, 16);
  assert.deepEqual(STRATEGY_SCENARIOS.map((scenario) => scenario.id), [
    'corner-top-left-clear',
    'corner-top-right-clear',
    'corner-bottom-left-clear',
    'corner-bottom-right-clear',
    'clear-center-position',
    'center-bullet-above-evades-clear-lateral',
    'left-boundary-outside-recover-after-evade',
    'left-boundary-inside-position',
    'right-boundary-outside-recover',
    'right-boundary-inside-position',
    'top-boundary-outside-recover',
    'top-boundary-inside-position',
    'bottom-boundary-outside-recover',
    'bottom-boundary-inside-position',
    'clear-bottom-with-far-enemy-recovers-up',
    'centerward-bullet-blocks-diagonal-recovery',
  ]);
  for (const scenario of STRATEGY_SCENARIOS) {
    assert.equal(typeof scenario.player.x, 'number', scenario.id);
    assert.equal(typeof scenario.player.y, 'number', scenario.id);
    assert.equal(typeof scenario.expected.intent, 'string', scenario.id);
  }
});

test('center zone is inclusive and boundary pair expectations do not oscillate', () => {
  assert.deepEqual(CENTER_ZONE, { minX: 360, maxX: 600, minY: 230, maxY: 390 });
  for (const point of [{ x: 360, y: 230 }, { x: 600, y: 390 }, { x: 370, y: 310 }, { x: 590, y: 310 }, { x: 480, y: 240 }, { x: 480, y: 380 }]) {
    assert.equal(isInsideCenterZone(point), true, `${JSON.stringify(point)} should be inside`);
  }
  for (const point of [{ x: 350, y: 310 }, { x: 610, y: 310 }, { x: 480, y: 220 }, { x: 480, y: 400 }]) {
    assert.equal(isInsideCenterZone(point), false, `${JSON.stringify(point)} should be outside`);
  }

  assert.equal(byId('left-boundary-outside-recover-after-evade').expected.movement, 'right');
  assert.equal(byId('left-boundary-inside-position').expected.movement, 'hold');
  assert.equal(byId('right-boundary-outside-recover').expected.movement, 'left');
  assert.equal(byId('right-boundary-inside-position').expected.movement, 'hold');
  assert.equal(byId('top-boundary-outside-recover').expected.movement, 'down');
  assert.equal(byId('top-boundary-inside-position').expected.movement, 'hold');
  assert.equal(byId('bottom-boundary-outside-recover').expected.movement, 'up');
  assert.equal(byId('bottom-boundary-inside-position').expected.movement, 'hold');
});

test('four clear corner expectations recover on both axes and increase room', () => {
  assert.deepEqual(byId('corner-top-left-clear').player, { x: 10, y: 9 });
  assert.deepEqual(byId('corner-top-right-clear').player, { x: 950, y: 9 });
  assert.deepEqual(byId('corner-bottom-left-clear').player, { x: 10, y: 611 });
  assert.deepEqual(byId('corner-bottom-right-clear').player, { x: 950, y: 611 });
  for (const id of ['corner-top-left-clear', 'corner-top-right-clear', 'corner-bottom-left-clear', 'corner-bottom-right-clear']) {
    const scenario = byId(id);
    const movement = scenario.expected.movement;
    const moved = applyMovement(scenario.player, movement);
    assert.equal(scenario.expected.intent, 'recover', id);
    assert.equal(movementMovesInward(scenario.player, movement, ['x', 'y']), true, id);
    assert.equal(distanceToCenter(moved) < distanceToCenter(scenario.player), true, id);
    assert.equal(roomScore(moved) > roomScore(scenario.player), true, id);
  }
});

test('clear center is position hold and outside recovery does not stick to prior evade intent', () => {
  const center = byId('clear-center-position');
  assert.equal(isInsideCenterZone(center.player), true);
  assert.deepEqual(center.expected, { intent: 'position', movement: 'hold' });
  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'position', movement: 'hold', fire: 'cease', lease: 'short' }, center).failures, []);

  const recovering = byId('left-boundary-outside-recover-after-evade');
  assert.equal(recovering.last_intent, 'evade');
  assert.equal(recovering.expected.intent, 'recover');
  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'recover', movement: 'right', fire: 'cease', lease: 'short' }, recovering).failures, []);
  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'evade', movement: 'right', fire: 'cease', lease: 'short' }, recovering).failures, ['intent:evade!=recover']);
});

test('center bullet above requires evade with a clear non-hold movement', () => {
  const { core, manifest } = loadScenarioRuntime();
  const scenario = byId('center-bullet-above-evades-clear-lateral');
  const summary = scenarioSummary(core, manifest, scenario);
  const facts = forecastFacts(summary.observed);

  assert.equal(scenario.expected_delay_ms, 0);
  assert.equal(typeof facts.contacts.hold, 'number');
  assert.ok(facts.contacts.hold > 230 && facts.contacts.hold < 250, `hold contact ${facts.contacts.hold}`);
  assert.equal(facts.contacts.left, null);
  assert.equal(facts.contacts.right, null);

  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'evade', movement: 'left', fire: 'cease', lease: 'medium' }, scenario, summary.observed).failures, []);
  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'evade', movement: 'right', fire: 'cease', lease: 'medium' }, scenario, summary.observed).failures, []);
  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'position', movement: 'hold', fire: 'cease', lease: 'medium' }, scenario, summary.observed).failures, [
    'intent:position!=evade',
    'movement:hold:not_allowed',
    'movement:hold:forbidden',
  ]);
});

test('core observations for clear strategy fixtures expose no forecast contacts', () => {
  const { core, manifest } = loadScenarioRuntime();
  for (const scenario of STRATEGY_SCENARIOS.filter((item) => !item.bullets)) {
    const summary = scenarioSummary(core, manifest, scenario);
    const facts = forecastFacts(summary.observed);
    for (const [movement, contact] of Object.entries(facts.contacts)) {
      assert.equal(contact, null, `${scenario.id} ${movement}`);
    }
    const restored = observeScenario(core, core.restoreGame(summary.checkpoint), scenario);
    assert.equal(restored.state.tick, summary.observed.state.tick);
    assert.equal(restored.state.sim_ms, summary.observed.state.sim_ms);
  }
});

test('clear bottom with far enemy has no candidate contact and still expects center recovery upward', () => {
  const { core, manifest } = loadScenarioRuntime();
  const scenario = byId('clear-bottom-with-far-enemy-recovers-up');
  const summary = scenarioSummary(core, manifest, scenario);
  const facts = forecastFacts(summary.observed);
  assert.equal(summary.observed.forecast.prefix.contact_ms, null);
  assert.deepEqual(Object.values(facts.contacts), Array(9).fill(null));
  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'recover', movement: 'up', fire: 'cease', lease: 'medium' }, scenario, summary.observed).failures, []);
  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'recover', movement: 'down', fire: 'cease', lease: 'medium' }, scenario, summary.observed).failures, ['movement:down!=up', 'distance_center_not_decreased']);
  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'recover', movement: 'hold', fire: 'cease', lease: 'medium' }, scenario, summary.observed).failures, ['movement:hold!=up', 'distance_center_not_decreased']);
});

test('centerward moving bullet blocks diagonal recovery while right and down remain clear alternatives', () => {
  const { core, manifest } = loadScenarioRuntime();
  const scenario = byId('centerward-bullet-blocks-diagonal-recovery');
  const summary = scenarioSummary(core, manifest, scenario);
  const facts = forecastFacts(summary.observed);

  assert.equal(summary.observed.forecast.prefix.contact_ms, null);
  assert.equal(facts.contacts.right, null);
  assert.equal(facts.contacts.down, null);
  assert.equal(typeof facts.contacts.down_right, 'number');
  assert.ok(facts.contacts.down_right > 40 && facts.contacts.down_right < 100, `down_right contact ${facts.contacts.down_right}`);

  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'recover', movement: 'right', fire: 'cease', lease: 'short' }, scenario, summary.observed).failures, []);
  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'recover', movement: 'down', fire: 'cease', lease: 'short' }, scenario, summary.observed).failures, []);
  assert.deepEqual(evaluateChoiceAgainstScenario({ intent: 'recover', movement: 'down_right', fire: 'cease', lease: 'short' }, scenario, summary.observed).failures, ['movement:down_right:not_allowed', 'movement:down_right:forbidden']);
});
