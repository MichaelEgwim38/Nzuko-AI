import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReconciledReport, generateReconciledWorkflowReport, minimiseText } from '../src/reconciliationAgent.js';

test('removes common identifiers before external reconciliation', () => {
  const result = minimiseText('Call +44 7700 900123, email ada@example.com or visit https://example.com/x. ID 123456789@c.us');
  assert.equal(result.includes('ada@example.com'), false);
  assert.equal(result.includes('7700'), false);
  assert.equal(result.includes('example.com'), false);
  assert.equal(result.includes('123456789'), false);
  assert.match(result, /\[email removed\]/);
  assert.match(result, /\[phone removed\]|\[identifier removed\]/);
});

const intelligence = {
  reportPeriod: 'Today', sources: ['WhatsApp'], executiveSummary: 'The payment policy remains unresolved and Yusuf owns receipt reporting.',
  decisions: [],
  actions: [{ owner: 'Yusuf', task: 'Collect receipts and report totals', dueOrSchedule: 'Every Saturday', status: 'NEW', source: 'WhatsApp', time: 'Time not captured', confidence: 'HIGH', relatedDecision: 'Receipt reporting responsibility' }],
  discussionPoints: ['Late-payment policy'], blockersRisksEscalations: [], openQuestions: ['What penalty, if any, should apply?'],
  voiceNoteReview: [], followUps: ['Review the payment policy'], humanReviewFlags: ['Confirm the final payment policy'],
};

test('formats the required reconciled report sections', () => {
  const report = formatReconciledReport(intelligence, { groupName: 'Community team', mode: 'community-charity' });
  assert.match(report, /NZUKO AI REPORT/);
  assert.match(report, /Owner: Yusuf/);
  assert.match(report, /Due date\/schedule: Every Saturday/);
  assert.match(report, /No confirmed decisions identified/);
  assert.match(report, /HUMAN REVIEW REQUIRED/);
});

test('uses the conservative engine when no API key is configured', async () => {
  const report = await generateReconciledWorkflowReport({ chatText: 'Ada: No final penalty was approved.', groupName: 'Team', workflowType: 'meeting-minutes' });
  assert.notEqual(report.reconciliationEngine, 'semantic-ai');
  assert.doesNotMatch(report.decisions.join(' '), /final penalty was approved/i);
});
