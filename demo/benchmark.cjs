#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const PROMPT_VERSION = 'djev-authoritative-v2';
const CONTEXT_VERSION = 'djev-observation-v2';
const SCHEMA_VERSION = 1;
const DT_MS = 1000 / 60;
const STALE_RESPONSE_MS = 600;
const DEFAULT_TARGET_SECONDS = 121;
const DEFAULT_MAX_LAG_MS = 250;
const DEFAULT_EXPECTED_DELAY_MS = 260;
const REPLAY_NUMERIC_TOLERANCE = 1e-9;
// Only continuous simulation quantities may differ across JS math runtimes.
// Configuration, RNG state, counters, ticks, IDs and other values stay exact.
const REPLAY_CONTINUOUS_FIELDS = new Set([
  'x', 'y', 'vx', 'vy', 'phase', 'cooldown_s', 'invincible_s',
  'waveClock_s', 'enemyFireClock_s', 'sim_ms',
]);

const HARDEST_PROFILE = Object.freeze({
  bulletDensity: 4,
  enemyDensity: 3,
  fastBulletRatio: 0.85,
  fastBulletSpeed: 2.4,
});

const ACTION_IDS = Object.freeze(['hold', 'left', 'right', 'up', 'down', 'up_left', 'up_right', 'down_left', 'down_right']);
const FIRE_IDS = Object.freeze(['shoot', 'cease']);
const LEASE_IDS = Object.freeze(['short', 'medium']);
const INTENT_IDS = Object.freeze(['evade', 'recover', 'position']);
const PATH_IDS = Object.freeze(ACTION_IDS.flatMap((movement) => LEASE_IDS.map((lease) => `${movement}__${lease}`)));
const PATH_TO_DECISION = Object.freeze(Object.fromEntries(PATH_IDS.map((id) => {
  const separator = id.lastIndexOf('__');
  return [id, { movement: id.slice(0, separator), lease: id.slice(separator + 2) }];
})));

const DENSE_MID_SPEED_PROFILE = Object.freeze({
  bulletDensity: 4,
  enemyDensity: 3,
  fastBulletRatio: 0.85,
  fastBulletSpeed: 1.7,
});

const BENCHMARK_PROFILES = Object.freeze({
  hardest: HARDEST_PROFILE,
  'dense-mid-speed': DENSE_MID_SPEED_PROFILE,
});

const DEFAULT_RULES = Object.freeze({
  dt_ms: DT_MS,
  player_lives: 3,
  player_size_px: Object.freeze({ w: 20, h: 18 }),
  player_speed_px_s: 112,
  hit_invulnerability_s: 1.1,
  shot_cooldown_s: 0.17,
  shot_speed_px_s: -580,
  shot_hitbox_px: Object.freeze({ w: 7, h: 14 }),
  hostile_hitbox_px: Object.freeze({ w: 8, h: 8 }),
  enemy_fire_baseline_s: 0.95,
  hardest_enemy_fire_interval_s: 0.2375,
  lease_ticks: Object.freeze({ short: 15, medium: 30 }),
  stale_response_ms: STALE_RESPONSE_MS,
  upstream_timeout_ms: 2000,
  max_scheduling_lag_ms: DEFAULT_MAX_LAG_MS,
});

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function hashSourcePair(coreScript, controllerScript) {
  return crypto.createHash('sha256').update(`${coreScript}\n${controllerScript}`).digest('hex');
}

function extractInlineScript(html, scriptId) {
  const escaped = scriptId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<script\\s+id="${escaped}"[^>]*>([\\s\\S]*?)<\\/script>`));
  if (!match) throw new Error(`missing inline script id="${scriptId}"`);
  return match[1];
}

function assertFunction(obj, name, owner) {
  if (typeof obj?.[name] !== 'function') throw new Error(`${owner}.${name} export is required`);
}

function validateRuntimeContract(core, controller) {
  for (const name of ['createGame', 'stepGame', 'observeGame', 'serializeGame', 'restoreGame', 'hashGame', 'gameStatus']) {
    assertFunction(core, name, 'SpaceDecisionCore');
  }
  for (const name of ['createController', 'beginDecision', 'receiveDecision', 'commandForTick', 'finishDecision', 'invalidateController']) {
    assertFunction(controller, name, 'SpaceDjevController');
  }
  if (!Array.isArray(core.ACTION_IDS) || core.ACTION_IDS.length !== 9) throw new Error('SpaceDecisionCore.ACTION_IDS must contain all nine movement IDs');
  if (!core.LEASE_TICKS || core.LEASE_TICKS.short !== 15 || core.LEASE_TICKS.medium !== 30) throw new Error('SpaceDecisionCore.LEASE_TICKS must expose 15/30 tick leases');
  if (core.DT_MS !== DT_MS) throw new Error(`SpaceDecisionCore.DT_MS must be ${DT_MS}`);
  if (!core.RULES) throw new Error('SpaceDecisionCore.RULES export is required');
  if (!core.HARDEST_DIFFICULTY) throw new Error('SpaceDecisionCore.HARDEST_DIFFICULTY export is required');
}

function loadSpaceModulesFromHtml(htmlPath = path.join(__dirname, 'space-shooter.html')) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const coreScript = extractInlineScript(html, 'space-decision-core');
  const controllerScript = extractInlineScript(html, 'space-djev-controller');
  const sandbox = {
    console,
    crypto: globalThis.crypto,
    structuredClone: globalThis.structuredClone,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreScript, sandbox, { filename: `${htmlPath}#space-decision-core` });
  vm.runInContext(controllerScript, sandbox, { filename: `${htmlPath}#space-djev-controller` });
  const core = sandbox.SpaceDecisionCore;
  const controller = sandbox.SpaceDjevController;
  if (!core) throw new Error('inline core did not export globalThis.SpaceDecisionCore');
  if (!controller) throw new Error('inline controller did not export globalThis.SpaceDjevController');
  validateRuntimeContract(core, controller);
  return {
    core,
    controller,
    html,
    coreScript,
    controllerScript,
    engineHash: hashSourcePair(coreScript, controllerScript),
  };
}

async function archiveEngineHtmlSnapshot({ outDir, engineHash, html }) {
  if (!outDir) throw new Error('outDir is required for engine archive');
  if (typeof engineHash !== 'string' || !/^[a-f0-9]{64}$/i.test(engineHash)) throw new Error('valid engineHash is required for engine archive');
  if (typeof html !== 'string' || !html) throw new Error('html is required for engine archive');
  const archiveDir = path.join(outDir, 'engines');
  const archivePath = path.join(archiveDir, `${engineHash}.html`);
  await fsp.mkdir(archiveDir, { recursive: true });

  const verifyExisting = async () => {
    const existing = await fsp.readFile(archivePath, 'utf8');
    const existingHash = hashSourcePair(
      extractInlineScript(existing, 'space-decision-core'),
      extractInlineScript(existing, 'space-djev-controller'),
    );
    if (existingHash !== engineHash) {
      throw new Error(`engine archive hash mismatch for ${archivePath}: expected ${engineHash}, found ${existingHash}`);
    }
    return archivePath;
  };

  if (fs.existsSync(archivePath)) return verifyExisting();
  try {
    await fsp.writeFile(archivePath, html, { flag: 'wx' });
    return archivePath;
  } catch (error) {
    if (error?.code === 'EEXIST') return verifyExisting();
    throw error;
  }
}

function buildManifest({ seed, profile, difficulty, engineHash, engineVersion, mode = 'cli', rules = DEFAULT_RULES }) {
  const manifestRules = rules == null ? cloneJson(DEFAULT_RULES) : cloneJson(rules);
  return {
    seed,
    profile,
    difficulty: cloneJson(difficulty),
    engine_version: engineVersion,
    engine_hash: engineHash,
    dt_ms: DT_MS,
    prompt_version: PROMPT_VERSION,
    context_version: CONTEXT_VERSION,
    mode,
    rules: manifestRules,
    rng: {
      algorithm: 'engine-seeded-authoritative',
      seed,
      initial_state: null,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url) {
  if (!url) throw new Error('--url is required for live benchmark mode');
  return url.replace(/\/+$/, '');
}

async function httpPostJson(baseUrl, route, body, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(normalizeBaseUrl(baseUrl) + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`invalid JSON from ${route}: ${error.message}`);
      }
    }
    if (!response.ok) {
      const detail = parsed?.error || text || response.statusText;
      throw new Error(`${route} HTTP ${response.status}: ${detail}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

class MirrorLogger {
  constructor(filePath) {
    this.filePath = filePath;
    this.handle = null;
  }

  async open() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    this.handle = await fsp.open(this.filePath, 'a');
  }

  async append(record, options = {}) {
    if (!this.handle) await this.open();
    await this.handle.writeFile(`${JSON.stringify(record)}\n`);
    if (options.sync) await this.handle.sync();
  }

  async close() {
    if (!this.handle) return;
    await this.handle.close();
    this.handle = null;
  }
}

class EventBatcher {
  constructor({ runId, postJson, mirrorLogger = null, batchSize = 25, retryDelayMs = 50, maxDrainAttempts = 200 }) {
    this.runId = runId;
    this.postJson = postJson;
    this.mirrorLogger = mirrorLogger;
    this.batchSize = batchSize;
    this.retryDelayMs = retryDelayMs;
    this.maxDrainAttempts = maxDrainAttempts;
    this.nextEventId = 1;
    this.events = [];
    this.ackedEventId = 0;
    this.inflight = null;
    this.lastError = null;
    this.mirrorWrites = [];
  }

  enqueue(event, options = {}) {
    const eventId = event.event_id ?? this.nextEventId;
    this.nextEventId = Math.max(this.nextEventId, eventId + 1);
    const record = { ...event, event_id: eventId };
    this.events.push(record);
    if (this.mirrorLogger) {
      const write = Promise.resolve(this.mirrorLogger.append(record, options)).catch((error) => {
        this.lastError = error;
      });
      this.mirrorWrites.push(write);
    }
    return record;
  }

  pendingEvents() {
    return this.events.filter((event) => event.event_id > this.ackedEventId);
  }

  async flush() {
    if (this.inflight) return this.inflight;
    const batch = this.pendingEvents().slice(0, this.batchSize);
    if (!batch.length) return true;
    this.inflight = this.#sendBatch(batch).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async #sendBatch(batch) {
    try {
      const response = await this.postJson('/api/run/event', {
        schema_version: SCHEMA_VERSION,
        run_id: this.runId,
        events: batch,
      });
      const ack = Number(response?.acked_event_id);
      if (!Number.isInteger(ack) || ack < this.ackedEventId) throw new Error('invalid event ack');
      this.ackedEventId = Math.max(this.ackedEventId, ack);
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error;
      return false;
    }
  }

  async drain() {
    let attempts = 0;
    while (this.ackedEventId < this.nextEventId - 1) {
      attempts += 1;
      if (attempts > this.maxDrainAttempts) throw new Error(`event drain failed after ${attempts - 1} attempts: ${this.lastError?.message || 'unknown error'}`);
      const ok = await this.flush();
      if (!ok) await sleep(this.retryDelayMs);
    }
    await Promise.all(this.mirrorWrites.splice(0));
    return true;
  }

  async endRun(terminal) {
    await this.drain();
    const response = await this.postJson('/api/run/end', {
      schema_version: SCHEMA_VERSION,
      run_id: this.runId,
      last_event_id: this.ackedEventId,
      terminal,
    });
    if (this.mirrorLogger) await this.mirrorLogger.close();
    return response;
  }
}

function computeDueTicks({ nowMs, nextTickWallMs, dtMs = DT_MS, maxLagMs = DEFAULT_MAX_LAG_MS }) {
  const lagMs = Math.max(0, nowMs - nextTickWallMs);
  if (nowMs < nextTickWallMs) return { dueTicks: 0, lagMs: 0, lagInvalid: false };
  return {
    dueTicks: Math.floor((lagMs + 1e-9) / dtMs) + 1,
    lagMs,
    lagInvalid: lagMs > maxLagMs,
  };
}

function exactDifficultyMatches(actual, expected) {
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  return actual.bulletDensity === expected.bulletDensity
    && actual.enemyDensity === expected.enemyDensity
    && actual.fastBulletRatio === expected.fastBulletRatio
    && actual.fastBulletSpeed === expected.fastBulletSpeed;
}

function manifestProfileFromSummary(summary) {
  return summary.profile ?? summary.manifest?.profile ?? summary.trace_summary?.profile ?? null;
}

function manifestDifficultyFromSummary(summary) {
  const difficulty = summary.difficulty ?? summary.manifest?.difficulty ?? summary.trace_summary?.difficulty ?? null;
  return difficulty == null ? null : cloneJson(difficulty);
}

function classifyVerdict(summary) {
  const violations = [...(summary.qualification_violations || [])];
  const profile = manifestProfileFromSummary(summary);
  const difficulty = manifestDifficultyFromSummary(summary);
  const expectedDifficulty = profile ? BENCHMARK_PROFILES[profile] : null;
  const profileKnown = !!expectedDifficulty;
  const profileMatchesDifficulty = profileKnown && exactDifficultyMatches(difficulty, expectedDifficulty);
  const backendTraceResolved = summary.backend_trace_resolved === true || summary.authoritative_trace_source === 'backend';
  if (summary.reason !== 'target') violations.push(`terminal_${summary.reason || 'unknown'}`);
  if (!(summary.sim_ms > 120000)) violations.push('sim_not_over_120s');
  if (!(summary.wall_ms > 120000)) violations.push('wall_not_over_120s');
  if (!(summary.lives > 0)) violations.push('not_alive');
  if (!summary.trace_complete) violations.push('trace_incomplete');
  if (!summary.replay_ok) violations.push('replay_mismatch');
  if (!summary.engine_hash_ok) violations.push('engine_hash_mismatch');
  if (summary.source !== 'live') violations.push('not_live_source');
  if (summary.source === 'live' && !backendTraceResolved) violations.push('missing_backend_trace');
  if (!profile) violations.push('missing_profile');
  else if (!profileKnown) violations.push('unknown_profile');
  if (!difficulty) violations.push('missing_difficulty');
  else if (profileKnown && !profileMatchesDifficulty) violations.push('profile_difficulty_mismatch');
  const qualifies = violations.length === 0;
  const qualifiesHardest = qualifies && profile === 'hardest' && exactDifficultyMatches(difficulty, HARDEST_PROFILE);
  return {
    qualifies,
    qualified_profile: qualifies ? profile : null,
    qualifies_hardest: qualifiesHardest,
    profile,
    difficulty,
    violations,
  };
}

function eventPayload(record) {
  if (record?.record_type === 'run_started') return record.manifest || {};
  if (record?.record_type === 'run_ended') return record.terminal || {};
  if (record?.record_type === 'decision_response') return record.normalized || {};
  if (record?.payload && typeof record.payload === 'object') return record.payload;
  if (record?.type && typeof record === 'object') {
    const { type, ...payload } = record;
    return payload;
  }
  return {};
}

function normalizedDecisionFromPayload(payload) {
  const normalized = payload.command && typeof payload.command === 'object'
    ? payload.command
    : payload.normalized && typeof payload.normalized === 'object'
      ? payload.normalized
      : payload;
  const decision = {
    movement: normalized.movement ?? null,
    fire: normalized.fire ?? null,
    lease: normalized.lease ?? null,
  };
  if (normalized.intent != null) decision.intent = normalized.intent;
  return decision;
}

function eventKind(record) {
  return record?.type || record?.record_type || null;
}

function decisionIdFromPayload(payload) {
  return payload.decision_id || payload.command?.decision_id || null;
}

function rawParsedDecisionTriple(record) {
  const parsed = record?.rawupstreamresponse?.parsed;
  const answers = parsed && typeof parsed === 'object' ? parsed.answers : null;
  if (!answers || typeof answers !== 'object') return null;
  const choice = (name) => {
    const answer = answers[name];
    return typeof answer?.choice === 'string' ? answer.choice : null;
  };
  const withIntent = (decision) => {
    const intent = choice('intent');
    if (intent === null) return decision;
    if (!INTENT_IDS.includes(intent)) {
      return {
        ...decision,
        intent,
        invalid_raw_choice: 'unknown_intent',
      };
    }
    return { ...decision, intent };
  };
  const pathChoice = choice('path');
  if (pathChoice !== null) {
    const mapped = PATH_TO_DECISION[pathChoice];
    if (!mapped) {
      return withIntent({
        movement: null,
        fire: choice('fire'),
        lease: null,
        raw_path: pathChoice,
        invalid_raw_choice: 'unknown_path',
      });
    }
    return withIntent({
      movement: mapped.movement,
      fire: choice('fire'),
      lease: mapped.lease,
      raw_path: pathChoice,
    });
  }
  return withIntent({
    movement: choice('movement'),
    fire: choice('fire'),
    lease: choice('lease'),
  });
}

function sameDecisionTriple(a, b) {
  if (a.invalid_raw_choice) return false;
  if (a.movement !== b.movement || a.fire !== b.fire || a.lease !== b.lease) return false;
  if (a.intent != null || b.intent != null) return a.intent === b.intent;
  return true;
}

function summarizeTraceRecords(records, options = {}) {
  const expectedEngineHash = options.expectedEngineHash;
  const decisions = new Map();
  const commandDecisionMismatches = [];
  const decisionResponseMismatches = [];
  const missingDecisionLinks = [];
  const missingShotAuthorizations = [];
  let manifestEngineHash = null;
  let manifestProfile = null;
  let manifestDifficulty = null;
  let terminal = null;
  let checkpoints = 0;
  let hits = 0;

  for (const record of records) {
    const kind = eventKind(record);
    const payload = eventPayload(record);
    if (kind === 'manifest') {
      manifestEngineHash = payload.engine_hash || record.engine_hash || null;
      manifestProfile = payload.profile ?? manifestProfile;
      manifestDifficulty = payload.difficulty ? cloneJson(payload.difficulty) : manifestDifficulty;
    }
    if (kind === 'run_started') {
      const manifest = record.manifest || {};
      manifestEngineHash = record.engine_source_hash || manifest.engine_hash || null;
      manifestProfile = manifest.profile ?? manifestProfile;
      manifestDifficulty = manifest.difficulty ? cloneJson(manifest.difficulty) : manifestDifficulty;
    }
    if (kind === 'decision_response' && record.decision_id) {
      const normalized = normalizedDecisionFromPayload(payload);
      const raw = rawParsedDecisionTriple(record);
      if (payload.api_ok === true && payload.valid_choice === true && (!raw || !sameDecisionTriple(raw, normalized))) {
        decisionResponseMismatches.push({ decision_id: record.decision_id, raw, normalized });
      }
      decisions.set(record.decision_id, {
        api_ok: payload.api_ok === true,
        valid_choice: payload.valid_choice === true,
        normalized,
      });
    }
    if (kind === 'command_applied') {
      const actual = normalizedDecisionFromPayload(payload);
      const decisionId = decisionIdFromPayload(payload);
      const decision = decisions.get(decisionId);
      if (!decision) {
        missingDecisionLinks.push(decisionId);
      } else if (!decision.api_ok || !decision.valid_choice || !sameDecisionTriple(decision.normalized, actual)) {
        commandDecisionMismatches.push({
          decision_id: decisionId,
          expected: decision.normalized,
          actual,
        });
      }
    }
    if (kind === 'shot' && (payload.owner === 'player' || payload.decision_id || payload.command?.decision_id)) {
      const decisionId = decisionIdFromPayload(payload);
      const decision = decisionId ? decisions.get(decisionId) : null;
      if (!decision || !decision.api_ok || !decision.valid_choice) missingShotAuthorizations.push(decisionId);
    }
    if (kind === 'checkpoint') checkpoints += 1;
    if (kind === 'hit') hits += 1;
    if (kind === 'terminal' || kind === 'run_ended') {
      const { terminal: nestedTerminal, ...fields } = payload;
      terminal = { ...fields, ...(nestedTerminal && typeof nestedTerminal === 'object' ? nestedTerminal : {}) };
      terminal.tick ??= record.tick;
      terminal.sim_ms ??= record.sim_ms;
    }
  }

  return {
    engine_hash_ok: expectedEngineHash ? manifestEngineHash === expectedEngineHash : true,
    manifest_engine_hash: manifestEngineHash,
    profile: manifestProfile,
    difficulty: manifestDifficulty,
    api_decisions: decisions.size,
    command_decision_mismatches: commandDecisionMismatches,
    decision_response_mismatches: decisionResponseMismatches,
    missing_decision_links: missingDecisionLinks,
    missing_shot_authorizations: missingShotAuthorizations,
    checkpoint_count: checkpoints,
    hit_count: hits,
    terminal,
  };
}

function recordSimMs(record) {
  const payload = eventPayload(record);
  return firstFiniteNumber(
    record?.sim_ms,
    payload?.sim_ms,
    payload?.status?.sim_ms,
    payload?.checkpoint?.sim_ms,
    record?.rawsnapshot?.state?.sim_ms,
    record?.exactactualpayload?.state?.context?.sim_ms,
    record?.exactactualpayload?.state?.sim_ms,
    Number.isInteger(record?.snapshot_tick) ? record.snapshot_tick * DT_MS : null,
    Number.isInteger(record?.tick) ? record.tick * DT_MS : null,
    Number.isInteger(payload?.tick) ? payload.tick * DT_MS : null,
  );
}

function executionDecisionId(record) {
  const payload = eventPayload(record);
  return record?.decision_id
    || payload?.decision_id
    || payload?.command?.decision_id
    || payload?.active_decision_id
    || payload?.active_command?.decision_id
    || null;
}

function createApiFootprint(decisionId) {
  return {
    decision_id: decisionId,
    epoch: null,
    sequence: null,
    _epochPriority: 0,
    _sequencePriority: 0,
    request_sim_ms: null,
    snapshot_tick: null,
    request: null,
    response: null,
    exactactualpayload: null,
    rawsnapshot: null,
    rawresponse: null,
    normalized: null,
    client_receipts: [],
    execution: {
      response_events: [],
      command_events: [],
      shots: [],
      hits: [],
    },
  };
}

function setFootprintMetadata(footprint, metadata, priority) {
  if (metadata.epoch != null && (priority > footprint._epochPriority || footprint.epoch == null)) {
    footprint.epoch = metadata.epoch;
    footprint._epochPriority = priority;
  }
  if (metadata.sequence != null && (priority > footprint._sequencePriority || footprint.sequence == null)) {
    footprint.sequence = metadata.sequence;
    footprint._sequencePriority = priority;
  }
}

function commandEventMetadata(record, payload) {
  const command = payload.command && typeof payload.command === 'object' ? payload.command : payload;
  return {
    epoch: command.epoch ?? payload.epoch ?? record.epoch ?? null,
    sequence: command.sequence ?? payload.sequence ?? record.sequence ?? null,
  };
}

function buildApiFootprints(records) {
  const footprints = new Map();
  const ensure = (decisionId) => {
    if (!decisionId) return null;
    if (!footprints.has(decisionId)) footprints.set(decisionId, createApiFootprint(decisionId));
    return footprints.get(decisionId);
  };

  for (const record of records) {
    const kind = eventKind(record);
    const payload = eventPayload(record);
    const decisionId = executionDecisionId(record);
    const footprint = ensure(decisionId);
    if (!footprint) continue;

    if (kind === 'decision_request') {
      setFootprintMetadata(footprint, { epoch: record.epoch ?? payload.epoch ?? null, sequence: record.sequence ?? payload.sequence ?? null }, 3);
      footprint.request = record;
      footprint.request_sim_ms = recordSimMs(record);
      footprint.snapshot_tick = record.snapshot_tick ?? null;
      footprint.exactactualpayload = record.exactactualpayload ?? footprint.exactactualpayload;
      footprint.rawsnapshot = record.rawsnapshot ?? footprint.rawsnapshot;
    } else if (kind === 'decision_response') {
      setFootprintMetadata(footprint, { epoch: record.epoch ?? payload.epoch ?? null, sequence: record.sequence ?? payload.sequence ?? null }, 2);
      footprint.response = record;
      footprint.normalized = record.normalized ?? footprint.normalized;
      footprint.rawresponse = record.rawupstreamresponse ?? footprint.rawresponse;
      footprint.exactactualpayload = record.exactactualpayload ?? footprint.exactactualpayload;
      footprint.rawsnapshot = record.rawsnapshot ?? footprint.rawsnapshot;
      if (footprint.request_sim_ms === null) footprint.request_sim_ms = recordSimMs(record);
    } else if (kind === 'response_received' || kind === 'response_rejected') {
      footprint.client_receipts.push(record);
      footprint.execution.response_events.push(record);
      if (footprint.request_sim_ms === null) footprint.request_sim_ms = recordSimMs(record);
    } else if (kind === 'command_applied' || kind === 'command_ended') {
      setFootprintMetadata(footprint, commandEventMetadata(record, payload), 1);
      footprint.execution.command_events.push(record);
    } else if (kind === 'shot') {
      footprint.execution.shots.push(record);
    } else if (kind === 'hit' || kind === 'invulnerability_contact') {
      footprint.execution.hits.push(record);
    }
  }

  return [...footprints.values()].map((footprint) => {
    const { _epochPriority, _sequencePriority, ...publicFootprint } = footprint;
    return {
      ...publicFootprint,
      request_sim_ms: publicFootprint.request_sim_ms ?? recordSimMs(publicFootprint.request) ?? recordSimMs(publicFootprint.response),
    };
  });
}

function reportRecordSimMs(record, footprintsByDecisionId = new Map()) {
  const direct = recordSimMs(record);
  if (direct !== null) return direct;
  const decisionId = executionDecisionId(record);
  return decisionId ? footprintsByDecisionId.get(decisionId)?.request_sim_ms ?? null : null;
}

function buildDeathWindowReport(records) {
  const terminalIndex = records.findIndex((record) => ['terminal', 'run_ended'].includes(eventKind(record)) && eventPayload(record).reason === 'death');
  const terminal = terminalIndex >= 0 ? records[terminalIndex] : records.find((record) => ['terminal', 'run_ended'].includes(eventKind(record)));
  if (!terminal) return { reason: 'missing_terminal', window_start_sim_ms: null, decisions: [], events: [] };
  const terminalSimMs = recordSimMs(terminal) ?? 0;
  const allFootprints = buildApiFootprints(records)
    .filter((footprint) => Number.isFinite(footprint.request_sim_ms))
    .sort((a, b) => a.request_sim_ms - b.request_sim_ms || (a.sequence ?? 0) - (b.sequence ?? 0) || a.decision_id.localeCompare(b.decision_id));
  const priorFootprints = allFootprints.filter((footprint) => footprint.request_sim_ms <= terminalSimMs);
  const sixthPriorFootprint = priorFootprints.length >= 6 ? priorFootprints[priorFootprints.length - 6] : null;
  const tenSecondStart = terminalSimMs - 10000;
  const windowStart = Math.min(tenSecondStart, sixthPriorFootprint?.request_sim_ms ?? tenSecondStart);
  const apiFootprints = priorFootprints.filter((footprint) => footprint.request_sim_ms >= windowStart);
  const footprintsByDecisionId = new Map(allFootprints.map((footprint) => [footprint.decision_id, footprint]));
  const prior = records.filter((record) => {
    const simMs = reportRecordSimMs(record, footprintsByDecisionId);
    return simMs !== null && simMs <= terminalSimMs;
  });
  const decisions = prior.filter((record) => {
    const kind = eventKind(record);
    return (kind === 'response_received' && eventPayload(record).decision_id) || (kind === 'decision_response' && record.decision_id);
  });
  const events = prior.filter((record) => {
    const simMs = reportRecordSimMs(record, footprintsByDecisionId);
    return simMs !== null && simMs >= windowStart;
  });
  return {
    reason: eventPayload(terminal).reason || 'terminal',
    terminal,
    window_start_sim_ms: windowStart,
    window_end_sim_ms: terminalSimMs,
    decisions: decisions.filter((record) => {
      const simMs = reportRecordSimMs(record, footprintsByDecisionId);
      return simMs !== null && simMs >= windowStart;
    }),
    events,
    api_footprints: apiFootprints,
  };
}

function flattenJsonlRecord(record) {
  if (record?.record_type === 'client_events' && Array.isArray(record.events)) return record.events;
  if (record?.event && typeof record.event === 'object') return [record.event];
  if (record?.payload?.type && !record.type) return [record.payload];
  return [record];
}

function readJsonlRecords(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      records.push(...flattenJsonlRecord(parsed));
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: ${error.message}`);
    }
  }
  return records;
}

function buildTraceReport({ tracePath, htmlPath = path.join(__dirname, 'space-shooter.html') }) {
  const records = readJsonlRecords(tracePath);
  const { engineHash } = loadSpaceModulesFromHtml(htmlPath);
  const summary = summarizeTraceRecords(records, { expectedEngineHash: engineHash });
  const terminal = summary.terminal || {};
  return {
    summary,
    death_window: buildDeathWindowReport(records),
    verdict: classifyVerdict({
      ...terminal,
      source: 'report',
      trace_complete: false,
      replay_ok: false,
      engine_hash_ok: summary.engine_hash_ok,
      profile: summary.profile,
      difficulty: summary.difficulty,
    }),
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function finiteNumberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function compactHitForObservation(record, currentSimMs = null) {
  const eventPayloadValue = eventPayload(record);
  const payload = eventPayloadValue && Object.keys(eventPayloadValue).length ? eventPayloadValue : (record || {});
  const source = payload.source && typeof payload.source === 'object' ? payload.source : {};
  const simMs = firstFiniteNumber(
    record?.sim_ms,
    payload.sim_ms,
    Number.isInteger(record?.tick) ? record.tick * DT_MS : null,
    Number.isInteger(payload.tick) ? payload.tick * DT_MS : null,
    currentSimMs,
  );
  const livesAfter = payload.lives_after ?? payload.after_lives ?? payload.player?.lives ?? null;
  const compact = {
    sim_ms: simMs ?? 0,
    kind: String(source.kind ?? payload.kind ?? 'unknown'),
    x: finiteNumberOrZero(source.x ?? payload.x),
    y: finiteNumberOrZero(source.y ?? payload.y),
    vx: finiteNumberOrZero(source.vx ?? payload.vx),
    vy: finiteNumberOrZero(source.vy ?? payload.vy),
    lives_after: Number.isFinite(Number(livesAfter)) ? Number(livesAfter) : livesAfter,
  };
  const now = firstFiniteNumber(currentSimMs);
  if (now !== null && simMs !== null) compact.ago_ms = Math.max(0, now - simMs);
  return compact;
}

function recentHitsForObservation(recentHits, currentSimMs, { limit = 4, windowMs = 5000 } = {}) {
  const now = firstFiniteNumber(currentSimMs);
  if (now === null) return [];
  return recentHits
    .map((hit) => compactHitForObservation(hit, now))
    .filter((hit) => {
      const ageMs = now - hit.sim_ms;
      return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= windowMs;
    })
    .slice(-limit);
}

function activeCommandForObservation(command, gameTick, requestWallMs, dtMs = DT_MS) {
  if (!command) return null;
  const tickRemainingMs = firstFiniteNumber(command.end_tick, null) === null || firstFiniteNumber(gameTick, null) === null
    ? Number.POSITIVE_INFINITY
    : (Number(command.end_tick) - Number(gameTick)) * dtMs;
  const wallRemainingMs = firstFiniteNumber(command.expires_wall_ms, null) === null || firstFiniteNumber(requestWallMs, null) === null
    ? Number.POSITIVE_INFINITY
    : Number(command.expires_wall_ms) - Number(requestWallMs);
  const remainingMs = Math.max(0, Math.min(tickRemainingMs, wallRemainingMs));
  const observed = {
    movement: command.movement,
    fire: command.fire,
    lease: command.lease,
    remaining_ms: Number.isFinite(remainingMs) ? remainingMs : 0,
    wall_ms: firstFiniteNumber(requestWallMs) ?? 0,
    expires_wall_ms: firstFiniteNumber(command.expires_wall_ms) ?? null,
  };
  if (command.intent != null) observed.intent = command.intent;
  return observed;
}

function nextDecisionAllowedWallMs(controller, settledWallMs) {
  const wallMs = firstFiniteNumber(settledWallMs) ?? 0;
  const backoffMs = firstFiniteNumber(controller?.backoffMs) ?? 0;
  return wallMs + Math.max(0, backoffMs);
}

function buildObservationContext({
  control,
  stats,
  activeCommand,
  recentCommands,
  recentHits,
  currentSimMs,
}) {
  const lastIntent = control?.lastAppliedIntent ?? null;
  return {
    expected_delay_ms: stats.expected_delay_ms,
    latency_samples: stats.latency_samples,
    latency_spread_ms: stats.latency_spread_ms,
    active_command: activeCommand,
    recent_commands: recentCommands.slice(-6),
    recent_hits: recentHitsForObservation(recentHits, currentSimMs),
    last_intent: lastIntent,
    last_applied_intent: lastIntent,
    lastAppliedIntent: lastIntent,
  };
}

function checkpointFromRecord(record) {
  if (eventKind(record) !== 'checkpoint') return null;
  const payload = eventPayload(record);
  const tick = firstFiniteNumber(record.tick, payload.tick, payload.status?.tick, payload.checkpoint?.tick);
  const hash = payload.state_hash || payload.hash || record.state_hash || record.hash || null;
  if (!Number.isInteger(tick) || typeof hash !== 'string') return null;
  return {
    ...payload,
    tick,
    sim_ms: firstFiniteNumber(record.sim_ms, payload.sim_ms, payload.status?.sim_ms, payload.checkpoint?.sim_ms),
    state_hash: hash,
  };
}

function commandAtTick(commands, tick) {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    const endTick = command.actual_end_tick ?? command.end_tick;
    if (command.start_tick <= tick && tick < endTick) return command;
  }
  return null;
}

function commandFromPayload(payload) {
  const command = payload?.command && typeof payload.command === 'object' ? payload.command : payload;
  if (!command || !command.decision_id) return null;
  return {
    decision_id: command.decision_id,
    sequence: command.sequence ?? null,
    movement: command.movement,
    fire: command.fire,
    lease: command.lease,
    ...(command.intent === undefined ? {} : { intent: command.intent }),
    start_tick: command.start_tick,
    end_tick: command.end_tick,
    actual_end_tick: command.actual_end_tick ?? command.end_tick,
    applied_wall_ms: command.applied_wall_ms,
    expires_wall_ms: command.expires_wall_ms,
  };
}

function buildRecordedCommandSpans(records) {
  const spans = [];
  const activeByDecision = new Map();
  for (const record of records) {
    const kind = eventKind(record);
    const payload = eventPayload(record);
    if (kind === 'command_applied') {
      const command = commandFromPayload(payload);
      if (!command) continue;
      for (const active of activeByDecision.values()) {
        if (active.actual_end_tick > command.start_tick) active.actual_end_tick = command.start_tick;
      }
      spans.push(command);
      activeByDecision.set(command.decision_id, command);
    } else if (kind === 'command_ended') {
      const decisionId = decisionIdFromPayload(payload);
      const endedTick = Number.isInteger(record.tick) ? record.tick : Number.isInteger(payload.tick) ? payload.tick : null;
      if (decisionId && activeByDecision.has(decisionId) && endedTick !== null) {
        const active = activeByDecision.get(decisionId);
        active.actual_end_tick = Math.min(active.actual_end_tick ?? active.end_tick, endedTick);
        activeByDecision.delete(decisionId);
      } else if (endedTick !== null) {
        for (const active of activeByDecision.values()) {
          active.actual_end_tick = Math.min(active.actual_end_tick ?? active.end_tick, endedTick);
        }
        activeByDecision.clear();
      }
    } else if (kind === 'neutral_started') {
      const neutralTick = Number.isInteger(record.tick) ? record.tick : Number.isInteger(payload.tick) ? payload.tick : null;
      if (neutralTick !== null) {
        for (const active of activeByDecision.values()) {
          active.actual_end_tick = Math.min(active.actual_end_tick ?? active.end_tick, neutralTick);
        }
        activeByDecision.clear();
      }
    }
  }
  return spans
    .filter((command) => Number.isInteger(command.start_tick) && Number.isInteger(command.actual_end_tick) && command.actual_end_tick > command.start_tick)
    .sort((a, b) => a.start_tick - b.start_tick || a.actual_end_tick - b.actual_end_tick);
}

function compareReplayState(actual, recorded) {
  const result = { ok: true, difference_count: 0, max_abs_difference: 0, paths: [] };
  const fail = (path, reason) => {
    result.ok = false;
    result.mismatch = { path, reason };
    return false;
  };
  const visit = (a, b, path, key) => {
    if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return fail(path, 'type_mismatch');
    if (typeof a === 'number') {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return fail(path, 'nonfinite_number');
      if (a === b) return true;
      const difference = Math.abs(a - b);
      const continuous = REPLAY_CONTINUOUS_FIELDS.has(key) && !/^(counters|rng|difficulty)\./.test(path);
      if (!continuous || difference > REPLAY_NUMERIC_TOLERANCE) return fail(path, 'numeric_mismatch');
      result.difference_count += 1;
      result.max_abs_difference = Math.max(result.max_abs_difference, difference);
      if (result.paths.length < 8) result.paths.push(path);
      return true;
    }
    if (a === null || b === null || typeof a !== 'object') return a === b || fail(path, 'value_mismatch');
    if (Array.isArray(a)) {
      if (a.length !== b.length) return fail(path, 'array_length_mismatch');
      return a.every((value, index) => visit(value, b[index], `${path}[${index}]`, String(index)));
    }
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length || keys.some((name) => !Object.hasOwn(b, name))) return fail(path, 'object_keys_mismatch');
    return keys.every((name) => visit(a[name], b[name], path ? `${path}.${name}` : name, name));
  };
  visit(actual, recorded, '', '');
  return result;
}

function replayTrace({ tracePath, htmlPath = path.join(__dirname, 'space-shooter.html') }) {
  const records = readJsonlRecords(tracePath);
  const { core, engineHash } = loadSpaceModulesFromHtml(htmlPath);
  const summary = summarizeTraceRecords(records, { expectedEngineHash: engineHash });
  const manifestRecord = records.find((record) => eventKind(record) === 'manifest' || eventKind(record) === 'run_started');
  if (!manifestRecord) return { replay_ok: false, mismatches: ['missing_manifest'], summary };
  if (!summary.engine_hash_ok) return { replay_ok: false, mismatches: ['engine_hash_mismatch'], summary };

  const manifest = eventKind(manifestRecord) === 'run_started' ? manifestRecord.manifest : eventPayload(manifestRecord);
  const game = core.createGame(manifest);
  const checkpoints = records
    .filter((record) => eventKind(record) === 'checkpoint')
    .map((record) => checkpointFromRecord(record))
    .filter(Boolean)
    .sort((a, b) => a.tick - b.tick);
  const commands = buildRecordedCommandSpans(records);
  const terminal = summary.terminal;
  const terminalTick = Number.isInteger(terminal?.tick) && terminal.tick >= 0 ? terminal.tick : null;
  const maxTick = terminalTick ?? (checkpoints.length ? checkpoints.at(-1).tick : 0);
  const mismatches = [];
  const toleratedRoundoff = [];
  const acceptedTerminalCheckpoints = new Map();
  if (!checkpoints.length) mismatches.push('no_checkpoints');
  if (!terminal) mismatches.push('missing_terminal');
  else if (terminalTick === null) mismatches.push('invalid_terminal_tick');
  else {
    if (!checkpoints.some((checkpoint) => checkpoint.tick === terminalTick)) mismatches.push('missing_terminal_checkpoint');
    if (checkpoints.some((checkpoint) => checkpoint.tick > terminalTick)) mismatches.push('checkpoint_after_terminal');
  }
  const verifyCheckpoint = (checkpoint) => {
    const expected = checkpoint.state_hash;
    const actual = core.hashGame(game);
    const mismatch = { tick: checkpoint.tick, expected, actual };
    if (checkpoint.checkpoint == null) {
      if (actual !== expected) mismatches.push({ ...mismatch, reason: 'missing_checkpoint_state' });
      return;
    }
    let storedHash;
    try {
      storedHash = core.hashGame(core.restoreGame(checkpoint.checkpoint));
    } catch {
      mismatches.push({ ...mismatch, reason: 'invalid_checkpoint_state' });
      return;
    }
    if (storedHash !== expected) {
      mismatches.push({ ...mismatch, reason: 'checkpoint_hash_integrity', stored_hash: storedHash });
      return;
    }
    const comparison = compareReplayState(core.serializeGame(game), checkpoint.checkpoint);
    if (!comparison.ok || (actual !== expected && comparison.difference_count === 0)) {
      mismatches.push({ ...mismatch, reason: 'checkpoint_state_mismatch', difference: comparison.mismatch });
      return;
    }
    const diagnostic = {
      ...mismatch,
      difference_count: comparison.difference_count,
      max_abs_difference: comparison.max_abs_difference,
      paths: comparison.paths,
    };
    if (comparison.difference_count) toleratedRoundoff.push({ scope: 'checkpoint', ...diagnostic });
    if (checkpoint.tick === terminalTick) acceptedTerminalCheckpoints.set(expected, diagnostic);
  };
  let checkpointIndex = 0;
  while (checkpointIndex < checkpoints.length && checkpoints[checkpointIndex].tick === 0) {
    verifyCheckpoint(checkpoints[checkpointIndex]);
    checkpointIndex += 1;
  }
  for (let tick = 0; tick < maxTick; tick += 1) {
    core.stepGame(game, commandAtTick(commands, tick));
    while (checkpointIndex < checkpoints.length && checkpoints[checkpointIndex].tick === tick + 1) {
      verifyCheckpoint(checkpoints[checkpointIndex]);
      checkpointIndex += 1;
    }
  }
  if (terminalTick !== null) {
    const actualStatus = core.gameStatus(game);
    const terminalStateMismatches = [];
    for (const field of ['tick', 'sim_ms', 'lives', 'wave', 'score']) {
      const expected = terminal[field];
      if (expected == null) continue;
      const actual = actualStatus[field];
      // Older trace timestamps can be rounded to tenths of a millisecond.
      const matches = field === 'sim_ms'
        ? Number.isFinite(expected) && Math.abs(expected - actual) <= 0.1
        : expected === actual;
      if (!matches) terminalStateMismatches.push({ field, expected, actual });
    }
    const expectedHash = terminal.state_hash ?? terminal.hash;
    if (expectedHash != null) {
      const actual = core.hashGame(game);
      if (expectedHash !== actual) {
        const accepted = acceptedTerminalCheckpoints.get(expectedHash);
        if (accepted?.difference_count > 0) toleratedRoundoff.push({ scope: 'terminal', ...accepted });
        else terminalStateMismatches.push({ field: 'state_hash', expected: expectedHash, actual });
      }
    }
    if (terminalStateMismatches.length) mismatches.push({ terminal_state_mismatches: terminalStateMismatches });
  }
  if (summary.command_decision_mismatches.length) mismatches.push({ command_decision_mismatches: summary.command_decision_mismatches });
  if (summary.decision_response_mismatches.length) mismatches.push({ decision_response_mismatches: summary.decision_response_mismatches });
  if (summary.missing_decision_links.length) mismatches.push({ missing_decision_links: summary.missing_decision_links });
  if (summary.missing_shot_authorizations.length) mismatches.push({ missing_shot_authorizations: summary.missing_shot_authorizations });
  return { replay_ok: mismatches.length === 0, mismatches, summary, numeric_tolerance: REPLAY_NUMERIC_TOLERANCE, tolerated_roundoff: toleratedRoundoff };
}

function latencyStats(samples) {
  const finite = samples.filter((value) => Number.isFinite(value)).slice(-8).sort((a, b) => a - b);
  if (!finite.length) return { expected_delay_ms: DEFAULT_EXPECTED_DELAY_MS, latency_samples: 0, latency_spread_ms: 0 };
  const middle = Math.floor(finite.length / 2);
  const median = finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
  return {
    expected_delay_ms: median,
    latency_samples: finite.length,
    latency_spread_ms: finite.at(-1) - finite[0],
  };
}

function requireGameStatus(core, game) {
  const status = core.gameStatus(game);
  for (const key of ['tick', 'sim_ms', 'lives', 'wave', 'score', 'game_over', 'counters']) {
    if (!(key in status)) throw new Error(`gameStatus missing ${key}`);
  }
  return status;
}

function eventFromControllerEvent(event, defaults) {
  return {
    epoch: defaults.epoch,
    sequence: event.sequence ?? defaults.sequence ?? null,
    tick: defaults.tick,
    sim_ms: defaults.sim_ms,
    wall_ms: defaults.wall_ms,
    type: event.type || 'controller_event',
    payload: { ...event },
  };
}

function responseNormalized(reply) {
  const normalized = {
    movement: reply?.movement ?? null,
    fire: reply?.fire ?? null,
    lease: reply?.lease ?? null,
  };
  if (reply?.intent != null) normalized.intent = reply.intent;
  return normalized;
}

function collectDisplacement(events) {
  return events.reduce((acc, event) => {
    const payload = eventPayload(event);
    const dx = payload.dx ?? payload.displacement?.x ?? 0;
    const dy = payload.dy ?? payload.displacement?.y ?? 0;
    return { dx: acc.dx + (Number(dx) || 0), dy: acc.dy + (Number(dy) || 0) };
  }, { dx: 0, dy: 0 });
}

function createAttemptPaths(outDir, runId) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeRunId = String(runId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  let attemptDir = path.join(outDir, `${timestamp}-${safeRunId}`);
  let suffix = 1;
  while (fs.existsSync(attemptDir)) {
    suffix += 1;
    attemptDir = path.join(outDir, `${timestamp}-${safeRunId}-${suffix}`);
  }
  return {
    attemptDir,
    eventsPath: path.join(attemptDir, 'client-events.jsonl'),
    ledgerPath: path.join(outDir, 'ledger.jsonl'),
  };
}

function resolveExistingTracePath(tracePath) {
  if (!tracePath) return null;
  const candidates = [
    tracePath,
    path.resolve(tracePath),
    path.join(path.dirname(__dirname), tracePath),
    path.join(__dirname, tracePath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function appendLedger(ledgerPath, entry) {
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fsp.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`);
}

async function runLiveBenchmark(options) {
  const modules = loadSpaceModulesFromHtml(options.htmlPath);
  const { core, controller: controllerApi, engineHash } = modules;
  const engineHtmlPath = await archiveEngineHtmlSnapshot({ outDir: options.outDir, engineHash, html: modules.html });
  const difficulty = BENCHMARK_PROFILES[options.profile];
  if (!difficulty) throw new Error(`unknown benchmark profile: ${options.profile}`);
  const manifest = buildManifest({
    seed: options.seed,
    profile: options.profile,
    difficulty,
    engineHash,
    engineVersion: core.ENGINE_VERSION,
    mode: 'cli',
    rules: core.RULES,
  });
  const postJson = options.postJson || ((route, body, timeoutMs) => httpPostJson(options.url, route, body, timeoutMs));
  const started = await postJson('/api/run/start', { schema_version: SCHEMA_VERSION, manifest }, 5000);
  const runId = started.run_id;
  if (!runId) throw new Error('/api/run/start did not return run_id');

  const paths = createAttemptPaths(options.outDir, runId);
  const mirrorLogger = new MirrorLogger(paths.eventsPath);
  await mirrorLogger.append({ type: 'manifest', payload: { ...manifest, run_id: runId, trace_path: started.trace_path || null } }, { sync: true });
  await appendLedger(paths.ledgerPath, { type: 'attempt_started', at: new Date().toISOString(), run_id: runId, manifest, client_trace_path: paths.eventsPath, backend_trace_path: started.trace_path || null, engine_html_path: engineHtmlPath });

  const game = core.createGame(manifest);
  const control = controllerApi.createController({ run_id: runId, epoch: 1 });
  const batcher = new EventBatcher({
    runId,
    postJson,
    mirrorLogger,
    batchSize: 25,
    retryDelayMs: 100,
  });

  const targetMs = options.targetSeconds * 1000;
  const runStart = performance.now();
  let nextTickWallMs = runStart;
  let tick = 0;
  let pendingRequest = null;
  let decisionNeedsTick = false;
  let terminal = null;
  let currentCommandKey = null;
  let currentCommandSpan = null;
  let neutralStart = null;
  let currentEpoch = 1;
  let qualificationViolations = [];
  let nextDecisionWallMs = 0;
  const latencySamples = [];
  const recentCommands = [];
  const recentHits = [];

  const currentWallMs = () => performance.now() - runStart;
  const enqueueEvent = (type, payload, extra = {}) => {
    const status = requireGameStatus(core, game);
    const record = batcher.enqueue({
      epoch: extra.epoch ?? currentEpoch,
      sequence: extra.sequence ?? null,
      tick: extra.tick ?? status.tick ?? tick,
      sim_ms: extra.sim_ms ?? status.sim_ms ?? ((extra.tick ?? tick) * DT_MS),
      wall_ms: extra.wall_ms ?? currentWallMs(),
      type,
      payload,
    }, { sync: type === 'hit' || type === 'terminal' || type === 'checkpoint' && payload?.critical });
    void batcher.flush();
    return record;
  };

  const enqueueControllerEvents = (events, defaults) => {
    for (const event of events || []) {
      const normalized = eventFromControllerEvent(event, defaults);
      batcher.enqueue(normalized);
    }
    void batcher.flush();
  };

  const checkpoint = (critical = false) => {
    const status = requireGameStatus(core, game);
    enqueueEvent('checkpoint', {
      checkpoint: core.serializeGame(game),
      state_hash: core.hashGame(game),
      status,
      critical,
    }, { tick: status.tick, sim_ms: status.sim_ms });
  };

  const startDecision = (requestTick, requestWallMs) => {
    if (pendingRequest || terminal) return;
    const stats = latencyStats(latencySamples);
    const activeCommand = activeCommandForObservation(control.active || null, requestTick, requestWallMs);
    const status = requireGameStatus(core, game);
    const checkpointBody = core.serializeGame(game);
    const checkpointHash = core.hashGame(game);
    const observed = core.observeGame(game, buildObservationContext({
      control,
      stats,
      activeCommand,
      recentCommands,
      recentHits,
      currentSimMs: status.sim_ms,
    }));
    const requestBody = controllerApi.beginDecision(control, {
      tick: requestTick,
      wall_ms: requestWallMs,
      state: observed.state,
      forecast: observed.forecast,
      checkpoint: checkpointBody,
    });
    currentEpoch = requestBody.epoch ?? currentEpoch;
    const sequence = requestBody.sequence;
    const sentAtWallMs = requestWallMs;
    pendingRequest = { sequence, epoch: requestBody.epoch, sentAtWallMs, settled: null };
    enqueueEvent('request_started', {
      sequence,
      state: observed.state,
      forecast: observed.forecast,
      checkpoint_hash: checkpointHash,
      captured_wall_ms: requestWallMs,
      latency_assumption: stats,
    }, { sequence, tick: requestTick, sim_ms: requestTick * DT_MS, wall_ms: requestWallMs });

    const transport = postJson('/api/decision', requestBody, 2600).then((reply) => {
      const receivedWallMs = currentWallMs();
      if (Number.isFinite(reply?.latency_ms)) latencySamples.push(reply.latency_ms);
      if (terminal) {
        enqueueEvent('response_rejected', {
          decision_id: reply?.decision_id ?? null,
          sequence,
          reason: 'terminal',
          api_ok: reply?.api_ok === true,
          valid_choice: reply?.valid_choice === true,
          normalized: responseNormalized(reply),
          movement: reply?.movement ?? null,
          fire: reply?.fire ?? null,
          lease: reply?.lease ?? null,
          latency_ms: reply?.latency_ms ?? null,
          usage: reply?.usage ?? null,
          confidence: reply?.confidence ?? null,
          error: reply?.error ?? null,
          age_ms: receivedWallMs - sentAtWallMs,
          terminal_tick: terminal.tick,
        }, { sequence, tick: terminal.tick, sim_ms: terminal.sim_ms, wall_ms: receivedWallMs });
        pendingRequest = null;
        decisionNeedsTick = false;
        return;
      }
      const events = controllerApi.receiveDecision(control, reply, { tick, wall_ms: receivedWallMs }).events || [];
      const finished = controllerApi.finishDecision(control, { sequence, wall_ms: receivedWallMs });
      enqueueEvent('response_received', {
        decision_id: reply?.decision_id ?? null,
        sequence,
        api_ok: reply?.api_ok === true,
        valid_choice: reply?.valid_choice === true,
        normalized: responseNormalized(reply),
        movement: reply?.movement ?? null,
        fire: reply?.fire ?? null,
        lease: reply?.lease ?? null,
        latency_ms: reply?.latency_ms ?? null,
        usage: reply?.usage ?? null,
        confidence: reply?.confidence ?? null,
        error: reply?.error ?? null,
        age_ms: receivedWallMs - sentAtWallMs,
      }, { sequence, tick, sim_ms: tick * DT_MS, wall_ms: receivedWallMs });
      enqueueControllerEvents(events, { epoch: currentEpoch, sequence, tick, sim_ms: tick * DT_MS, wall_ms: receivedWallMs });
      enqueueControllerEvents(finished?.events || [], { epoch: currentEpoch, sequence, tick, sim_ms: tick * DT_MS, wall_ms: receivedWallMs });
      nextDecisionWallMs = nextDecisionAllowedWallMs(control, receivedWallMs);
      pendingRequest = null;
      decisionNeedsTick = true;
    }).catch((error) => {
      const errorWallMs = currentWallMs();
      if (terminal) {
        enqueueEvent('response_rejected', {
          sequence,
          reason: 'terminal',
          error: error.message,
          transport_error: true,
          normalized: { movement: null, fire: null, lease: null },
          age_ms: errorWallMs - sentAtWallMs,
          terminal_tick: terminal.tick,
        }, { sequence, tick: terminal.tick, sim_ms: terminal.sim_ms, wall_ms: errorWallMs });
        pendingRequest = null;
        decisionNeedsTick = false;
        return;
      }
      const result = controllerApi.finishDecision(control, { sequence, wall_ms: errorWallMs, transport_error: error.message });
      enqueueEvent('response_rejected', {
        sequence,
        reason: 'transport_error',
        error: error.message,
        normalized: { movement: null, fire: null, lease: null },
      }, { sequence, tick, sim_ms: tick * DT_MS, wall_ms: errorWallMs });
      enqueueControllerEvents(result?.events || [], { epoch: currentEpoch, sequence, tick, sim_ms: tick * DT_MS, wall_ms: errorWallMs });
      nextDecisionWallMs = nextDecisionAllowedWallMs(control, errorWallMs);
      pendingRequest = null;
      decisionNeedsTick = true;
    });
    pendingRequest.settled = transport;
  };

  const closeCommandSpan = (endTick, wallMs, cause) => {
    if (!currentCommandSpan) return;
    const span = currentCommandSpan;
    enqueueEvent('command_ended', {
      decision_id: span.command.decision_id,
      sequence: span.command.sequence ?? null,
      movement: span.command.movement,
      fire: span.command.fire,
      lease: span.command.lease,
      start_tick: span.start_tick,
      end_tick: endTick,
      cause,
      displacement: span.displacement,
    }, { sequence: span.command.sequence ?? null, tick: endTick, sim_ms: endTick * DT_MS, wall_ms: wallMs });
    recentCommands.push({
      movement: span.command.movement,
      fire: span.command.fire,
      lease: span.command.lease,
      ...(span.command.intent != null ? { intent: span.command.intent } : {}),
      elapsed_ms: (endTick - span.start_tick) * DT_MS,
      dx: span.displacement.dx,
      dy: span.displacement.dy,
      source: 'djev',
    });
    currentCommandSpan = null;
    currentCommandKey = null;
  };

  const updateCommandSpans = (command, tickForStep, wallMs) => {
    const key = command ? `${command.decision_id}:${command.start_tick}:${command.end_tick}` : null;
    if (key !== currentCommandKey) {
      if (currentCommandKey) closeCommandSpan(tickForStep, wallMs, command ? 'preempted' : 'expiry');
      if (command && neutralStart) {
        enqueueEvent('neutral_ended', { start_tick: neutralStart.tick, end_tick: tickForStep, elapsed_ms: (tickForStep - neutralStart.tick) * DT_MS }, { tick: tickForStep, sim_ms: tickForStep * DT_MS, wall_ms: wallMs });
        recentCommands.push({ movement: 'hold', fire: 'cease', lease: null, elapsed_ms: (tickForStep - neutralStart.tick) * DT_MS, dx: 0, dy: 0, source: 'neutral' });
        neutralStart = null;
      }
      if (command) {
        currentCommandKey = key;
        currentCommandSpan = { command, start_tick: tickForStep, displacement: { dx: 0, dy: 0 } };
        enqueueEvent('command_applied', {
          decision_id: command.decision_id,
          sequence: command.sequence ?? null,
          movement: command.movement,
          fire: command.fire,
          lease: command.lease,
          ...(command.intent != null ? { intent: command.intent } : {}),
          start_tick: command.start_tick,
          end_tick: command.end_tick,
          applied_wall_ms: command.applied_wall_ms,
          expires_wall_ms: command.expires_wall_ms,
        }, { sequence: command.sequence ?? null, tick: tickForStep, sim_ms: tickForStep * DT_MS, wall_ms: wallMs });
      } else if (!neutralStart) {
        neutralStart = { tick: tickForStep, wall_ms: wallMs };
        enqueueEvent('neutral_started', { reason: 'no_authorized_command' }, { tick: tickForStep, sim_ms: tickForStep * DT_MS, wall_ms: wallMs });
      }
    }
  };

  checkpoint(true);
  startDecision(0, 0);

  while (!terminal) {
    const now = performance.now();
    const due = computeDueTicks({ nowMs: now, nextTickWallMs, dtMs: DT_MS, maxLagMs: options.maxLagMs });
    if (due.lagInvalid) {
      qualificationViolations = qualificationViolations.concat('scheduling_lag');
      enqueueEvent('qualification_invalidated', { reason: 'scheduling_lag', lag_ms: due.lagMs }, { tick, sim_ms: tick * DT_MS, wall_ms: currentWallMs() });
      const status = requireGameStatus(core, game);
      terminal = { reason: 'timing_invalid', tick: status.tick, sim_ms: status.sim_ms, wall_ms: currentWallMs(), lives: status.lives, wave: status.wave, score: status.score, qualification_violations: qualificationViolations };
      break;
    }

    if (due.dueTicks === 0) {
      await sleep(Math.min(8, Math.max(0, nextTickWallMs - now)));
      continue;
    }

    for (let i = 0; i < due.dueTicks && !terminal; i += 1) {
      const wallMs = currentWallMs();
      const controllerResult = controllerApi.commandForTick(control, { tick, wall_ms: wallMs });
      enqueueControllerEvents(controllerResult?.events || [], { epoch: currentEpoch, sequence: controllerResult?.command?.sequence ?? null, tick, sim_ms: tick * DT_MS, wall_ms: wallMs });
      const command = controllerResult?.command || null;
      updateCommandSpans(command, tick, wallMs);
      const step = core.stepGame(game, command);
      const movement = collectDisplacement(step?.events || []);
      if (currentCommandSpan) {
        currentCommandSpan.displacement.dx += movement.dx;
        currentCommandSpan.displacement.dy += movement.dy;
      }
      for (const gameEvent of step?.events || []) {
        const payload = eventPayload(gameEvent);
        if (gameEvent.type === 'shot' && payload.owner === 'player' && !payload.decision_id) {
          qualificationViolations = qualificationViolations.concat('unauthorized_player_shot');
        }
        if (gameEvent.type === 'hit') {
          const hitRecord = { ...payload, active_command: command, pending_age_ms: pendingRequest ? wallMs - pendingRequest.sentAtWallMs : null };
          recentHits.push(compactHitForObservation({ type: 'hit', tick: tick + 1, sim_ms: (tick + 1) * DT_MS, payload: hitRecord }, (tick + 1) * DT_MS));
          enqueueEvent('hit', hitRecord, { sequence: command?.sequence ?? null, tick: tick + 1, sim_ms: (tick + 1) * DT_MS, wall_ms: currentWallMs() });
          checkpoint(true);
        } else {
          enqueueEvent(gameEvent.type || 'game_event', payload, { sequence: command?.sequence ?? null, tick: tick + 1, sim_ms: (tick + 1) * DT_MS, wall_ms: currentWallMs() });
        }
      }
      tick += 1;
      nextTickWallMs += DT_MS;
      const status = requireGameStatus(core, game);
      if (tick % 60 === 0) checkpoint(false);
      if (status.game_over || status.lives <= 0) {
        terminal = { reason: 'death', tick: status.tick, sim_ms: status.sim_ms, wall_ms: currentWallMs(), lives: status.lives, wave: status.wave, score: status.score, qualification_violations: qualificationViolations };
      } else if (status.sim_ms >= targetMs && currentWallMs() >= targetMs && status.lives > 0) {
        terminal = { reason: 'target', tick: status.tick, sim_ms: status.sim_ms, wall_ms: currentWallMs(), lives: status.lives, wave: status.wave, score: status.score, qualification_violations: qualificationViolations };
      }
      if (!pendingRequest && decisionNeedsTick) decisionNeedsTick = false;
      const decisionWallMs = currentWallMs();
      if (!pendingRequest && !decisionNeedsTick && !terminal && decisionWallMs >= nextDecisionWallMs) startDecision(status.tick, decisionWallMs);
    }
  }

  checkpoint(true);
  closeCommandSpan(terminal.tick, terminal.wall_ms, terminal.reason);
  if (neutralStart) {
    enqueueEvent('neutral_ended', { start_tick: neutralStart.tick, end_tick: terminal.tick, elapsed_ms: (terminal.tick - neutralStart.tick) * DT_MS }, { tick: terminal.tick, sim_ms: terminal.sim_ms, wall_ms: terminal.wall_ms });
    neutralStart = null;
  }
  batcher.enqueue({ epoch: currentEpoch, sequence: null, tick: terminal.tick, sim_ms: terminal.sim_ms, wall_ms: terminal.wall_ms, type: 'terminal', payload: terminal }, { sync: true });
  const terminalPending = pendingRequest;
  if (terminalPending?.settled) {
    const invalidationEvents = (controllerApi.invalidateController(control, 'terminal')?.events || [])
      .filter((event) => event.type !== 'response_rejected');
    enqueueControllerEvents(invalidationEvents, { epoch: currentEpoch, sequence: terminalPending.sequence, tick: terminal.tick, sim_ms: terminal.sim_ms, wall_ms: terminal.wall_ms });
    await terminalPending.settled;
  } else {
    enqueueControllerEvents(controllerApi.invalidateController(control, 'terminal')?.events || [], { epoch: currentEpoch, sequence: null, tick: terminal.tick, sim_ms: terminal.sim_ms, wall_ms: terminal.wall_ms });
  }
  const endResponse = await batcher.endRun(terminal);
  const backendTracePath = endResponse?.trace_path || started.trace_path || null;
  const resolvedBackendTracePath = resolveExistingTracePath(backendTracePath);
  const backendTraceResolved = !!resolvedBackendTracePath;
  const authoritativeTracePath = resolvedBackendTracePath || paths.eventsPath;
  const authoritativeTraceSource = backendTraceResolved ? 'backend' : 'client_mirror';
  const replay = replayTrace({ tracePath: authoritativeTracePath, htmlPath: options.htmlPath });
  const traceSummary = summarizeTraceRecords(readJsonlRecords(authoritativeTracePath), { expectedEngineHash: engineHash });
  const verdict = classifyVerdict({
    ...terminal,
    source: 'live',
    trace_complete: endResponse?.complete === true,
    replay_ok: replay.replay_ok,
    engine_hash_ok: traceSummary.engine_hash_ok,
    backend_trace_resolved: backendTraceResolved,
    authoritative_trace_source: authoritativeTraceSource,
    profile: traceSummary.profile ?? manifest.profile,
    difficulty: traceSummary.difficulty ?? manifest.difficulty,
  });
  const attemptSummary = {
    run_id: runId,
    profile: traceSummary.profile ?? manifest.profile,
    difficulty: traceSummary.difficulty ?? manifest.difficulty,
    terminal,
    verdict,
    client_trace_path: paths.eventsPath,
    backend_trace_path: backendTracePath,
    resolved_backend_trace_path: resolvedBackendTracePath,
    backend_trace_resolved: backendTraceResolved,
    authoritative_trace_path: authoritativeTracePath,
    authoritative_trace_source: authoritativeTraceSource,
    engine_html_path: engineHtmlPath,
    replay_mismatches: replay.mismatches,
    replay_numeric_tolerance: replay.numeric_tolerance,
    replay_tolerated_roundoff: replay.tolerated_roundoff,
    trace_summary: traceSummary,
  };
  await appendLedger(paths.ledgerPath, { type: 'attempt_finished', at: new Date().toISOString(), ...attemptSummary });
  return attemptSummary;
}

function parseArgs(argv) {
  const options = {
    seed: 20260920,
    profile: 'hardest',
    targetSeconds: DEFAULT_TARGET_SECONDS,
    url: null,
    htmlPath: path.join(__dirname, 'space-shooter.html'),
    outDir: path.join(__dirname, 'runs'),
    maxLagMs: DEFAULT_MAX_LAG_MS,
    replayPath: null,
    reportPath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--seed') options.seed = Number(readValue());
    else if (arg === '--profile') options.profile = readValue();
    else if (arg === '--target-seconds') options.targetSeconds = Number(readValue());
    else if (arg === '--url') options.url = readValue();
    else if (arg === '--html') options.htmlPath = path.resolve(readValue());
    else if (arg === '--out-dir') options.outDir = path.resolve(readValue());
    else if (arg === '--max-lag-ms') options.maxLagMs = Number(readValue());
    else if (arg === '--replay') options.replayPath = path.resolve(readValue());
    else if (arg === '--report') options.reportPath = path.resolve(readValue());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');
  if (!Number.isFinite(options.targetSeconds) || options.targetSeconds <= 0) throw new Error('--target-seconds must be positive');
  if (!Number.isFinite(options.maxLagMs) || options.maxLagMs <= 0) throw new Error('--max-lag-ms must be positive');
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node demo/benchmark.cjs --seed 20260920 --profile hardest --target-seconds 121 --url http://127.0.0.1:7865',
    '  node demo/benchmark.cjs --seed 20260920 --profile dense-mid-speed --target-seconds 121 --url http://127.0.0.1:7865',
    '  node demo/benchmark.cjs --replay demo/runs/<run_id>/events.jsonl',
    '  node demo/benchmark.cjs --report demo/runs/<run_id>/events.jsonl',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.replayPath) {
    console.log(JSON.stringify(replayTrace({ tracePath: options.replayPath, htmlPath: options.htmlPath }), null, 2));
    return;
  }
  if (options.reportPath) {
    console.log(JSON.stringify(buildTraceReport({ tracePath: options.reportPath, htmlPath: options.htmlPath }), null, 2));
    return;
  }
  const summary = await runLiveBenchmark(options);
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CONTEXT_VERSION,
  BENCHMARK_PROFILES,
  DEFAULT_RULES,
  DENSE_MID_SPEED_PROFILE,
  EventBatcher,
  HARDEST_PROFILE,
  INTENT_IDS,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  activeCommandForObservation,
  archiveEngineHtmlSnapshot,
  buildDeathWindowReport,
  buildManifest,
  buildObservationContext,
  buildTraceReport,
  classifyVerdict,
  checkpointFromRecord,
  compactHitForObservation,
  compareReplayState,
  computeDueTicks,
  extractInlineScript,
  hashSourcePair,
  latencyStats,
  loadSpaceModulesFromHtml,
  nextDecisionAllowedWallMs,
  parseArgs,
  readJsonlRecords,
  recentHitsForObservation,
  resolveExistingTracePath,
  replayTrace,
  runLiveBenchmark,
  summarizeTraceRecords,
  buildRecordedCommandSpans,
};
