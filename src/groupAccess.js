export function normaliseApprovedGroups(settings = {}) {
  const groups = Array.isArray(settings.approvedGroups) ? settings.approvedGroups : [];
  const legacy = settings.approvedGroupId
    ? [{ id: settings.approvedGroupId, name: settings.approvedGroupName || settings.approvedGroupId }]
    : [];
  const seen = new Set();
  return [...groups, ...legacy]
    .map((group) => ({ id: String(group?.id || '').trim(), name: String(group?.name || group?.id || '').trim() }))
    .filter((group) => group.id.endsWith('@g.us') && !seen.has(group.id) && seen.add(group.id));
}

export function groupLimitForPlan(planId = 'trial') {
  return String(planId || '').toLowerCase() === 'pro' ? 5 : 1;
}

export function entitledApprovedGroups(settings = {}, planId = 'trial') {
  return normaliseApprovedGroups(settings).slice(0, groupLimitForPlan(planId));
}

export function applyApprovedGroups(settings = {}, approvedGroups = []) {
  const groups = normaliseApprovedGroups({ approvedGroups });
  const active = groups.find((group) => group.id === settings.approvedGroupId) || groups[0] || null;
  return {
    ...settings,
    approvedGroups: groups,
    approvedGroupId: active?.id || '',
    approvedGroupName: active?.name || '',
  };
}
