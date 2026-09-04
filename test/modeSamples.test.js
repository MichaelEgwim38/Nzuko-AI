import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleScenarioForMode, sampleScenarios } from '../src/connectors/mockWhatsApp.js';
import { generateWorkflowReport } from '../src/workflowTemplates.js';

const workflowByMode = {
  'healthcare-operations': 'shift-handover',
  'property-facilities': 'custom',
  'field-service': 'project-update',
  'community-charity': 'meeting-minutes',
  personal: 'custom',
};

test('provides a distinct real-world sample for every Nzuko Mode', () => {
  assert.equal(Object.keys(sampleScenarios).length, 5);
  assert.equal(new Set(Object.values(sampleScenarios).map((sample) => sample.groupName)).size, 5);

  for (const [mode, workflowType] of Object.entries(workflowByMode)) {
    const sample = sampleScenarioForMode(mode);
    const recap = generateWorkflowReport({ ...sample, workflowType });
    assert.match(recap.text, new RegExp(sample.groupName, 'i'));
    assert.doesNotMatch(recap.text, /Owner: Voice note from/i);
    assert.doesNotMatch(recap.text, /will handle:\s*(?:I will|Decision:)/i);
  }
});

test('community sample merges related commitments and keeps proposals unresolved', () => {
  const sample = sampleScenarioForMode('community-charity');
  const recap = generateWorkflowReport({ ...sample, workflowType: 'meeting-minutes' });
  const actions = recap.text.split('Action Register:')[1].split('Discussion points:')[0];
  assert.equal((actions.match(/Owner: Yusuf/gi) || []).length, 1);
  assert.match(actions, /Collect the hired van/i);
  assert.match(actions, /Publish the final rota/i);
  assert.doesNotMatch(recap.text.split('Confirmed Outcomes:')[1].split('Action Register:')[0], /second distribution session/i);
});
