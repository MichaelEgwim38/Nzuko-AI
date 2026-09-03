import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPrivacyRetention } from '../src/privacyRetention.js';

const NOW = new Date('2026-09-03T12:00:00.000Z').getTime();

test('expires an unapproved draft after 24 hours', () => {
  const state = {
    settings: { approvedRetentionDays: 90 },
    currentDraft: { id: 'draft-old', createdAt: '2026-09-02T11:59:59.000Z' },
    auditLog: [],
    operationalActions: [],
  };

  const result = applyPrivacyRetention(state, { now: NOW });
  assert.equal(result.changed, true);
  assert.equal(state.currentDraft, null);
});

test('keeps a draft within its 24-hour review window', () => {
  const state = {
    settings: { approvedRetentionDays: 90 },
    currentDraft: { id: 'draft-new', createdAt: '2026-09-02T12:00:01.000Z' },
    auditLog: [],
    operationalActions: [],
  };

  const result = applyPrivacyRetention(state, { now: NOW });
  assert.equal(result.changed, false);
  assert.equal(state.currentDraft.id, 'draft-new');
});

test('removes expired approved reports and their linked actions', () => {
  const state = {
    settings: { approvedRetentionDays: 30 },
    currentDraft: null,
    auditLog: [
      { id: 'old-report', approvedAt: '2026-08-01T12:00:00.000Z' },
      { id: 'new-report', approvedAt: '2026-08-20T12:00:00.000Z' },
    ],
    operationalActions: [
      { id: 'old-action', sourceReportId: 'old-report', createdAt: '2026-08-01T12:00:00.000Z' },
      { id: 'new-action', sourceReportId: 'new-report', createdAt: '2026-08-20T12:00:00.000Z' },
    ],
  };

  applyPrivacyRetention(state, { now: NOW });
  assert.deepEqual(state.auditLog.map(({ id }) => id), ['new-report']);
  assert.deepEqual(state.operationalActions.map(({ id }) => id), ['new-action']);
});

test('caps approved retention at 365 days', () => {
  const state = {
    settings: { approvedRetentionDays: 900 },
    currentDraft: null,
    auditLog: [],
    operationalActions: [],
  };

  const result = applyPrivacyRetention(state, { now: NOW });
  assert.equal(result.approvedRetentionDays, 365);
  assert.equal(state.settings.approvedRetentionDays, 365);
});
