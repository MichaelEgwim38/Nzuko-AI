const decisionPattern = /\b(agreed|decision|decided|approved|resolved|final|we will|conclusion)\b/i;
const actionPattern = /\b(i will|will|action|assigned|deadline|before|by monday|by tuesday|by wednesday|by thursday|by friday|follow up|send|draft|collect|share|post|prepare)\b/i;
const unresolvedPattern = /\?|no final|not final|unclear|argue|disagree|disagreement|pending|confirm|should we|can we/i;
const linkOnlyPattern = /^https?:\/\/\S+$/i;
const noisyActionPattern = /\b(action items?:|voice note translated summary|voice note transcript|privacy|connected only to the approved|not connected to people)/i;
const voiceTypes = new Set(['audio', 'ptt']);
const noUsefulContentPattern = /^(null|undefined|n\/a|\[object object\])$/i;

export function splitReadableLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function stripSpeaker(line) {
  return line.replace(/^(?!https?:\/\/)([^:\n]{2,100}):\s*/, '').trim();
}

export function extractSpeaker(line) {
  const match = line.match(/^(?!https?:\/\/)([^:\n]{2,100}):/);
  return match?.[1]?.trim();
}

function uniqueFirst(items, fallback, limit = 6) {
  const seen = new Set();
  const cleaned = items
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);

  return cleaned.length ? cleaned : [fallback];
}

function formatNumbered(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function formatBullets(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function cleanLine(line) {
  return String(line || '')
    .replace(/\[Voice note translated summary - needs review\]\s*/gi, '')
    .replace(/\[Voice note transcript - needs review\]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulContent(line) {
  const item = stripSpeaker(cleanLine(line));
  if (!item || noUsefulContentPattern.test(item)) return false;
  if (linkOnlyPattern.test(item)) return false;
  return true;
}

function isUsefulAction(line) {
  const item = stripSpeaker(cleanLine(line));
  if (!isUsefulContent(item)) return false;
  if (noisyActionPattern.test(item)) return false;
  if (item.length > 240) return false;
  return actionPattern.test(item);
}

function normaliseTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 20_000_000_000 ? numeric * 1000 : numeric;
  }
  return null;
}

function messageTimestamp(message = {}) {
  return normaliseTimestamp(message.timestamp || message.receivedAt || message.createdAt);
}

function sortMessages(messages = []) {
  return [...messages].sort((a, b) => {
    const aTime = messageTimestamp(a) || 0;
    const bTime = messageTimestamp(b) || 0;
    return aTime - bTime;
  });
}

function formatDateLabel(date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function formatTimeLabel(timestamp) {
  if (!timestamp) return 'time not captured';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function displaySpeaker(value) {
  const speaker = String(value || '').trim();
  if (!speaker) return 'Speaker not captured';
  if (speaker === 'Assistant account') return speaker;
  return speaker;
}

function isVoiceMessage(message = {}) {
  return Boolean(message.voiceNote) || message.needsReview || voiceTypes.has(String(message.type || '').toLowerCase());
}

function sourceLabel(message = {}) {
  return isVoiceMessage(message) ? 'Voice note' : 'Text chat';
}

function itemFromMessage(message, text, fallbackSource) {
  return {
    text: cleanLine(text),
    speaker: displaySpeaker(message.from),
    time: formatTimeLabel(messageTimestamp(message)),
    source: fallbackSource || sourceLabel(message),
    confidence: message.voiceNote?.translation?.confidence || '',
    reviewNote: message.voiceNote?.translation?.reviewNote || '',
    needsReview: Boolean(message.voiceNote || message.needsReview),
  };
}

function itemFromLine(line, fallbackSource = 'Manual input') {
  const cleaned = cleanLine(line);
  return {
    text: stripSpeaker(cleaned),
    speaker: extractSpeaker(cleaned) || 'Speaker not captured',
    time: 'time not captured',
    source: fallbackSource,
    confidence: '',
    reviewNote: '',
    needsReview: fallbackSource.toLowerCase().includes('voice'),
  };
}

function uniqueItems(items, fallbackText, limit = 6) {
  const seen = new Set();
  const cleaned = items
    .map((item) => ({
      ...item,
      text: cleanLine(item?.text),
      speaker: displaySpeaker(item?.speaker),
      time: item?.time || 'time not captured',
      source: item?.source || 'Manual input',
    }))
    .filter((item) => {
      if (!isUsefulContent(item.text)) return false;
      const key = item.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);

  return cleaned.length
    ? cleaned
    : [
        {
          text: fallbackText,
          speaker: 'NZUKO AI',
          time: 'time not captured',
          source: 'Review note',
          confidence: '',
          reviewNote: '',
          needsReview: true,
        },
      ];
}

function itemText(items) {
  return items.map((item) => item.text);
}

function formatSourcedNumbered(items) {
  return items
    .map((item, index) => `${index + 1}. [${item.time}] ${item.speaker} (${item.source}): ${item.text}`)
    .join('\n');
}

function inferOwner(item) {
  const text = item.text || '';
  if (/^admin\b/i.test(text)) return 'Admin';
  if (/^secretary\b/i.test(text)) return 'Secretary';
  if (/^chair(man)?\b/i.test(text)) return 'Chairman';
  if (/^group\b/i.test(text)) return 'Group';
  if (/\bi will\b/i.test(text)) return item.speaker;
  return 'Needs owner';
}

function formatActionItems(items) {
  return items
    .map(
      (item, index) => `${index + 1}. Owner: ${inferOwner(item)}
   Task: ${item.text}
   Due: Not stated
   Source: ${item.source}
   Time: ${item.time}
   Speaker: ${item.speaker}`
    )
    .join('\n');
}

function reviewStatus(item) {
  if (item.needsReview) return 'Needs human review';
  return 'Captured from text';
}

function formatVoiceReview(items) {
  return items
    .map((item, index) => {
      const confidence = item.confidence ? item.confidence : 'not scored';
      const note = item.reviewNote ? `\n   Notes: ${item.reviewNote}` : '';
      return `${index + 1}. [${item.time}] ${item.speaker}
   English meaning: ${item.text}
   Confidence: ${confidence}
   Review status: ${reviewStatus(item)}${note}`;
    })
    .join('\n');
}

function structuredVoiceData(messages = []) {
  const voiceMessages = messages.filter((message) => message.voiceNote?.translation?.status === 'translated');
  return {
    summaries: voiceMessages.map((message) => {
      const summary = message.voiceNote.translation.englishSummary || 'Voice note translated, but no summary was returned.';
      return itemFromMessage(message, summary, 'Voice note');
    }),
    decisions: voiceMessages.flatMap((message) =>
      (message.voiceNote.translation.decisions || []).map((item) => itemFromMessage(message, item, 'Voice note'))
    ),
    actions: voiceMessages.flatMap((message) =>
      (message.voiceNote.translation.actionItems || []).map((item) => itemFromMessage(message, item, 'Voice note'))
    ),
    issues: voiceMessages.flatMap((message) =>
      (message.voiceNote.translation.issues || []).map((item) => itemFromMessage(message, item, 'Voice note'))
    ),
  };
}

export function generateRecap({ chatText = '', voiceNotes = '', groupName = 'Approved WhatsApp group', messages = [] }) {
  const chatLines = splitReadableLines(chatText);
  const voiceLines = splitReadableLines(voiceNotes);
  const orderedMessages = sortMessages(messages);
  const structuredVoice = structuredVoiceData(orderedMessages);
  const allLines = [...chatLines, ...voiceLines.map(cleanLine)];
  const messageTimes = orderedMessages.map(messageTimestamp).filter(Boolean);
  const firstMessageTime = messageTimes[0];
  const lastMessageTime = messageTimes[messageTimes.length - 1];
  const dateLabel = formatDateLabel(firstMessageTime ? new Date(firstMessageTime) : new Date());
  const coverageLabel = firstMessageTime && lastMessageTime
    ? `${formatTimeLabel(firstMessageTime)} - ${formatTimeLabel(lastMessageTime)}`
    : 'Manual input; timestamps not captured';

  const textMessages = orderedMessages.filter((message) => !isVoiceMessage(message));
  const textDecisionItems = textMessages
    .filter((message) => decisionPattern.test(message.body || ''))
    .map((message) => itemFromMessage(message, stripSpeaker(message.body), 'Text chat'));
  const textActionItems = textMessages
    .filter((message) => isUsefulAction(message.body || ''))
    .map((message) => itemFromMessage(message, stripSpeaker(message.body), 'Text chat'));
  const textQuestionItems = textMessages
    .filter((message) => unresolvedPattern.test(message.body || ''))
    .map((message) => itemFromMessage(message, stripSpeaker(message.body), 'Text chat'));
  const textPointItems = textMessages
    .filter((message) => isUsefulContent(message.body))
    .filter((message) => !decisionPattern.test(message.body || ''))
    .filter((message) => !isUsefulAction(message.body || ''))
    .filter((message) => !unresolvedPattern.test(message.body || ''))
    .map((message) => itemFromMessage(message, stripSpeaker(message.body), 'Text chat'));

  const decisionLines = allLines.filter((line) => decisionPattern.test(line)).map((line) => itemFromLine(line));
  const actionLines = allLines.filter(isUsefulAction).map((line) => itemFromLine(line));
  const questionLines = allLines.filter((line) => unresolvedPattern.test(line)).map((line) => itemFromLine(line));
  const pointLines = allLines
    .filter((line) => isUsefulContent(line))
    .filter((line) => !decisionPattern.test(line))
    .filter((line) => !isUsefulAction(line))
    .filter((line) => !unresolvedPattern.test(line))
    .map((line) => itemFromLine(line))
    .slice(0, 10);

  const decisions = uniqueFirst(
    itemText(uniqueItems([...structuredVoice.decisions, ...textDecisionItems, ...decisionLines], 'No confirmed decision found. Mark the main point as needs confirmation before posting.')),
    'No confirmed decision found. Mark the main point as needs confirmation before posting.'
  );
  const decisionItems = uniqueItems(
    [...structuredVoice.decisions, ...textDecisionItems, ...decisionLines],
    'No confirmed decision found. Mark the main point as needs confirmation before posting.'
  );
  const points = uniqueFirst(
    itemText(uniqueItems([...textPointItems, ...pointLines], 'No discussion points captured yet.', 8)),
    'No discussion points captured yet.'
  );
  const pointItems = uniqueItems([...textPointItems, ...pointLines], 'No discussion points captured yet.', 8);
  const actionItems = uniqueItems(
    [...structuredVoice.actions, ...textActionItems, ...actionLines],
    'No action item with owner found. Add owner and deadline if the group has one.'
  );
  const actions = uniqueFirst(
    actionItems.map((item) => `${inferOwner(item)}: ${item.text}`),
    'No action item with owner found. Add owner and deadline if the group has one.'
  );
  const unresolvedItems = uniqueItems(
    [...structuredVoice.issues, ...textQuestionItems, ...questionLines],
    'No unresolved question detected.'
  );
  const unresolved = uniqueFirst(
    itemText(unresolvedItems),
    'No unresolved question detected.'
  );
  const voiceSummaryItems = uniqueItems(
    structuredVoice.summaries.length ? structuredVoice.summaries : voiceLines.map((line) => itemFromLine(line, 'Voice note')),
    'No voice-note transcript added.',
    4
  );
  const voiceSummary = uniqueFirst(
    voiceSummaryItems.map((item) =>
      item.text.toLowerCase().includes('needs review') || item.text.toLowerCase().includes('needs human review')
        ? item.text
        : `${item.text} (needs human review)`
    ),
    'No voice-note transcript added.',
    4
  );
  const executivePoints = [
    `${pointItems.filter((item) => !item.source.includes('Review note')).length} key discussion point(s) captured for review.`,
    `${decisionItems.filter((item) => !item.source.includes('Review note')).length} possible decision(s) identified.`,
    `${actionItems.filter((item) => !item.source.includes('Review note')).length} possible action item(s) identified.`,
    `${voiceSummaryItems.filter((item) => item.source === 'Voice note').length} translated voice-note item(s) need human review.`,
  ];

  return {
    groupName,
    dateLabel,
    coverageLabel,
    decisions,
    points,
    actions,
    unresolved,
    voiceSummary,
    text: `NZUKO AI DAILY MINUTES - ${dateLabel}
Group: ${groupName}
Coverage: ${coverageLabel}
Status: Draft for human review

Executive summary:
${formatBullets(executivePoints)}

Decisions:
${formatSourcedNumbered(decisionItems)}

Action items:
${formatActionItems(actionItems)}

Key discussion points:
${formatSourcedNumbered(pointItems)}

Open questions / needs confirmation:
${formatSourcedNumbered(unresolvedItems)}

Voice-note review:
${formatVoiceReview(voiceSummaryItems)}

Corrections:
Please reply within 24 hours if any speaker, timestamp, decision, action item, or translation is missing or inaccurate.`,
  };
}
