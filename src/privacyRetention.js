const DAY_MS = 24 * 60 * 60 * 1000;

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function applyPrivacyRetention(state = {}, { now = Date.now(), draftHours = 24 } = {}) {
  const approvedDays = Math.min(365, Math.max(1, Number(state.settings?.approvedRetentionDays || 90)));
  const draftCutoff = now - Math.max(1, Number(draftHours || 24)) * 60 * 60 * 1000;
  const approvedCutoff = now - approvedDays * DAY_MS;
  let changed = false;

  state.settings ||= {};
  if (state.settings.approvedRetentionDays !== approvedDays) {
    state.settings.approvedRetentionDays = approvedDays;
    changed = true;
  }

  if (state.currentDraft && timestamp(state.currentDraft.createdAt) < draftCutoff) {
    state.currentDraft = null;
    changed = true;
  }

  const audits = Array.isArray(state.auditLog) ? state.auditLog : [];
  const retainedAudits = audits.filter((entry) => timestamp(entry.approvedAt) >= approvedCutoff);
  const retainedIds = new Set(retainedAudits.map((entry) => entry.id));
  if (retainedAudits.length !== audits.length) {
    state.auditLog = retainedAudits;
    changed = true;
  }

  const actions = Array.isArray(state.operationalActions) ? state.operationalActions : [];
  const retainedActions = actions.filter((entry) => {
    if (entry.sourceReportId) return retainedIds.has(entry.sourceReportId);
    return timestamp(entry.createdAt || entry.updatedAt) >= approvedCutoff;
  });
  if (retainedActions.length !== actions.length) {
    state.operationalActions = retainedActions;
    changed = true;
  }

  return { state, changed, approvedRetentionDays: approvedDays };
}
