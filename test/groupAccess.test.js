import test from 'node:test';
import assert from 'node:assert/strict';
import { applyApprovedGroups, entitledApprovedGroups, groupLimitForPlan, normaliseApprovedGroups } from '../src/groupAccess.js';

test('migrates the legacy selected group into the approved group list', () => {
  assert.deepEqual(normaliseApprovedGroups({ approvedGroupId: 'one@g.us', approvedGroupName: 'One' }), [{ id: 'one@g.us', name: 'One' }]);
});

test('deduplicates approved WhatsApp groups', () => {
  assert.equal(normaliseApprovedGroups({ approvedGroups: [{ id: 'one@g.us' }, { id: 'one@g.us' }] }).length, 1);
});

test('keeps an active group when applying a multi-group selection', () => {
  const settings = applyApprovedGroups({ approvedGroupId: 'two@g.us' }, [{ id: 'one@g.us' }, { id: 'two@g.us', name: 'Two' }]);
  assert.equal(settings.approvedGroupId, 'two@g.us');
});

test('limits Pro to five groups and other plans to one', () => {
  assert.equal(groupLimitForPlan('starter'), 1);
  assert.equal(groupLimitForPlan('pro'), 5);
  assert.equal(groupLimitForPlan('trial'), 1);
});

test('enforces effective group access immediately after a Pro downgrade', () => {
  const settings = { approvedGroups: Array.from({ length: 5 }, (_, index) => ({ id: `${index}@g.us` })) };
  assert.equal(entitledApprovedGroups(settings, 'pro').length, 5);
  assert.equal(entitledApprovedGroups(settings, 'starter').length, 1);
});
