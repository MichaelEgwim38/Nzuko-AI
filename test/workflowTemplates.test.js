import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkflowReport, normaliseWorkflowType } from '../src/workflowTemplates.js';

const input = {
  groupName: 'Operations Team',
  chatText: [
    'Grace: The washing machine is leaking again.',
    'David: I will call maintenance tomorrow.',
    'Mary: We agreed to order more gloves.',
    'Manager: Can we find cover for the morning shift?',
  ].join('\n'),
};

test('generates purpose-specific output from the same conversation', () => {
  const meeting = generateWorkflowReport({ ...input, workflowType: 'meeting-minutes' });
  const handover = generateWorkflowReport({ ...input, workflowType: 'shift-handover' });
  const project = generateWorkflowReport({ ...input, workflowType: 'project-update' });

  assert.match(meeting.text, /MEETING MINUTES/);
  assert.match(handover.text, /SHIFT HANDOVER/);
  assert.match(handover.text, /Action register:/);
  assert.match(handover.text, /Context for the incoming shift:/);
  assert.match(project.text, /PROJECT UPDATE/);
  assert.match(project.text, /Blockers and confirmations required:/);
  assert.notEqual(meeting.text, handover.text);
});

test('includes workspace instructions in a custom workflow draft', () => {
  const report = generateWorkflowReport({
    ...input,
    workflowType: 'custom',
    customInstructions: 'Identify customer promises and follow-up dates.',
  });

  assert.equal(report.workflowType, 'custom');
  assert.match(report.text, /Identify customer promises and follow-up dates/);
  assert.match(report.text, /Human review required/);
});

test('falls back safely to meeting minutes for unknown legacy values', () => {
  assert.equal(normaliseWorkflowType('unknown'), 'meeting-minutes');
});
