const urgentPattern = /\b(urgent|immediately|asap|emergency|critical|danger|safety|risk|today)\b/i;

function clean(value = '') {
  return String(value || '').replace(/^[-*\d.)\s]+/, '').trim();
}

function ownerAndTitle(value = '') {
  const text = clean(value);
  const match = text.match(/^([^:]{1,60}):\s*(.+)$/);
  if (!match) return { owner: '', title: text };
  const owner = clean(match[1]).replace(/^(owner|assigned to)\s+/i, '');
  return { owner, title: clean(match[2]) };
}

function inferredDueDate(value = '', approvedAt = new Date().toISOString()) {
  const text = String(value || '');
  const base = new Date(approvedAt);
  if (Number.isNaN(base.getTime())) return null;
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  if (/\btoday\b/i.test(text)) return base.toISOString().slice(0, 10);
  if (/\btomorrow\b/i.test(text)) {
    base.setUTCDate(base.getUTCDate() + 1);
    return base.toISOString().slice(0, 10);
  }
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const weekday = weekdays.findIndex((day) => new RegExp(`\\b${day}\\b`, 'i').test(text));
  if (weekday >= 0) {
    let days = (weekday - base.getUTCDay() + 7) % 7;
    if (days === 0) days = 7;
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
  }
  return null;
}

export function actionsFromApprovedRecap(recap = {}, auditEntry = {}) {
  const approvedAt = auditEntry.approvedAt || new Date().toISOString();
  return (Array.isArray(recap.actions) ? recap.actions : [])
    .map((value, index) => {
      const { owner, title } = ownerAndTitle(value);
      if (!title || /^no action item/i.test(title)) return null;
      return {
        id: `action-${String(auditEntry.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-')}-${index}`,
        title,
        owner,
        dueDate: inferredDueDate(value, approvedAt),
        priority: urgentPattern.test(value) ? 'urgent' : 'normal',
        status: 'open',
        acknowledgement: 'pending',
        escalated: urgentPattern.test(value),
        sourceReportId: auditEntry.id || '',
        sourceGroupName: auditEntry.groupName || recap.groupName || '',
        createdAt: approvedAt,
        updatedAt: approvedAt,
        acknowledgedAt: null,
        completedAt: null,
      };
    })
    .filter(Boolean);
}

export function actionView(action = {}, now = new Date()) {
  const due = action.dueDate ? new Date(`${action.dueDate}T23:59:59.999Z`) : null;
  const overdue = action.status !== 'done' && due && !Number.isNaN(due.getTime()) && due < now;
  return { ...action, overdue: Boolean(overdue), unresolved: action.status !== 'done' };
}

export function updateOperationalAction(action = {}, changes = {}, actor = {}) {
  const now = new Date().toISOString();
  const next = { ...action };
  if (changes.title !== undefined) next.title = clean(changes.title).slice(0, 500);
  if (changes.owner !== undefined) next.owner = clean(changes.owner).slice(0, 120);
  if (changes.dueDate !== undefined) next.dueDate = /^20\d{2}-\d{2}-\d{2}$/.test(String(changes.dueDate)) ? changes.dueDate : null;
  if (['normal', 'urgent'].includes(changes.priority)) next.priority = changes.priority;
  if (typeof changes.escalated === 'boolean') next.escalated = changes.escalated;
  if (changes.acknowledgement === 'acknowledged') {
    next.acknowledgement = 'acknowledged';
    next.acknowledgedAt = now;
    next.acknowledgedBy = actor.name || actor.email || '';
  }
  if (['open', 'done'].includes(changes.status)) {
    next.status = changes.status;
    next.completedAt = changes.status === 'done' ? now : null;
    next.completedBy = changes.status === 'done' ? (actor.name || actor.email || '') : '';
  }
  next.updatedAt = now;
  return next;
}
