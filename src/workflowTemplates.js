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

function workflowText(recap, type, customInstructions = '') {
  const header = `${workflowTemplate(type).name.toUpperCase()} - ${recap.dateLabel}\nWorkspace: ${recap.groupName}\nCoverage: ${recap.coverageLabel}\nStatus: Draft for human review`;
  const review = 'Human review required:\nConfirm owners, deadlines, priorities and sensitive information before approval.';

  if (type === 'shift-handover') {
    return `${header}\n\n${section('Completed / confirmed', recap.decisions, 'No completed work was confirmed.')}\n\n${section('Outstanding actions', recap.actions, 'No outstanding action was detected.')}\n\n${section('Operational concerns', recap.unresolved, 'No operational concern was detected.')}\n\n${section('Information for the next shift', recap.points, 'No additional handover note was captured.')}\n\n${review}`;
  }
  if (type === 'project-update') {
    return `${header}\n\n${section('Progress and key updates', recap.points, 'No progress update was captured.')}\n\n${section('Decisions', recap.decisions, 'No confirmed decision was detected.')}\n\n${section('Actions and next steps', recap.actions, 'No next action was detected.')}\n\n${section('Blockers and questions', recap.unresolved, 'No blocker was detected.')}\n\n${review}`;
  }
  if (type === 'custom') {
    const focus = String(customInstructions || '').trim() || 'No custom instructions supplied; organise the important outcomes for review.';
    return `${header}\n\nWorkspace instructions:\n${focus}\n\n${section('Key information', recap.points, 'No key information was captured.')}\n\n${section('Confirmed outcomes', recap.decisions, 'No confirmed outcome was detected.')}\n\n${section('Actions', recap.actions, 'No action was detected.')}\n\n${section('Items needing attention', recap.unresolved, 'No unresolved item was detected.')}\n\n${review}`;
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
