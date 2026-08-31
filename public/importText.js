function messageLine(entry = {}) {
  if (typeof entry === 'string') return entry.trim();
  if (!entry || typeof entry !== 'object') return '';
  const text = entry.text || entry.body || entry.content || entry.message || entry.subject || '';
  if (!text || typeof text === 'object') return '';
  const sender = entry.sender?.name || entry.sender || entry.from?.name || entry.from || entry.user_name || entry.username || entry.author || '';
  const timestamp = entry.timestamp || entry.created_at || entry.createdAt || entry.date || '';
  return [timestamp, sender, String(text).trim()].filter(Boolean).join(' - ');
}

function collectMessages(value, lines, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      const line = messageLine(entry);
      if (line) lines.push(line);
      else collectMessages(entry, lines, depth + 1);
    });
    return;
  }
  if (typeof value === 'object') {
    const likelyCollections = ['messages', 'items', 'results', 'value', 'conversations', 'emails'];
    const collection = likelyCollections.find((key) => Array.isArray(value[key]));
    if (collection) collectMessages(value[collection], lines, depth + 1);
    else Object.values(value).forEach((entry) => collectMessages(entry, lines, depth + 1));
  }
}

export function importedConversationText(raw = '', fileName = '') {
  const content = String(raw || '').trim();
  if (!content) return '';
  if (String(fileName).toLowerCase().endsWith('.json') || /^[\[{]/.test(content)) {
    try {
      const lines = [];
      collectMessages(JSON.parse(content), lines);
      if (lines.length) return [...new Set(lines)].join('\n');
    } catch {
      // Keep the original text when an export is not valid JSON.
    }
  }
  return content;
}
