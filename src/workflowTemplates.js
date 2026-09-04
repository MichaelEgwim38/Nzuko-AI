import { generateRecap } from './minutesAgent.js';

export const workflowTemplates = [
  { id: 'meeting-minutes', name: 'Meeting Minutes', description: 'Decisions, actions, discussion points and open questions.' },
  { id: 'shift-handover', name: 'Shift Handover', description: 'Completed work, outstanding actions, concerns and next-shift notes.' },
  { id: 'project-update', name: 'Project Update', description: 'Progress, blockers, decisions, owners and next steps.' },
  { id: 'custom', name: 'Custom Workflow', description: 'A flexible report guided by your workspace instructions.' },
];

export function normaliseWorkflowType(value = '') {
  const type = String(value || '').trim().toLowerCase();
  return workflowTemplates.some((template) => template.id === type) ? type : 'meeting-minutes';
}

export function workflowTemplate(value = '') {
  const type = normaliseWorkflowType(value);
  return workflowTemplates.find((template) => template.id === type);
}

function bullets(items = []) {
  return items.map((item) => `- ${item}`).join('\n');
}

function section(title, items, fallback) {
  const useful = (items || []).filter((item) => item && !/^no .* (found|detected|captured)/i.test(item));
  return `${title}:\n${bullets(useful.length ? useful : [fallback])}`;
}

function numbered(items = []) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function actionRegister(recap, fallback = 'No outstanding action was identified.') {
  const actions = recap.actionDetails || [];
  if (!actions.length) return fallback;
  return numbered(actions.map((action) => {
    const due = action.due && action.due !== 'Not stated' ? ` | Due: ${action.due}` : ' | Due: confirm during review';
    return `${action.task}\n   Owner: ${action.owner}${due}`;
  }));
}

function confirmedOutcomes(recap, fallback = 'No confirmed outcome was identified.') {
  const outcomes = (recap.decisionDetails || []).map((item) => item.outcome);
  return outcomes.length ? numbered(outcomes) : fallback;
}

function itemsForDecision(recap, fallback = 'No unresolved matter was identified.') {
  const issues = (recap.unresolvedDetails || []).map((item) => item.issue);
  return issues.length ? numbered(issues) : fallback;
}

function workflowText(recap, type, customInstructions = '') {
  const header = `${workflowTemplate(type).name.toUpperCase()} - ${recap.dateLabel}\nWorkspace: ${recap.groupName}\nCoverage: ${recap.coverageLabel}\nStatus: Draft for human review`;
  const review = 'Human review required:\nConfirm owners, deadlines, priorities and sensitive information before approval.';

  if (type === 'shift-handover') {
    return `${header}\n\nConfirmed handover outcomes:\n${confirmedOutcomes(recap, 'No handover outcome has been confirmed yet.')}\n\nAction register:\n${actionRegister(recap)}\n\nRisks and confirmations required:\n${itemsForDecision(recap, 'No operational concern was identified.')}\n\nContext for the incoming shift:\n${bullets(recap.points)}\n\n${review}`;
  }
  if (type === 'project-update') {
    return `${header}\n\nCurrent position:\n${bullets(recap.points)}\n\nConfirmed outcomes:\n${confirmedOutcomes(recap)}\n\nNext-action register:\n${actionRegister(recap, 'No next action was identified.')}\n\nBlockers and confirmations required:\n${itemsForDecision(recap, 'No blocker was identified.')}\n\n${review}`;
  }
  if (type === 'custom') {
    const focus = String(customInstructions || '').trim() || 'No custom instructions supplied; organise the important outcomes for review.';
    return `${header}\n\nReport focus:\n${focus}\n\nCurrent position:\n${bullets(recap.points)}\n\nConfirmed outcomes:\n${confirmedOutcomes(recap)}\n\nAction register:\n${actionRegister(recap, 'No action was identified.')}\n\nItems requiring confirmation:\n${itemsForDecision(recap)}\n\n${review}`;
  }
  return recap.text.replace(/^NZUKO AI DAILY MINUTES/, 'NZUKO AI MEETING MINUTES');
}

export function generateWorkflowReport({ workflowType, customInstructions, ...input }) {
  const type = normaliseWorkflowType(workflowType);
  const recap = generateRecap(input);
  const template = workflowTemplate(type);
  return {
    ...recap,
    workflowType: type,
    workflowName: template.name,
    customInstructions: type === 'custom' ? String(customInstructions || '').trim() : '',
    text: workflowText(recap, type, customInstructions),
  };
}
