const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

const html = readFileSync(join(__dirname, 'space-shooter.html'), 'utf8');
const match = html.match(/<script id="space-decision-core">([\s\S]*?)<\/script>/);
assert.ok(match, 'inline production core must exist');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(match[1], sandbox);
const core = sandbox.SpaceDecisionCore;
assert.ok(core, 'inline core must export SpaceDecisionCore');

const player = (x = 480, y = 420) => ({ x, y, w: 20, h: 18 });
const bullet = (x, y, vx = 0, vy = 0) => ({ x, y, vx, vy, w: 8, h: 8, kind: 'bullet' });
const snapshot = ({ x = 480, y = 420, bullets = [], enemies = [], width = 960, height = 620 } = {}) => ({
  width, height, player: player(x, y), bullets, enemies, waveProfile: core.waveProfile(1),
});
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('receding and parallel non-overlapping threats do not fabricate contact', () => {
  const segment = { t0: 0, t1: 0.6, p0: { x: 480, y: 420 }, p1: { x: 480, y: 420 } };
  assert.equal(core.sweptContact(segment, bullet(480, 470, 0, 170), { x: 14, y: 13 }), null);
  assert.equal(core.sweptContact(segment, bullet(480, 420, 0, 170), { x: 14, y: 13 }), 0);
  assert.equal(core.sweptContact(segment, bullet(520, 420, 0, 0), { x: 14, y: 13 }), null);
});

test('time-aligned sweep catches a moving crossing and rejects a late geometric crossing', () => {
  const moving = core.planAction(player(400, 400), 'right', 240, 600, core.arenaFor(960, 620, 20, 18));
  const contact = core.sweptContact(moving.segments[0], bullet(416.8, 330, 0, 70 / 0.15), { x: 14, y: 13 });
  assert.ok(contact >= 0.12 && contact <= 0.18, `contact=${contact}`);
  assert.equal(core.sweptContact(moving.segments[0], bullet(416.8, 260, 0, 70 / 0.5), { x: 14, y: 13 }), null);
});

test('stopped tail is evaluated, boundary touch is contact, and zero-axis velocity works', () => {
  const planned = core.planAction(player(400, 400), 'right', 240, 600, core.arenaFor(960, 620, 20, 18));
  const endpoint = planned.endpoint;
  const hitsTail = bullet(endpoint.x, 300, 0, (endpoint.y - 13 - 300) / 0.4);
  const contacts = planned.segments.map((s) => core.sweptContact(s, hitsTail, { x: 14, y: 13 })).filter((x) => x !== null);
  assert.ok(contacts.some((x) => x >= 0.39 && x <= 0.401));
  assert.equal(core.sweptContact(planned.segments[0], bullet(414, 400), { x: 14, y: 13 }), 0);
  assert.equal(core.sweptContact(planned.segments[0], bullet(400, 450, 112, 0), { x: 14, y: 13 }), null);
});

test('all active threats are considered without dilution or truncation', () => {
  const danger = bullet(480, 360, 0, 120);
  const harmless = Array.from({ length: 12 }, (_, i) => bullet(40 + i * 25, 40, -10, 0));
  const candidate = (items) => core.evaluateCandidates(snapshot({ bullets: items }), 'hold').find((c) => c.id === 'hold');
  const one = candidate([danger]);
  const seven = candidate(harmless.slice(0, 7).concat(danger));
  const manyBefore = candidate(harmless.concat(danger));
  assert.notEqual(one.collisionTime, null);
  near(seven.collisionTime, one.collisionTime);
  near(manyBefore.collisionTime, one.collisionTime);
  assert.ok(seven.clearance <= one.clearance && manyBefore.clearance <= one.clearance);
});

test('safety gate permits emergency escape beyond the old preferred corridor', () => {
  const s = snapshot({ x: 246, y: 420, bullets: [bullet(274, 420, -40, 0), bullet(246, 380, 0, 100), bullet(246, 460, 0, -100)] });
  const chosen = core.chooseFallback(core.evaluateCandidates(s, 'hold'));
  assert.equal(chosen.id, 'left');
  assert.ok(chosen.endpoint.x < 250);
  assert.ok(chosen.endpoint.x >= core.arenaFor(960, 620, 20, 18).left);
  assert.equal(chosen.collisionTime, null);
});

test('room and continuity yield deterministic stable local choices', () => {
  assert.equal(core.chooseFallback(core.evaluateCandidates(snapshot({ x: 20, y: 20 }), 'hold')).id, 'down_right');
  assert.equal(core.chooseFallback(core.evaluateCandidates(snapshot({ x: 480, y: 620 * 0.68 }), 'hold')).id, 'hold');
  assert.equal(core.chooseFallback(core.evaluateCandidates(snapshot({ x: 480, y: 620 * 0.68 }), 'left')).id, 'left');
  let prior = 'hold';
  for (let i = 0; i < 20; i += 1) {
    const selected = core.chooseFallback(core.evaluateCandidates(snapshot({ x: 480, y: 620 * 0.68 }), prior));
    assert.equal(selected.id, 'hold');
    prior = selected.id;
  }
});

test('no-threat fallback converges toward center from the far upper-left arena', () => {
  const far = snapshot({ x: 120, y: 200 });
  const selected = core.chooseFallback(core.evaluateCandidates(far, 'hold'));
  assert.equal(selected.id, 'down_right');
  const before = Math.hypot(far.player.x - 480, far.player.y - 620 * 0.68);
  const planned = core.planAction(far.player, selected.id, 240, 600, core.arenaFor(960, 620, 20, 18));
  const after = Math.hypot(planned.endpoint.x - 480, planned.endpoint.y - 620 * 0.68);
  assert.ok(after < before);
});

test('all-unsafe state reports best effort without claiming safety', () => {
  const blockers = [bullet(480, 420), bullet(450, 420), bullet(510, 420), bullet(480, 390), bullet(480, 450), bullet(450, 390), bullet(510, 390), bullet(450, 450), bullet(510, 450)];
  const candidates = core.evaluateCandidates(snapshot({ bullets: blockers }), 'hold');
  const picked = core.chooseFallback(candidates);
  assert.equal(picked.no_safe_candidate, true);
  assert.notEqual(picked.collisionTime, null);
  assert.equal(core.shouldRequestModel(candidates), false);
});

test('accepted model choice has direct bounded displacement even when soft score is worse', () => {
  for (const [id, sign] of [['left', -1], ['right', 1]]) {
    const s = snapshot({ x: 480, y: 421.6 });
    const request = core.makeRequestRecord(core.createLifecycle(4), core.evaluateCandidates(s, 'hold'), 100, {});
    const accepted = core.acceptReply({ epoch: 4, sequence: request.record.sequence, movement: id, valid_choice: true, api_ok: true }, request.record, request.lifecycle, 200, { running: true, autopilot: true });
    assert.equal(accepted.event.type, 'selected');
    const resolved = core.resolveAction(s, accepted.lifecycle, 1000);
    assert.equal(resolved.execution.id, id);
    assert.equal(resolved.execution.source, 'jev');
    const advanced = core.advancePlayer(s.player, resolved.execution, 0.1, core.arenaFor(960, 620, 20, 18), 1000);
    assert.equal(Math.sign(advanced.displacement.x), sign);
  }
});

test('expiry and frame splitting cap model influence to authorized time', () => {
  const execution = { id: 'right', source: 'jev', expiresAtMs: 1010, startedAtMs: 770 };
  const result = core.advancePlayer(player(400, 400), execution, 0.034, core.arenaFor(960, 620, 20, 18), 1000);
  near(result.appliedMs, 10);
  near(result.unconsumedMs, 24);
  near(result.displacement.x, 1.12);
});

test('arrival and mid-command hazards override model choice with explicit reasons', () => {
  const clear = snapshot({ x: 480, y: 420 });
  const req = core.makeRequestRecord(core.createLifecycle(2), core.evaluateCandidates(clear, 'hold'), 0, {});
  const accepted = core.acceptReply({ epoch: 2, sequence: req.record.sequence, movement: 'left', valid_choice: true, api_ok: true }, req.record, req.lifecycle, 10, { running: true, autopilot: true });
  const changed = snapshot({ x: 480, y: 420, bullets: [bullet(450, 420, 0, 0)] });
  const arrival = core.resolveAction(changed, accepted.lifecycle, 20);
  assert.equal(arrival.event.reason, 'unsafe_on_arrival');
  assert.notEqual(arrival.execution.id, 'left');
  const activeLife = { ...core.createLifecycle(3), active: { id: 'right', source: 'jev', startedAtMs: 0, expiresAtMs: 240, counted: true } };
  const mid = core.resolveAction(snapshot({ x: 480, y: 420, bullets: [bullet(510, 420, 0, 0)] }), activeLife, 50);
  assert.equal(mid.event.reason, 'new_collision');
  assert.notEqual(mid.execution.id, 'right');
});

test('freshness, epoch, sequence, and pending identity gates reject stale replies', () => {
  const req = core.makeRequestRecord(core.createLifecycle(8), core.evaluateCandidates(snapshot(), 'hold'), 100, {});
  const reply = { epoch: 8, sequence: req.record.sequence, movement: 'hold', valid_choice: true, api_ok: true };
  assert.equal(core.validateReply(reply, req.record, req.lifecycle, 700, { running: true, autopilot: true }).ok, true);
  assert.equal(core.validateReply(reply, req.record, req.lifecycle, 701, { running: true, autopilot: true }).reason, 'age');
  assert.equal(core.validateReply({ ...reply, epoch: 7 }, req.record, req.lifecycle, 200, { running: true, autopilot: true }).reason, 'stale_epoch');
  assert.equal(core.validateReply(reply, req.record, { ...req.lifecycle, lastAcceptedSequence: req.record.sequence }, 200, { running: true, autopilot: true }).reason, 'stale_sequence');
  assert.equal(core.validateReply(reply, req.record, { ...req.lifecycle, pending: {} }, 200, { running: true, autopilot: true }).reason, 'superseded_request');
  for (const status of [{ running: false, autopilot: true }, { running: true, autopilot: false }]) assert.equal(core.validateReply(reply, req.record, req.lifecycle, 200, status).ok, false);
});

test('queued model choice is rechecked against wall-clock age before simulation execution', () => {
  const s = snapshot();
  const req = core.makeRequestRecord(core.createLifecycle(9), core.evaluateCandidates(s, 'hold'), 100, {});
  const accepted = core.acceptReply({ epoch: 9, sequence: req.record.sequence, movement: 'left', valid_choice: true, api_ok: true }, req.record, req.lifecycle, 200, { running: true, autopilot: true });
  const resolved = core.resolveAction(s, accepted.lifecycle, 50, 701);
  assert.equal(resolved.execution.source, 'local');
  assert.equal(resolved.event.reason, 'age');
  assert.equal(resolved.event.selected, 'left');
});

test('invalidation clears commands and old callbacks cannot clear newer pending work', () => {
  const req1 = { epoch: 1, sequence: 1 };
  const req2 = { epoch: 1, sequence: 2 };
  const life = { ...core.createLifecycle(1), pending: req2, queued: { id: 'left' }, active: { id: 'left' }, executedCount: 0 };
  assert.equal(core.clearPendingIfCurrent(life, req1).pending, req2);
  assert.equal(core.clearPendingIfCurrent(life, req2).pending, null);
  const invalid = core.invalidateLifecycle(life, 'manual');
  assert.equal(invalid.epoch, 2);
  assert.equal(invalid.pending, null);
  assert.equal(invalid.queued, null);
  assert.equal(invalid.active, null);
  assert.equal(invalid.executedCount, 0);
});

test('accepted but unapplied does not count; local fallback runs while request is pending', () => {
  const req = core.makeRequestRecord(core.createLifecycle(1), core.evaluateCandidates(snapshot(), 'hold'), 0, {});
  const accepted = core.acceptReply({ epoch: 1, sequence: req.record.sequence, movement: 'left', valid_choice: true, api_ok: true }, req.record, req.lifecycle, 1, { running: true, autopilot: true });
  assert.equal(accepted.lifecycle.executedCount, 0);
  assert.equal(core.resolveAction(snapshot(), req.lifecycle, 50).execution.source, 'local');
});

test('wave profile and progression are independent of model selections and failures', () => {
  const first = core.waveProfile(1);
  assert.equal(first.difficulty, 'normal');
  assert.equal(core.waveProfile(1).enemyType, 'scout');
  assert.equal(core.waveProfile(2).enemyType, 'swarm');
  assert.equal(core.waveProfile(3).enemyType, 'tank');
  assert.equal(core.waveProfile(4).enemyType, first.enemyType);
  const a = core.nextWaveState({ wave: 1, profile: first }, { movement: 'left' });
  const b = core.nextWaveState({ wave: 1, profile: first }, { api_ok: false });
  assert.equal(a.wave, 2);
  assert.equal(b.wave, 2);
  assert.equal(a.profile.enemyType, b.profile.enemyType);
});

test('rolling completion rate is measured over completed request events, not reciprocal latency', () => {
  near(core.rollingCompletedRate([0, 3000, 9000, 10001], 10001, 10000), 0.3);
});

test('restart restores the visible auto-pilot label after manual takeover', () => {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  const elements = new Map();
  const makeElement = (id) => {
    const listeners = {};
    const element = {
      id, textContent: '', innerHTML: '', listeners,
      addEventListener(type, handler) { listeners[type] = handler; },
    };
    if (id === 'game') Object.assign(element, {
      width: 960, height: 620,
      getContext() { return {}; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 620 }; },
    });
    return element;
  };
  const ui = {
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); } },
    performance: { now: () => 1000 },
    crypto: { randomUUID: () => 'test-run-id' },
    requestAnimationFrame() {},
    addEventListener() {},
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  ui.window = ui;
  vm.createContext(ui);
  vm.runInContext(scripts[0][1], ui);
  vm.runInContext(scripts[1][1], ui);
  const autoButton = elements.get('autopilot-button');
  const restartButton = elements.get('restart-button');
  assert.equal(autoButton.textContent, 'Auto pilot: ON');
  autoButton.listeners.click();
  assert.equal(autoButton.textContent, 'Auto pilot: OFF');
  restartButton.listeners.click();
  assert.equal(autoButton.textContent, 'Auto pilot: ON');
});
