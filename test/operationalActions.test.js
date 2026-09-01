import test from 'node:test';
import assert from 'node:assert/strict';
import { actionView, actionsFromApprovedRecap, updateOperationalAction } from '../src/operationalActions.js';

test('promotes approved recap actions into accountable operational actions', () => {
  const actions = actionsFromApprovedRecap(
    { actions: ['David: I will call maintenance tomorrow.', 'Manager: Urgent safety check today.'] },
    { id: 'audit-1', groupName: 'Site team', approvedAt: '2026-09-01T10:00:00.000Z' },
  );
  assert.equal(actions.length, 2);
  assert.equal(actions[0].owner, 'David');
  assert.equal(actions[0].dueDate, '2026-09-02');
  assert.equal(actions[1].priority, 'urgent');
  assert.equal(actions[1].escalated, true);
  assert.equal(actions[0].sourceReportId, 'audit-1');
});

test('keeps placeholder action text out of the official register', () => {
  assert.deepEqual(actionsFromApprovedRecap({ actions: ['No action item with owner found. Add owner and deadline if the group has one.'] }), []);
});

test('acknowledges, completes and derives overdue status', () => {
  const original = { id: 'a1', title: 'Inspect alarm', status: 'open', acknowledgement: 'pending', dueDate: '2026-08-30' };
  const acknowledged = updateOperationalAction(original, { acknowledgement: 'acknowledged' }, { name: 'Egwim' });
  assert.equal(acknowledged.acknowledgedBy, 'Egwim');
  assert.equal(actionView(acknowledged, new Date('2026-09-01T12:00:00Z')).overdue, true);
  const done = updateOperationalAction(acknowledged, { status: 'done' }, { name: 'Egwim' });
  assert.equal(actionView(done, new Date('2026-09-01T12:00:00Z')).overdue, false);
});
