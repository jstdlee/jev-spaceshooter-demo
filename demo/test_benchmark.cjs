const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CONTEXT_VERSION,
  BENCHMARK_PROFILES,
  DENSE_MID_SPEED_PROFILE,
  EventBatcher,
  HARDEST_PROFILE,
  PROMPT_VERSION,
  activeCommandForObservation,
  archiveEngineHtmlSnapshot,
  buildDeathWindowReport,
  buildRecordedCommandSpans,
  buildManifest,
  buildObservationContext,
  buildTraceReport,
  classifyVerdict,
  checkpointFromRecord,
  compactHitForObservation,
  compareReplayState,
  computeDueTicks,
  hashSourcePair,
  loadSpaceModulesFromHtml,
  nextDecisionAllowedWallMs,
  readJsonlRecords,
  recentHitsForObservation,
  replayTrace,
  runLiveBenchmark,
  summarizeTraceRecords,
} = require('./benchmark.cjs');

test('source hash uses exact core newline controller capture bytes', () => {
  assert.equal(
    hashSourcePair('core-source', 'controller-source'),
    'ae01b095cdaccdcc47d997c1424cc3dc70a5824950655836d40bab096df1a6f5',
  );
});

test('manifest pins versions, hardest profile, fixed step, and gameplay rules', () => {
  const manifest = buildManifest({
    seed: 20260920,
    profile: 'hardest',
    difficulty: HARDEST_PROFILE,
    engineHash: 'a'.repeat(64),
    engineVersion: 'engine-test',
    mode: 'cli',
  });
  assert.equal(manifest.seed, 20260920);
  assert.equal(manifest.profile, 'hardest');
  assert.equal(manifest.engine_hash, 'a'.repeat(64));
  assert.equal(manifest.engine_version, 'engine-test');
  assert.equal(manifest.prompt_version, PROMPT_VERSION);
  assert.equal(manifest.context_version, CONTEXT_VERSION);
  assert.equal(manifest.dt_ms, 1000 / 60);
  assert.deepEqual(manifest.difficulty, HARDEST_PROFILE);
  assert.equal(manifest.rules.player_lives, 3);
  assert.equal(manifest.rules.player_speed_px_s, 112);
  assert.equal(manifest.rules.shot_cooldown_s, 0.17);
  assert.equal(manifest.rules.enemy_fire_baseline_s, 0.95);
  assert.equal(manifest.rules.hardest_enemy_fire_interval_s, 0.2375);
});

test('manifest uses provided core RULES exactly when supplied', () => {
  const rules = { arena: { width: 960, height: 620 }, leases_ticks: { short: 15, medium: 30 }, prng: 'xorshift32-v1' };
  const manifest = buildManifest({
    seed: 20260920,
    profile: 'hardest',
    difficulty: HARDEST_PROFILE,
    engineHash: 'b'.repeat(64),
    engineVersion: 'engine-test',
    mode: 'cli',
    rules,
  });
  assert.deepEqual(manifest.rules, rules);
  assert.equal(Object.hasOwn(manifest.rules, 'player_speed_px_s'), false);
});

test('dense-mid-speed profile is truthful 1.7x speed and hardest remains unchanged', () => {
  assert.deepEqual(BENCHMARK_PROFILES.hardest, HARDEST_PROFILE);
  assert.equal(BENCHMARK_PROFILES.hardest.fastBulletSpeed, 2.4);
  assert.deepEqual(BENCHMARK_PROFILES['dense-mid-speed'], DENSE_MID_SPEED_PROFILE);
  assert.deepEqual(DENSE_MID_SPEED_PROFILE, {
    bulletDensity: 4,
    enemyDensity: 3,
    fastBulletRatio: 0.85,
    fastBulletSpeed: 1.7,
  });
  const manifest = buildManifest({
    seed: 20260920,
    profile: 'dense-mid-speed',
    difficulty: DENSE_MID_SPEED_PROFILE,
    engineHash: 'c'.repeat(64),
    engineVersion: 'engine-test',
    mode: 'cli',
  });
  assert.equal(manifest.profile, 'dense-mid-speed');
  assert.equal(manifest.difficulty.fastBulletSpeed, 1.7);
});

test('event batching retries durable batches with original event IDs and drains before end', async () => {
  const posts = [];
  let failFirst = true;
  const batcher = new EventBatcher({
    runId: 'run-1',
    postJson: async (path, body) => {
      posts.push({ path, body });
      if (path === '/api/run/event' && failFirst) {
        failFirst = false;
        throw new Error('offline');
      }
      if (path === '/api/run/event') {
        return { schema_version: 1, run_id: body.run_id, acked_event_id: body.events.at(-1).event_id };
      }
      return { schema_version: 1, run_id: body.run_id, complete: true, trace_path: '/tmp/trace.jsonl', summary: {} };
    },
    mirrorLogger: { append: async () => {}, close: async () => {} },
    batchSize: 2,
  });
  batcher.enqueue({ epoch: 1, sequence: null, tick: 0, sim_ms: 0, wall_ms: 0, type: 'checkpoint', payload: { hash: 'h0' } });
  batcher.enqueue({ epoch: 1, sequence: 1, tick: 1, sim_ms: 16.7, wall_ms: 17, type: 'response_received', payload: { decision_id: 'd1' } });
  await batcher.flush();
  assert.equal(batcher.ackedEventId, 0);
  await batcher.drain();
  assert.deepEqual(posts.filter((post) => post.path === '/api/run/event').map((post) => post.body.events.map((event) => event.event_id)), [[1, 2], [1, 2]]);
  const ended = await batcher.endRun({ reason: 'target', tick: 2, sim_ms: 33.4, wall_ms: 35, lives: 3, wave: 1, score: 0, qualification_violations: [] });
  assert.equal(ended.complete, true);
  assert.equal(posts.at(-1).path, '/api/run/end');
  assert.equal(posts.at(-1).body.last_event_id, 2);
});

test('engine HTML snapshots are archived by source hash without overwriting existing valid archives', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-engine-archive-'));
  const html = [
    '<!doctype html><html><body>',
    '<script id="space-decision-core">core bytes</script>',
    '<script id="space-djev-controller">controller bytes</script>',
    '</body></html>',
  ].join('');
  const engineHash = hashSourcePair('core bytes', 'controller bytes');
  const archivedPath = await archiveEngineHtmlSnapshot({ outDir, engineHash, html });
  assert.equal(archivedPath, path.join(outDir, 'engines', `${engineHash}.html`));
  assert.equal(fs.readFileSync(archivedPath, 'utf8'), html);

  const sentinelHtml = html.replace('</body>', '<!-- keep first archive --></body>');
  fs.writeFileSync(archivedPath, sentinelHtml);
  const archivedAgain = await archiveEngineHtmlSnapshot({ outDir, engineHash, html });
  assert.equal(archivedAgain, archivedPath);
  assert.equal(fs.readFileSync(archivedPath, 'utf8'), sentinelHtml);
});

test('engine HTML archive refuses an existing file with the wrong inline source hash', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-engine-archive-bad-'));
  const engineHash = hashSourcePair('core bytes', 'controller bytes');
  const archiveDir = path.join(outDir, 'engines');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, `${engineHash}.html`), [
    '<!doctype html><html><body>',
    '<script id="space-decision-core">other core</script>',
    '<script id="space-djev-controller">controller bytes</script>',
    '</body></html>',
  ].join(''));

  await assert.rejects(
    archiveEngineHtmlSnapshot({
      outDir,
      engineHash,
      html: [
        '<!doctype html><html><body>',
        '<script id="space-decision-core">core bytes</script>',
        '<script id="space-djev-controller">controller bytes</script>',
        '</body></html>',
      ].join(''),
    }),
    /engine archive hash mismatch/,
  );
});

test('live runner waits for terminal-pending transport and logs late reply before run end', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-terminal-pending-'));
  const calls = [];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const postJson = async (route, body) => {
    calls.push({ route, body: clone(body) });
    if (route === '/api/run/start') {
      return { schema_version: 1, run_id: 'run-terminal-pending', prompt_version: PROMPT_VERSION, prompt_hash: 'prompt-hash', trace_path: null };
    }
    if (route === '/api/decision') {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        schema_version: 1,
        run_id: body.run_id,
        epoch: body.epoch,
        sequence: body.sequence,
        decision_id: `late-decision-${body.sequence}`,
        movement: 'up',
        fire: 'shoot',
        lease: 'medium',
        valid_choice: true,
        api_ok: true,
        latency_ms: 120,
        usage: { input_tokens: 10, output_tokens: 3 },
        confidence: { movement: 0.9, fire: 0.9, lease: 0.9 },
      };
    }
    if (route === '/api/run/event') {
      return { schema_version: 1, run_id: body.run_id, acked_event_id: body.events.at(-1).event_id };
    }
    if (route === '/api/run/end') {
      return { schema_version: 1, run_id: body.run_id, complete: true, trace_path: null, summary: {} };
    }
    throw new Error(`unexpected route ${route}`);
  };

  const result = await runLiveBenchmark({
    seed: 20260920,
    profile: 'dense-mid-speed',
    targetSeconds: 0.05,
    htmlPath: path.join(__dirname, 'space-shooter.html'),
    outDir,
    maxLagMs: 250,
    postJson,
  });

  assert.equal(result.terminal.reason, 'target');
  assert.equal(result.terminal.lives > 0, true);
  assert.equal(result.terminal.wall_ms < 100, true);
  assert.equal(result.verdict.qualifies, false);
  assert.equal(result.authoritative_trace_source, 'client_mirror');
  assert.equal(result.backend_trace_resolved, false);
  assert.ok(result.verdict.violations.includes('missing_backend_trace'));

  const routeOrder = calls.map((call) => call.route);
  assert.equal(routeOrder.at(-1), '/api/run/end');
  const decisionIndex = routeOrder.indexOf('/api/decision');
  const endIndex = routeOrder.indexOf('/api/run/end');
  assert.ok(decisionIndex >= 0 && decisionIndex < endIndex);

  const events = calls
    .filter((call) => call.route === '/api/run/event')
    .flatMap((call) => call.body.events);
  const terminalEvent = events.find((event) => event.type === 'terminal');
  const lateRejection = events.find((event) => event.type === 'response_rejected' && event.payload.reason === 'terminal');
  assert.ok(terminalEvent);
  assert.notEqual(terminalEvent.tick % 60, 0);
  const terminalCheckpoint = events.find((event) => event.type === 'checkpoint' && event.tick === terminalEvent.tick);
  assert.ok(terminalCheckpoint, 'non-60-tick target stops must emit a final checkpoint');
  assert.equal(terminalCheckpoint.payload.critical, true);
  for (const field of ['tick', 'sim_ms', 'lives', 'wave', 'score']) {
    assert.equal(terminalCheckpoint.payload.status[field], terminalEvent.payload[field], field);
    assert.equal(calls.at(-1).body.terminal[field], terminalEvent.payload[field], field);
  }
  assert.ok(terminalCheckpoint.event_id < terminalEvent.event_id);
  assert.deepEqual(result.replay_mismatches, []);
  assert.equal(result.replay_numeric_tolerance, 1e-9);
  assert.deepEqual(result.replay_tolerated_roundoff, []);
  assert.ok(lateRejection);
  assert.equal(lateRejection.payload.decision_id, 'late-decision-1');
  assert.equal(lateRejection.payload.api_ok, true);
  assert.equal(lateRejection.payload.valid_choice, true);
  assert.equal(lateRejection.payload.terminal_tick, terminalEvent.tick);
  assert.equal(terminalEvent.wall_ms, result.terminal.wall_ms);
  assert.ok(lateRejection.wall_ms > terminalEvent.wall_ms);
  assert.equal(calls.findIndex((call) => call.route === '/api/run/end') > calls.findIndex((call) => call.route === '/api/run/event' && call.body.events.some((event) => event.event_id === lateRejection.event_id)), true);
});

test('offline CLI death emits a final checkpoint after the engine terminal and before run end', { timeout: 15000 }, async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-terminal-death-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const events = [];
  let ended = null;
  const result = await runLiveBenchmark({
    seed: 20260920,
    profile: 'dense-mid-speed',
    targetSeconds: 10,
    htmlPath: path.join(__dirname, 'space-shooter.html'),
    outDir,
    maxLagMs: 250,
    postJson: async (route, body) => {
      if (route === '/api/run/start') return { schema_version: 1, run_id: 'run-offline-death', trace_path: null };
      if (route === '/api/decision') throw new Error('offline fixture: no model transport');
      if (route === '/api/run/event') {
        events.push(...body.events);
        return { schema_version: 1, run_id: body.run_id, acked_event_id: body.events.at(-1).event_id };
      }
      if (route === '/api/run/end') {
        ended = body;
        return { schema_version: 1, run_id: body.run_id, complete: true, trace_path: null };
      }
      throw new Error(`unexpected route ${route}`);
    },
  });
  assert.equal(result.terminal.reason, 'death');
  assert.equal(result.terminal.lives, 0);
  assert.notEqual(result.terminal.tick % 60, 0);
  const finalCheckpoint = events.filter((event) => event.type === 'checkpoint').at(-1);
  const terminals = events.filter((event) => event.type === 'terminal');
  assert.ok(finalCheckpoint.event_id > terminals[0].event_id, 'persist the final checkpoint after processing engine death events');
  assert.ok(finalCheckpoint.event_id < terminals.at(-1).event_id);
  assert.equal(finalCheckpoint.payload.critical, true);
  for (const field of ['tick', 'sim_ms', 'lives', 'wave', 'score']) {
    assert.equal(finalCheckpoint.payload.status[field], result.terminal[field], field);
    assert.equal(ended.terminal[field], result.terminal[field], field);
  }
  assert.deepEqual(result.replay_mismatches, []);
});

test('fixed-step scheduler keeps clock independent and flags lag over the qualification cap', () => {
  assert.deepEqual(computeDueTicks({ nowMs: 1000, nextTickWallMs: 1000, dtMs: 1000 / 60, maxLagMs: 250 }), { dueTicks: 1, lagMs: 0, lagInvalid: false });
  assert.deepEqual(computeDueTicks({ nowMs: 1250, nextTickWallMs: 1000, dtMs: 1000 / 60, maxLagMs: 250 }), { dueTicks: 16, lagMs: 250, lagInvalid: false });
  assert.deepEqual(computeDueTicks({ nowMs: 1251, nextTickWallMs: 1000, dtMs: 1000 / 60, maxLagMs: 250 }), { dueTicks: 16, lagMs: 251, lagInvalid: true });
});

test('transport failures schedule capped decision retry backoff while the fixed clock can continue', () => {
  assert.equal(nextDecisionAllowedWallMs({ backoffMs: 0 }, 1200), 1200);
  assert.equal(nextDecisionAllowedWallMs({ backoffMs: 100 }, 1200), 1300);
  assert.equal(nextDecisionAllowedWallMs({ backoffMs: 800 }, 1200), 2000);
});

test('active command observation reports factual remaining lease and latency fields', () => {
  const { core, engineHash } = loadSpaceModulesFromHtml(path.join(__dirname, 'space-shooter.html'));
  const game = core.createGame(buildManifest({
    seed: 20260920,
    profile: 'hardest',
    difficulty: core.HARDEST_DIFFICULTY,
    engineHash,
    engineVersion: core.ENGINE_VERSION,
    mode: 'cli',
    rules: core.RULES,
  }));
  const active = activeCommandForObservation({
    decision_id: 'decision-current',
    sequence: 2,
    movement: 'up',
    fire: 'shoot',
    lease: 'medium',
    intent: 'recover',
    start_tick: 25,
    end_tick: 55,
    applied_wall_ms: 416.6667,
    expires_wall_ms: 916.6667,
  }, 26, 433.3334);
  assert.equal(active.movement, 'up');
  assert.equal(active.fire, 'shoot');
  assert.equal(active.intent, 'recover');
  assert.ok(active.remaining_ms > 480 && active.remaining_ms < 484);

  const observed = core.observeGame(game, {
    expected_delay_ms: 410,
    latency_samples: 3,
    latency_spread_ms: 92,
    active_command: active,
    recent_commands: [],
    recent_hits: [],
  });
  assert.equal(observed.state.active_command.remaining_ms, 483.3);
  assert.equal(observed.forecast.prefix.authorized_remaining_ms, 483.3);
  assert.equal(observed.forecast.latency_samples, 3);
  assert.equal(observed.forecast.latency_spread_ms, 92);
  assert.equal(activeCommandForObservation({ ...active, end_tick: 55, expires_wall_ms: 900 }, 55, 900).remaining_ms, 0);
});

test('observation context propagates last applied intent and intent-bearing action history', () => {
  const context = buildObservationContext({
    control: { lastAppliedIntent: 'recover' },
    stats: { expected_delay_ms: 260, latency_samples: 3, latency_spread_ms: 40 },
    activeCommand: { movement: 'right', fire: 'cease', lease: 'short', intent: 'recover', remaining_ms: 100 },
    recentCommands: [
      { movement: 'left', fire: 'cease', lease: 'short', intent: 'evade', elapsed_ms: 250, dx: -28, dy: 0, source: 'djev' },
      { movement: 'right', fire: 'cease', lease: 'medium', intent: 'recover', elapsed_ms: 500, dx: 56, dy: 0, source: 'djev' },
    ],
    recentHits: [],
    currentSimMs: 5000,
  });
  assert.equal(context.last_intent, 'recover');
  assert.equal(context.last_applied_intent, 'recover');
  assert.equal(context.lastAppliedIntent, 'recover');
  assert.equal(context.active_command.intent, 'recover');
  assert.deepEqual(context.recent_commands.map((command) => command.intent), ['evade', 'recover']);
});

test('actual hit payloads are compacted before entering observation history', () => {
  const hitEvent = {
    type: 'hit',
    tick: 129,
    sim_ms: 2150,
    payload: {
      after_lives: 2,
      before_lives: 3,
      player: { lives: 2, x: 444.3618182281978, y: 370.6284848948639 },
      source: { h: 8, id: 'ebullet-26', kind: 'bullet', vx: 144.47899156204195, vy: 378.9949617042625, w: 8, x: 431.84384074005214, y: 370.34420595990184 },
    },
  };
  const compact = compactHitForObservation(hitEvent, 2500);
  assert.deepEqual(compact, {
    sim_ms: 2150,
    kind: 'bullet',
    x: 431.84384074005214,
    y: 370.34420595990184,
    vx: 144.47899156204195,
    vy: 378.9949617042625,
    lives_after: 2,
    ago_ms: 350,
  });
  assert.equal(Object.hasOwn(compact, 'source'), false);
  assert.equal(Object.hasOwn(compact, 'after_lives'), false);

  const recent = recentHitsForObservation([
    { sim_ms: -3000, kind: 'bullet', x: 1, y: 1, vx: 0, vy: 0, lives_after: 3 },
    compact,
  ], 2500);
  assert.deepEqual(recent, [compact]);

  const { core, engineHash } = loadSpaceModulesFromHtml(path.join(__dirname, 'space-shooter.html'));
  const game = core.createGame(buildManifest({
    seed: 20260920,
    profile: 'hardest',
    difficulty: core.HARDEST_DIFFICULTY,
    engineHash,
    engineVersion: core.ENGINE_VERSION,
    mode: 'cli',
    rules: core.RULES,
  }));
  game.tick = 150;
  game.sim_ms = 2500;
  const observed = core.observeGame(game, {
    expected_delay_ms: 260,
    active_command: null,
    recent_commands: [],
    recent_hits: recent,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(observed.state.recent_hits)), [{
    ago_ms: 350,
    kind: 'bullet',
    x: 431.8,
    y: 370.3,
    vx: 144.5,
    vy: 379,
    lives_after: 2,
  }]);
});

test('qualification verdict rejects exact target, death, lag, mocks, incomplete traces, and replay mismatch', () => {
  const good = {
    reason: 'target',
    tick: 7261,
    sim_ms: 121016.7,
    wall_ms: 121100,
    lives: 1,
    trace_complete: true,
    replay_ok: true,
    engine_hash_ok: true,
    source: 'live',
    backend_trace_resolved: true,
    profile: 'hardest',
    difficulty: HARDEST_PROFILE,
    qualification_violations: [],
  };
  assert.equal(classifyVerdict(good).qualifies, true);
  assert.equal(classifyVerdict(good).qualifies_hardest, true);
  for (const bad of [
    { sim_ms: 120000 },
    { wall_ms: 120000 },
    { lives: 0, reason: 'death' },
    { trace_complete: false },
    { replay_ok: false },
    { engine_hash_ok: false },
    { source: 'mock' },
    { qualification_violations: ['scheduling_lag'] },
  ]) {
    const verdict = classifyVerdict({ ...good, ...bad });
    assert.equal(verdict.qualifies, false);
    assert.ok(verdict.violations.length > 0);
  }
});

test('missing resolved backend trace blocks live qualification even when local mirror replay passes', () => {
  const verdict = classifyVerdict({
    reason: 'target',
    tick: 7261,
    sim_ms: 121016.7,
    wall_ms: 121100,
    lives: 1,
    trace_complete: true,
    replay_ok: true,
    engine_hash_ok: true,
    source: 'live',
    authoritative_trace_source: 'client_mirror',
    profile: 'hardest',
    difficulty: HARDEST_PROFILE,
    qualification_violations: [],
  });
  assert.equal(verdict.qualifies, false);
  assert.equal(verdict.qualifies_hardest, false);
  assert.equal(verdict.profile, 'hardest');
  assert.deepEqual(verdict.difficulty, HARDEST_PROFILE);
  assert.ok(verdict.violations.includes('missing_backend_trace'));
});

test('dense-mid-speed qualification is scoped to declared profile and not labeled hardest', () => {
  const verdict = classifyVerdict({
    reason: 'target',
    tick: 7261,
    sim_ms: 121016.7,
    wall_ms: 121100,
    lives: 1,
    trace_complete: true,
    replay_ok: true,
    engine_hash_ok: true,
    source: 'live',
    backend_trace_resolved: true,
    profile: 'dense-mid-speed',
    difficulty: DENSE_MID_SPEED_PROFILE,
    qualification_violations: [],
  });
  assert.equal(verdict.qualifies, true);
  assert.equal(verdict.qualified_profile, 'dense-mid-speed');
  assert.equal(verdict.qualifies_hardest, false);
  assert.equal(verdict.profile, 'dense-mid-speed');
  assert.deepEqual(verdict.difficulty, DENSE_MID_SPEED_PROFILE);
  assert.deepEqual(verdict.violations, []);
});

test('declared profile parameters must match manifest difficulty before qualifying', () => {
  const verdict = classifyVerdict({
    reason: 'target',
    tick: 7261,
    sim_ms: 121016.7,
    wall_ms: 121100,
    lives: 1,
    trace_complete: true,
    replay_ok: true,
    engine_hash_ok: true,
    source: 'live',
    backend_trace_resolved: true,
    profile: 'hardest',
    difficulty: DENSE_MID_SPEED_PROFILE,
    qualification_violations: [],
  });
  assert.equal(verdict.qualifies, false);
  assert.equal(verdict.qualifies_hardest, false);
  assert.ok(verdict.violations.includes('profile_difficulty_mismatch'));
});

test('death report reaches at least 10 seconds and six decisions before terminal event', () => {
  const records = [];
  for (let i = 0; i < 20; i += 1) {
    records.push({ event_id: i + 1, tick: i * 30, sim_ms: i * 500, wall_ms: i * 500, type: 'response_received', payload: { decision_id: `d${i}`, normalized: { movement: 'hold', fire: 'cease', lease: 'short' } } });
  }
  records.push({ event_id: 30, tick: 610, sim_ms: 10166.7, wall_ms: 10180, type: 'hit', payload: { before: { lives: 1 }, after: { lives: 0 }, active_command: null } });
  records.push({ event_id: 31, tick: 611, sim_ms: 10183.4, wall_ms: 10200, type: 'terminal', payload: { reason: 'death', lives: 0 } });
  const report = buildDeathWindowReport(records);
  assert.equal(report.reason, 'death');
  assert.ok(report.window_start_sim_ms <= 183.4);
  assert.ok(report.decisions.length >= 6);
  assert.ok(report.events.some((event) => event.type === 'hit'));
});

test('death report joins backend API footprints by distinct decision IDs without top-level sim_ms', () => {
  const records = [{ record_type: 'run_started', engine_source_hash: 'abc', manifest: { engine_hash: 'abc' } }];
  const decisionTimes = [2500, 5000, 7600, 10100, 12500, 15000, 17500, 19800];
  for (const [index, simMs] of decisionTimes.entries()) {
    const sequence = index + 1;
    const decisionId = `run-unit-e1-s${sequence}-decision`;
    records.push({
      record_type: 'decision_request',
      decision_id: decisionId,
      epoch: 1,
      sequence,
      snapshot_tick: Math.round(simMs / (1000 / 60)),
      rawsnapshot: { state: { sim_ms: simMs }, checkpoint_hash: `hash-${sequence}` },
      exactactualpayload: { state: { context: { sim_ms: simMs }, candidates: [] }, questions: { path: {}, fire: {} } },
    });
    records.push({
      record_type: 'decision_response',
      decision_id: decisionId,
      epoch: 1,
      sequence,
      normalized: { api_ok: true, valid_choice: true, movement: 'up', fire: 'shoot', lease: 'medium' },
      rawupstreamresponse: { status: 200, parsed: { answers: { path: { choice: 'up__medium' }, fire: { choice: 'shoot' } } }, body: `raw-${sequence}` },
    });
    records.push({
      type: 'response_received',
      tick: Math.round((simMs + 350) / (1000 / 60)),
      sim_ms: simMs + 350,
      wall_ms: simMs + 360,
      payload: { decision_id: decisionId, sequence, api_ok: true, valid_choice: true, normalized: { movement: 'up', fire: 'shoot', lease: 'medium' } },
    });
    records.push({
      type: 'command_applied',
      tick: Math.round((simMs + 400) / (1000 / 60)),
      sim_ms: simMs + 400,
      wall_ms: simMs + 410,
      payload: { command: { decision_id: decisionId, sequence, movement: 'up', fire: 'shoot', lease: 'medium', start_tick: sequence * 100, end_tick: sequence * 100 + 30 } },
    });
    if (sequence === 7) {
      records.push({ type: 'shot', tick: 1060, sim_ms: 17666.7, wall_ms: 17670, payload: { decision_id: decisionId, entity_id: 'pshot-window' } });
    }
    if (sequence === 8) {
      records.push({ type: 'hit', tick: 1195, sim_ms: 19916.7, wall_ms: 19920, payload: { active_decision_id: decisionId, source: { kind: 'bullet' }, after_lives: 0 } });
    }
  }
  const pendingId = 'run-unit-e1-s9-pending-terminal';
  records.push({
    record_type: 'decision_request',
    decision_id: pendingId,
    epoch: 1,
    sequence: 9,
    snapshot_tick: Math.round(20800 / (1000 / 60)),
    rawsnapshot: { state: { sim_ms: 20800 }, checkpoint_hash: 'hash-9' },
    exactactualpayload: { state: { context: { sim_ms: 20800 }, candidates: [] }, questions: { path: {}, fire: {} } },
  });
  records.push({ type: 'terminal', tick: 1260, sim_ms: 21000, wall_ms: 21020, payload: { reason: 'death', tick: 1260, sim_ms: 21000, wall_ms: 21020, lives: 0, wave: 1, score: 84, qualification_violations: [] } });
  records.push({
    record_type: 'decision_response',
    decision_id: pendingId,
    epoch: 1,
    sequence: 9,
    normalized: { api_ok: true, valid_choice: true, movement: 'left', fire: 'cease', lease: 'short' },
    rawupstreamresponse: { status: 200, parsed: { answers: { path: { choice: 'left__short' }, fire: { choice: 'cease' } } }, body: 'raw-pending-after-terminal' },
  });
  records.push({ type: 'response_rejected', tick: 1260, sim_ms: 21000, wall_ms: 21300, payload: { decision_id: pendingId, sequence: 9, reason: 'terminal' } });

  const report = buildDeathWindowReport(records);
  assert.equal(report.window_end_sim_ms, 21000);
  assert.equal(report.window_start_sim_ms, 10100);
  assert.deepEqual(report.api_footprints.map((footprint) => footprint.decision_id), [
    'run-unit-e1-s4-decision',
    'run-unit-e1-s5-decision',
    'run-unit-e1-s6-decision',
    'run-unit-e1-s7-decision',
    'run-unit-e1-s8-decision',
    pendingId,
  ]);
  assert.equal(new Set(report.api_footprints.map((footprint) => footprint.decision_id)).size, report.api_footprints.length);
  const first = report.api_footprints[0];
  assert.equal(first.request.rawsnapshot.state.sim_ms, 10100);
  assert.equal(first.response.rawupstreamresponse.body, 'raw-4');
  assert.equal(first.normalized.movement, 'up');
  const shotFootprint = report.api_footprints.find((footprint) => footprint.decision_id === 'run-unit-e1-s7-decision');
  assert.equal(shotFootprint.execution.shots[0].payload.entity_id, 'pshot-window');
  const hitFootprint = report.api_footprints.find((footprint) => footprint.decision_id === 'run-unit-e1-s8-decision');
  assert.equal(hitFootprint.execution.hits[0].payload.after_lives, 0);
  const pending = report.api_footprints.at(-1);
  assert.equal(pending.response.rawupstreamresponse.body, 'raw-pending-after-terminal');
  assert.equal(pending.execution.response_events[0].payload.reason, 'terminal');
});

test('API footprint metadata keeps backend decision sequence when later execution events use global sequence', () => {
  const decisionId = 'run-20260920T040740Z-wqQCAfryYps-e2-s237-decision';
  const records = [
    {
      record_type: 'decision_request',
      decision_id: decisionId,
      epoch: 2,
      sequence: 237,
      snapshot_tick: 1200,
      rawsnapshot: { state: { sim_ms: 20000 } },
      exactactualpayload: { state: { context: { sim_ms: 20000 }, candidates: [] } },
    },
    {
      record_type: 'decision_response',
      decision_id: decisionId,
      epoch: 2,
      sequence: 237,
      normalized: { api_ok: true, valid_choice: true, movement: 'up', fire: 'cease', lease: 'medium' },
      rawupstreamresponse: { parsed: { answers: { path: { choice: 'up__medium' }, fire: { choice: 'cease' } } } },
    },
    {
      type: 'command_applied',
      tick: 1201,
      sim_ms: 20016.7,
      wall_ms: 20030,
      payload: { command: { decision_id: decisionId, sequence: 237, movement: 'up', fire: 'cease', lease: 'medium' } },
    },
    {
      type: 'hit',
      epoch: 9,
      sequence: 239,
      tick: 1210,
      sim_ms: 20166.7,
      wall_ms: 20180,
      payload: { active_decision_id: decisionId, sequence: 239, source: { kind: 'bullet' }, after_lives: 0 },
    },
    {
      type: 'terminal',
      tick: 1220,
      sim_ms: 20333.3,
      wall_ms: 20350,
      payload: { reason: 'death', tick: 1220, sim_ms: 20333.3, wall_ms: 20350, lives: 0, wave: 1, score: 100, qualification_violations: [] },
    },
  ];

  const report = buildDeathWindowReport(records);
  const footprint = report.api_footprints.find((item) => item.decision_id === decisionId);
  assert.equal(footprint.epoch, 2);
  assert.equal(footprint.sequence, 237);
  assert.equal(footprint.execution.hits[0].sequence, 239);
  assert.equal(footprint.execution.hits[0].payload.active_decision_id, decisionId);
});

test('report helper compares supplied HTML hash and marks report verdict as not live', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-report-cli-'));
  const tracePath = path.join(tempDir, 'events.jsonl');
  const records = [
    { record_type: 'run_started', engine_source_hash: '0'.repeat(64), manifest: { engine_hash: '0'.repeat(64) } },
    { type: 'terminal', tick: 1, sim_ms: 16.7, wall_ms: 20, payload: { reason: 'death', tick: 1, sim_ms: 16.7, wall_ms: 20, lives: 0, wave: 1, score: 0, qualification_violations: [] } },
  ];
  fs.writeFileSync(tracePath, records.map((record) => JSON.stringify(record)).join('\n'));
  const report = buildTraceReport({ tracePath, htmlPath: path.join(__dirname, 'space-shooter.html') });
  assert.equal(report.summary.engine_hash_ok, false);
  assert.equal(report.verdict.qualifies, false);
  assert.ok(report.verdict.violations.includes('engine_hash_mismatch'));
  assert.ok(report.verdict.violations.includes('not_live_source'));
});

test('trace summary compares applied commands and shots with persisted backend normalized API decisions', () => {
  const summary = summarizeTraceRecords([
    { record_type: 'run_started', engine_source_hash: 'abc', manifest: { engine_hash: 'abc' } },
    { record_type: 'decision_response', decision_id: 'd1', normalized: { api_ok: true, valid_choice: true, movement: 'left', fire: 'shoot', lease: 'short' }, rawupstreamresponse: { parsed: { answers: { movement: { choice: 'left' }, fire: { choice: 'shoot' }, lease: { choice: 'short' } } } } },
    { type: 'command_applied', payload: { decision_id: 'd1', movement: 'left', fire: 'shoot', lease: 'short', start_tick: 1, end_tick: 16 } },
    { type: 'shot', decision_id: 'd1' },
    { type: 'checkpoint', payload: { tick: 60, state_hash: 'h60' } },
  ], { expectedEngineHash: 'abc' });
  assert.equal(summary.engine_hash_ok, true);
  assert.deepEqual(summary.command_decision_mismatches, []);
  assert.deepEqual(summary.decision_response_mismatches, []);
  assert.deepEqual(summary.missing_shot_authorizations, []);
  assert.equal(summary.api_decisions, 1);

  const bad = summarizeTraceRecords([
    { record_type: 'decision_response', decision_id: 'd2', normalized: { api_ok: true, valid_choice: true, movement: 'right', fire: 'cease', lease: 'medium' }, rawupstreamresponse: { parsed: { answers: { movement: { choice: 'right' }, fire: { choice: 'cease' }, lease: { choice: 'medium' } } } } },
    { type: 'command_applied', payload: { decision_id: 'd2', movement: 'right', fire: 'shoot', lease: 'medium', start_tick: 2, end_tick: 32 } },
  ], { expectedEngineHash: 'abc' });
  assert.deepEqual(bad.command_decision_mismatches, [{
    decision_id: 'd2',
    expected: { movement: 'right', fire: 'cease', lease: 'medium' },
    actual: { movement: 'right', fire: 'shoot', lease: 'medium' },
  }]);
});

test('trace summary accepts new backend path+fire raw choice as exact normalized authority', () => {
  const summary = summarizeTraceRecords([
    { record_type: 'run_started', engine_source_hash: 'abc', manifest: { engine_hash: 'abc' } },
    {
      record_type: 'decision_response',
      decision_id: 'd-path',
      normalized: { api_ok: true, valid_choice: true, movement: 'up_left', fire: 'shoot', lease: 'medium' },
      rawupstreamresponse: {
        parsed: {
          answers: {
            path: { choice: 'up_left__medium' },
            fire: { choice: 'shoot' },
          },
        },
      },
    },
    { type: 'command_applied', payload: { command: { decision_id: 'd-path', movement: 'up_left', fire: 'shoot', lease: 'medium', start_tick: 10, end_tick: 40 } } },
    { type: 'shot', payload: { decision_id: 'd-path' } },
  ], { expectedEngineHash: 'abc' });
  assert.equal(summary.api_decisions, 1);
  assert.deepEqual(summary.decision_response_mismatches, []);
  assert.deepEqual(summary.command_decision_mismatches, []);
  assert.deepEqual(summary.missing_shot_authorizations, []);
});

test('trace summary accepts v2 backend intent raw choice as exact normalized authority', () => {
  const summary = summarizeTraceRecords([
    { record_type: 'run_started', engine_source_hash: 'abc', manifest: { engine_hash: 'abc', profile: 'hardest', difficulty: HARDEST_PROFILE } },
    {
      record_type: 'decision_response',
      decision_id: 'd-intent',
      normalized: { api_ok: true, valid_choice: true, movement: 'right', fire: 'cease', lease: 'short', intent: 'recover' },
      rawupstreamresponse: {
        parsed: {
          answers: {
            path: { choice: 'right__short' },
            fire: { choice: 'cease' },
            intent: { choice: 'recover' },
          },
        },
      },
    },
    { type: 'command_applied', payload: { command: { decision_id: 'd-intent', movement: 'right', fire: 'cease', lease: 'short', intent: 'recover', start_tick: 10, end_tick: 25 } } },
  ], { expectedEngineHash: 'abc' });
  assert.deepEqual(summary.decision_response_mismatches, []);
  assert.deepEqual(summary.command_decision_mismatches, []);
});

test('trace summary rejects v2 backend raw intent that differs from normalized command intent', () => {
  const summary = summarizeTraceRecords([
    {
      record_type: 'decision_response',
      decision_id: 'd-intent-mismatch',
      normalized: { api_ok: true, valid_choice: true, movement: 'right', fire: 'cease', lease: 'short', intent: 'recover' },
      rawupstreamresponse: {
        parsed: {
          answers: {
            path: { choice: 'right__short' },
            fire: { choice: 'cease' },
            intent: { choice: 'evade' },
          },
        },
      },
    },
    { type: 'command_applied', payload: { command: { decision_id: 'd-intent-mismatch', movement: 'right', fire: 'cease', lease: 'short', intent: 'position', start_tick: 10, end_tick: 25 } } },
  ]);
  assert.deepEqual(summary.decision_response_mismatches, [{
    decision_id: 'd-intent-mismatch',
    raw: { movement: 'right', fire: 'cease', lease: 'short', raw_path: 'right__short', intent: 'evade' },
    normalized: { movement: 'right', fire: 'cease', lease: 'short', intent: 'recover' },
  }]);
  assert.deepEqual(summary.command_decision_mismatches, [{
    decision_id: 'd-intent-mismatch',
    expected: { movement: 'right', fire: 'cease', lease: 'short', intent: 'recover' },
    actual: { movement: 'right', fire: 'cease', lease: 'short', intent: 'position' },
  }]);
});

test('trace summary rejects mismatched or unknown backend path raw choices', () => {
  const mismatched = summarizeTraceRecords([
    {
      record_type: 'decision_response',
      decision_id: 'd-mismatch',
      normalized: { api_ok: true, valid_choice: true, movement: 'up_left', fire: 'cease', lease: 'medium' },
      rawupstreamresponse: {
        parsed: {
          answers: {
            path: { choice: 'up__medium' },
            fire: { choice: 'cease' },
          },
        },
      },
    },
  ]);
  assert.deepEqual(mismatched.decision_response_mismatches, [{
    decision_id: 'd-mismatch',
    raw: { movement: 'up', fire: 'cease', lease: 'medium', raw_path: 'up__medium' },
    normalized: { movement: 'up_left', fire: 'cease', lease: 'medium' },
  }]);

  const unknown = summarizeTraceRecords([
    {
      record_type: 'decision_response',
      decision_id: 'd-unknown',
      normalized: { api_ok: true, valid_choice: true, movement: 'up_left', fire: 'shoot', lease: 'medium' },
      rawupstreamresponse: {
        parsed: {
          answers: {
            path: { choice: 'up_left__medium__extra' },
            fire: { choice: 'shoot' },
          },
        },
      },
    },
  ]);
  assert.deepEqual(unknown.decision_response_mismatches, [{
    decision_id: 'd-unknown',
    raw: {
      movement: null,
      fire: 'shoot',
      lease: null,
      raw_path: 'up_left__medium__extra',
      invalid_raw_choice: 'unknown_path',
    },
    normalized: { movement: 'up_left', fire: 'shoot', lease: 'medium' },
  }]);
});

test('client response_received alone is not accepted as replay authority', () => {
  const summary = summarizeTraceRecords([
    { type: 'response_received', payload: { decision_id: 'client-only', api_ok: true, valid_choice: true, normalized: { movement: 'left', fire: 'shoot', lease: 'short' } } },
    { type: 'command_applied', payload: { decision_id: 'client-only', movement: 'left', fire: 'shoot', lease: 'short', start_tick: 1, end_tick: 16 } },
    { type: 'shot', decision_id: 'client-only' },
  ], { expectedEngineHash: 'abc' });
  assert.deepEqual(summary.missing_decision_links, ['client-only']);
  assert.deepEqual(summary.missing_shot_authorizations, ['client-only']);
  assert.equal(summary.api_decisions, 0);
});

test('backend JSONL client_events batches flatten while preserving run and decision records', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-jsonl-'));
  const tracePath = path.join(tempDir, 'events.jsonl');
  const records = [
    { record_type: 'run_started', engine_source_hash: 'abc', manifest: { engine_hash: 'abc' } },
    { record_type: 'decision_response', decision_id: 'd1', normalized: { api_ok: true, valid_choice: true, movement: 'left', fire: 'shoot', lease: 'short' }, rawupstreamresponse: { parsed: { answers: { movement: { choice: 'left' }, fire: { choice: 'shoot' }, lease: { choice: 'short' } } } } },
    { record_type: 'client_events', event_id_start: 1, event_id_end: 2, events: [
      { event_id: 1, epoch: 1, sequence: 1, tick: 0, sim_ms: 0, wall_ms: 10, type: 'command_applied', payload: { command: { decision_id: 'd1', movement: 'left', fire: 'shoot', lease: 'short', start_tick: 0, end_tick: 15 } } },
      { event_id: 2, epoch: 1, sequence: 1, tick: 3, sim_ms: 50, wall_ms: 60, type: 'shot', payload: { decision_id: 'd1' } },
    ] },
    { record_type: 'run_ended', terminal: { reason: 'target', tick: 7261, sim_ms: 121016.7, wall_ms: 121200, lives: 2, wave: 5, score: 100, qualification_violations: [] } },
  ];
  fs.writeFileSync(tracePath, records.map((record) => JSON.stringify(record)).join('\n'));
  const flattened = readJsonlRecords(tracePath);
  assert.deepEqual(flattened.map((record) => record.record_type || record.type), ['run_started', 'decision_response', 'command_applied', 'shot', 'run_ended']);
  const summary = summarizeTraceRecords(flattened, { expectedEngineHash: 'abc' });
  assert.deepEqual(summary.command_decision_mismatches, []);
  assert.deepEqual(summary.missing_shot_authorizations, []);
  assert.equal(summary.terminal.reason, 'target');
});

test('synthetic current-engine replay without gameplay checkpoints reports no_checkpoints', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-no-checkpoints-'));
  const tracePath = path.join(tempDir, 'events.jsonl');
  const { engineHash, core } = loadSpaceModulesFromHtml(path.join(__dirname, 'space-shooter.html'));
  const manifest = buildManifest({
    seed: 20260920,
    profile: 'hardest',
    difficulty: core.HARDEST_DIFFICULTY,
    engineHash,
    engineVersion: core.ENGINE_VERSION,
    mode: 'cli',
    rules: core.RULES,
  });
  const records = [
    { record_type: 'run_started', engine_source_hash: engineHash, manifest },
    { record_type: 'run_ended', terminal: { reason: 'aborted', tick: 0, sim_ms: 0, wall_ms: 0, lives: 3, wave: 1, score: 0, qualification_violations: ['schema_probe_only'] } },
  ];
  fs.writeFileSync(tracePath, records.map((record) => JSON.stringify(record)).join('\n'));
  const replay = replayTrace({ tracePath });
  assert.equal(replay.replay_ok, false);
  assert.ok(replay.mismatches.includes('no_checkpoints'));
});

test('synthetic current-engine replay accepts checkpoint tick from event envelope', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-envelope-checkpoint-'));
  const tracePath = path.join(tempDir, 'events.jsonl');
  const { engineHash, core } = loadSpaceModulesFromHtml(path.join(__dirname, 'space-shooter.html'));
  const manifest = buildManifest({
    seed: 20260920,
    profile: 'hardest',
    difficulty: core.HARDEST_DIFFICULTY,
    engineHash,
    engineVersion: core.ENGINE_VERSION,
    mode: 'cli',
    rules: core.RULES,
  });
  const game = core.createGame(manifest);
  const checkpoint = {
    event_id: 1,
    epoch: 1,
    sequence: null,
    tick: 0,
    sim_ms: 0,
    wall_ms: 0,
    type: 'checkpoint',
    payload: {
      checkpoint: core.serializeGame(game),
      state_hash: core.hashGame(game),
      status: core.gameStatus(game),
      critical: true,
    },
  };
  assert.equal(checkpoint.payload.tick, undefined);
  const records = [
    { record_type: 'run_started', engine_source_hash: engineHash, manifest },
    { record_type: 'client_events', event_id_start: 1, event_id_end: 1, events: [checkpoint] },
    { record_type: 'run_ended', terminal: { reason: 'aborted', tick: 0, sim_ms: 0, wall_ms: 0, lives: 3, wave: 1, score: 0, qualification_violations: ['fixture'] } },
  ];
  fs.writeFileSync(tracePath, records.map((record) => JSON.stringify(record)).join('\n'));
  const replay = replayTrace({ tracePath });
  assert.equal(replay.replay_ok, true);
  assert.equal(replay.mismatches.includes('no_checkpoints'), false);
});

function replayTailFixture(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-replay-tail-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const tracePath = path.join(tempDir, 'events.jsonl');
  const { core, engineHash } = loadSpaceModulesFromHtml();
  const manifest = buildManifest({
    seed: 20260920,
    profile: 'dense-mid-speed',
    difficulty: DENSE_MID_SPEED_PROFILE,
    engineHash,
    engineVersion: core.ENGINE_VERSION,
    rules: core.RULES,
  });
  const game = core.createGame(manifest);
  const checkpoint = () => ({
    type: 'checkpoint', tick: game.tick, sim_ms: game.sim_ms,
    payload: { checkpoint: core.serializeGame(game), state_hash: core.hashGame(game), status: core.gameStatus(game) },
  });
  const records = [{ record_type: 'run_started', engine_source_hash: engineHash, manifest }, checkpoint()];
  for (let tick = 0; tick < 63; tick += 1) core.stepGame(game, null);
  records.push(checkpoint(), {
    record_type: 'run_ended',
    terminal: { reason: 'target', tick: 63, sim_ms: 1050, wall_ms: 1050, lives: 3, wave: 1, score: 0 },
  });
  return {
    core,
    records,
    replay: () => {
      fs.writeFileSync(tracePath, records.map((record) => JSON.stringify(record)).join('\n'));
      return replayTrace({ tracePath });
    },
  };
}

test('replay numeric comparison tolerates hand-literal cross-runtime velocity roundoff', () => {
  const compared = compareReplayState(
    { enemyBullets: [{ id: 'bullet-1', vx: 75.40182158352886, x: 480 }] },
    { enemyBullets: [{ id: 'bullet-1', vx: 75.40182158352884, x: 480.0000000001 }] },
  );
  assert.equal(compared.ok, true);
  assert.equal(compared.difference_count, 2);
  assert.ok(compared.max_abs_difference <= 1e-9);
  assert.deepEqual(compared.paths, ['enemyBullets[0].vx', 'enemyBullets[0].x']);
});

test('replay numeric comparison keeps discrete values and structural schema exact', () => {
  for (const [actual, recorded] of [
    [{ vx: 1 }, { vx: 1.000000002 }],
    [{ tick: 63 }, { tick: 63.0000000001 }],
    [{ player: { lives: 3 } }, { player: { lives: 3.0000000001 } }],
    [{ rng: { state: 1 } }, { rng: { state: 1.0000000001 } }],
    [{ counters: { playerShots: 1 } }, { counters: { playerShots: 1.0000000001 } }],
    [{ difficulty: { fastBulletSpeed: 1.7 } }, { difficulty: { fastBulletSpeed: 1.7000000001 } }],
    [{ id: 'bullet-1' }, { id: 'bullet-2' }],
    [{ vx: 1 }, { vx: '1' }],
    [{ vx: 1 }, { vx: 1, extra: null }],
    [{ vx: 1 }, {}],
    [[1], [1, 2]],
    [[1], { 0: 1 }],
    [{ vx: null }, { vx: 0 }],
    [{ vx: Infinity }, { vx: Infinity }],
  ]) assert.equal(compareReplayState(actual, recorded).ok, false, JSON.stringify([actual, recorded]));
});

function roundoffReplayFixture(t) {
  const fixture = replayTailFixture(t);
  const terminalCheckpoint = fixture.records[2];
  terminalCheckpoint.payload.checkpoint.enemyBullets[0].vx += 1e-12;
  terminalCheckpoint.payload.state_hash = fixture.core.hashGame(fixture.core.restoreGame(terminalCheckpoint.payload.checkpoint));
  return fixture;
}

test('replay reports tolerated roundoff only for a full self-hash-valid checkpoint', (t) => {
  const fixture = roundoffReplayFixture(t);
  const replay = fixture.replay();
  assert.equal(replay.replay_ok, true);
  assert.deepEqual(replay.mismatches, []);
  assert.equal(replay.numeric_tolerance, 1e-9);
  assert.equal(replay.tolerated_roundoff.length, 1);
  assert.equal(replay.tolerated_roundoff[0].tick, 63);
  assert.equal(replay.tolerated_roundoff[0].scope, 'checkpoint');
  assert.equal(replay.tolerated_roundoff[0].difference_count, 1);
  assert.deepEqual(replay.tolerated_roundoff[0].paths, ['enemyBullets[0].vx']);
});

test('replay rejects self-hash-valid drift IDs and schemas outside the roundoff contract', (t) => {
  for (const mutate of [
    (checkpoint) => { checkpoint.enemyBullets[0].vx += 1e-6; },
    (checkpoint) => { checkpoint.enemyBullets[0].id = 'changed-id'; },
    (checkpoint) => { checkpoint.enemyBullets.pop(); },
    (checkpoint) => { checkpoint.player.lives += 1e-10; },
    (checkpoint) => { checkpoint.extra = true; },
    (checkpoint) => { delete checkpoint.player.maxLives; },
  ]) {
    const fixture = roundoffReplayFixture(t);
    const final = fixture.records[2].payload;
    mutate(final.checkpoint);
    final.state_hash = fixture.core.hashGame(fixture.core.restoreGame(final.checkpoint));
    assert.equal(fixture.replay().replay_ok, false);
  }
});

test('replay rejects corrupt checkpoint own hashes even if the reconstructed hash matches', (t) => {
  const fixture = replayTailFixture(t);
  fixture.records[2].payload.checkpoint.enemyBullets[0].vx += 1e-12;
  assert.equal(fixture.replay().replay_ok, false);
});

test('replay cannot tolerate a hash-only checkpoint or a partial checkpoint', (t) => {
  for (const strip of [
    (payload) => { delete payload.checkpoint; },
    (payload) => { payload.checkpoint = { tick: 63 }; },
  ]) {
    const fixture = roundoffReplayFixture(t);
    strip(fixture.records[2].payload);
    const replay = fixture.replay();
    assert.equal(replay.replay_ok, false);
    assert.deepEqual(replay.tolerated_roundoff, []);
  }
});

test('terminal hash roundoff requires the exact accepted terminal checkpoint hash', (t) => {
  const fixture = roundoffReplayFixture(t);
  fixture.records.at(-1).terminal.hash = fixture.records[2].payload.state_hash;
  const replay = fixture.replay();
  assert.equal(replay.replay_ok, true);
  assert.equal(replay.tolerated_roundoff.filter((item) => item.scope === 'terminal').length, 1);
  fixture.records.at(-1).terminal.hash = 'fnv1a32:unrelated';
  assert.equal(fixture.replay().replay_ok, false);
  fixture.records.at(-1).terminal.hash = fixture.records[2].payload.state_hash;
  fixture.records[2].payload.checkpoint.enemyBullets[0].vx += 0.1;
  const corrupted = fixture.replay();
  assert.equal(corrupted.replay_ok, false);
  assert.equal(corrupted.tolerated_roundoff.some((item) => item.scope === 'terminal'), false);
});

test('replay rejects checkpoint zero with an uncovered terminal tick 63', (t) => {
  const fixture = replayTailFixture(t);
  fixture.records.splice(2, 1);
  const replay = fixture.replay();
  assert.equal(replay.replay_ok, false);
  assert.ok(replay.mismatches.includes('missing_terminal_checkpoint'));
});

test('replay verifies a complete non-60-tick terminal checkpoint', (t) => {
  const fixture = replayTailFixture(t);
  const replay = fixture.replay();
  assert.equal(replay.replay_ok, true);
  assert.deepEqual(replay.mismatches, []);
});

test('replay rejects a corrupted final checkpoint even when terminal metrics match', (t) => {
  const fixture = replayTailFixture(t);
  fixture.records[2].payload.state_hash = 'fnv1a32:bad-tail';
  const replay = fixture.replay();
  assert.equal(replay.replay_ok, false);
  assert.ok(replay.mismatches.some((mismatch) => mismatch.tick === 63 && mismatch.expected === 'fnv1a32:bad-tail'));
});

test('replay rejects missing invalid and backward terminal ticks', (t) => {
  const fixture = replayTailFixture(t);
  for (const tick of [undefined, -1, 62.5, 0]) {
    fixture.records.at(-1).terminal.tick = tick;
    assert.equal(fixture.replay().replay_ok, false, `terminal tick ${tick}`);
  }
});

test('replay rejects terminal state fields inconsistent with the reconstructed final state', (t) => {
  const fixture = replayTailFixture(t);
  for (const [field, wrongValue] of [['lives', 2], ['wave', 2], ['score', 99], ['sim_ms', 1000]]) {
    const original = fixture.records.at(-1).terminal[field];
    fixture.records.at(-1).terminal[field] = wrongValue;
    const replay = fixture.replay();
    assert.equal(replay.replay_ok, false, `must reject incorrect terminal ${field}`);
    assert.ok(replay.mismatches.some((mismatch) => mismatch.terminal_state_mismatches?.some((item) => item.field === field)), field);
    fixture.records.at(-1).terminal[field] = original;
  }
});

test('replay rejects a trace with checkpoints but no terminal record', (t) => {
  const fixture = replayTailFixture(t);
  fixture.records.pop();
  const replay = fixture.replay();
  assert.equal(replay.replay_ok, false);
  assert.ok(replay.mismatches.includes('missing_terminal'));
});

test('replay checks browser nested terminal state and its optional hash', (t) => {
  const fixture = replayTailFixture(t);
  const terminal = fixture.records.pop().terminal;
  fixture.records.push({
    type: 'terminal', tick: 63, sim_ms: 1050,
    payload: { reason: 'target', terminal, hash: fixture.records.at(-1).payload.state_hash },
  });
  assert.equal(fixture.replay().replay_ok, true);
  fixture.records.at(-1).payload.hash = 'fnv1a32:bad-state';
  assert.equal(fixture.replay().replay_ok, false);
});

test('synthetic v2 replay preserves command intent for shot authorization state hashes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-replay-intent-'));
  const tracePath = path.join(tempDir, 'events.jsonl');
  const { engineHash, core } = loadSpaceModulesFromHtml(path.join(__dirname, 'space-shooter.html'));
  const manifest = buildManifest({
    seed: 20260920,
    profile: 'dense-mid-speed',
    difficulty: DENSE_MID_SPEED_PROFILE,
    engineHash,
    engineVersion: core.ENGINE_VERSION,
    mode: 'cli',
    rules: core.RULES,
  });
  const game = core.createGame(manifest);
  const command = {
    decision_id: 'intent-shot-decision',
    sequence: 1,
    movement: 'hold',
    fire: 'shoot',
    lease: 'medium',
    intent: 'recover',
    start_tick: 0,
    end_tick: 30,
    applied_wall_ms: 0,
    expires_wall_ms: 500,
  };
  const records = [
    { record_type: 'run_started', engine_source_hash: engineHash, manifest },
    { type: 'checkpoint', tick: 0, sim_ms: 0, payload: { checkpoint: core.serializeGame(game), state_hash: core.hashGame(game), status: core.gameStatus(game), critical: true } },
    {
      record_type: 'decision_response',
      decision_id: command.decision_id,
      normalized: { api_ok: true, valid_choice: true, movement: command.movement, fire: command.fire, lease: command.lease, intent: command.intent },
      rawupstreamresponse: { parsed: { answers: { path: { choice: 'hold__medium' }, fire: { choice: 'shoot' }, intent: { choice: 'recover' } } } },
    },
    { type: 'command_applied', tick: 0, payload: { command } },
  ];
  for (let i = 0; i < 12; i += 1) core.stepGame(game, command);
  records.push({
    type: 'checkpoint',
    tick: core.gameStatus(game).tick,
    sim_ms: core.gameStatus(game).sim_ms,
    payload: { checkpoint: core.serializeGame(game), state_hash: core.hashGame(game), status: core.gameStatus(game), critical: true },
  });
  records.push({ record_type: 'run_ended', terminal: { reason: 'target', tick: 12, sim_ms: 200, lives: 3, wave: 1, score: 0 } });
  fs.writeFileSync(tracePath, records.map((record) => JSON.stringify(record)).join('\n'));
  const replay = replayTrace({ tracePath });
  assert.equal(replay.replay_ok, true);
  assert.deepEqual(replay.mismatches, []);
});

test('actual schema probe trace parses but cannot qualify as gameplay evidence', { skip: !fs.existsSync(path.join(__dirname, 'runs/run-20260920T031131Z-MFeMFt7fU-Y/events.jsonl')) }, () => {
  const tracePath = path.join(__dirname, 'runs/run-20260920T031131Z-MFeMFt7fU-Y/events.jsonl');
  const records = readJsonlRecords(tracePath);
  assert.deepEqual(records.map((record) => record.record_type || record.type), ['run_started', 'decision_request', 'decision_response', 'schema_probe', 'run_ended']);
  const summary = summarizeTraceRecords(records, { expectedEngineHash: records[0].engine_source_hash });
  assert.equal(summary.api_decisions, 1);
  assert.equal(summary.terminal.reason, 'aborted');
  const verdict = classifyVerdict({
    ...summary.terminal,
    source: 'live',
    trace_complete: true,
    replay_ok: false,
    engine_hash_ok: summary.engine_hash_ok,
  });
  assert.equal(verdict.qualifies, false);
  assert.ok(verdict.violations.includes('terminal_aborted'));
  assert.ok(verdict.violations.includes('schema_probe_only'));
});

test('actual 5s backend trace parser sees backend authority, envelope checkpoints, and non-qualifying duration', { skip: !fs.existsSync(path.join(__dirname, 'runs/run-20260920T031358Z-BTIZP8eAaoo/events.jsonl')) }, (t) => {
  const tracePath = path.join(__dirname, 'runs/run-20260920T031358Z-BTIZP8eAaoo/events.jsonl');
  const records = readJsonlRecords(tracePath);
  const summary = summarizeTraceRecords(records, { expectedEngineHash: records[0].engine_source_hash });
  assert.equal(summary.api_decisions, 5);
  assert.equal(summary.checkpoint_count, 8);
  assert.equal(summary.hit_count, 2);
  assert.equal(summary.terminal.reason, 'target');
  assert.equal(summary.terminal.lives, 1);
  assert.deepEqual(summary.command_decision_mismatches, []);
  assert.deepEqual(summary.decision_response_mismatches, []);
  assert.deepEqual(summary.missing_shot_authorizations, []);

  const firstCheckpoint = records.find((record) => record.type === 'checkpoint');
  const parsedCheckpoint = checkpointFromRecord(firstCheckpoint);
  assert.equal(firstCheckpoint.payload.tick, undefined);
  assert.equal(parsedCheckpoint.tick, firstCheckpoint.tick);
  assert.equal(parsedCheckpoint.state_hash, firstCheckpoint.payload.state_hash);

  const verdict = classifyVerdict({
    ...summary.terminal,
    source: 'live',
    trace_complete: true,
    replay_ok: true,
    engine_hash_ok: summary.engine_hash_ok,
  });
  assert.equal(verdict.qualifies, false);
  assert.ok(verdict.violations.includes('sim_not_over_120s'));
  assert.ok(verdict.violations.includes('wall_not_over_120s'));

  const { engineHash } = loadSpaceModulesFromHtml(path.join(__dirname, 'space-shooter.html'));
  if (records[0].engine_source_hash !== engineHash) {
    t.diagnostic('archived trace source hash differs from current HTML; skipping source-sensitive replay assertion');
    return;
  }
  const replay = replayTrace({ tracePath });
  assert.equal(replay.mismatches.includes('no_checkpoints'), false);
});

test('recorded command spans are truncated by command_ended and neutral periods', () => {
  const spans = buildRecordedCommandSpans([
    { type: 'command_applied', tick: 0, payload: { command: { decision_id: 'old', movement: 'right', fire: 'shoot', lease: 'medium', start_tick: 0, end_tick: 30 } } },
    { type: 'command_ended', tick: 8, payload: { decision_id: 'old', reason: 'preempted' } },
    { type: 'neutral_started', tick: 8, payload: { reason: 'invalid_answer' } },
    { type: 'command_applied', tick: 10, payload: { command: { decision_id: 'new', movement: 'left', fire: 'cease', lease: 'short', start_tick: 10, end_tick: 25 } } },
  ]);
  assert.deepEqual(spans.map((span) => [span.decision_id, span.start_tick, span.actual_end_tick]), [['old', 0, 8], ['new', 10, 25]]);
});
