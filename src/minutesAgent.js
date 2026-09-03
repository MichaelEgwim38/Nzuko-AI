const decisionPattern = /\b(agreed|decision|decided|approved|resolved|we will|conclusion)\b/i;
const actionPattern = /\b(i (?:will|can|shall)|(?:[\p{L}][\p{L}'’-]*\s+){0,2}[\p{L}][\p{L}'’-]*\s+(?:will|shall|is to|can)\s+(?:cover|update|circulate|inspect|report|revisit|send|reserve|collect|share|post|prepare|draft|submit|follow up|manage|contact|book|confirm)|action|assigned|deadline|follow up|send|draft|collect|share|post|prepare|update|circulate|inspect|revisit|reserve|submit)\b/iu;
const unresolvedPattern = /\?|no final|not final|unclear|argue|disagree|disagreement|pending|should we|can we/i;
const rejectedOutcomePattern = /\b(?:no|not)\b[^.!?]{0,80}\b(?:final|approved|agreed|decided|resolved|confirmed)\b|\b(?:remains?|still)\s+(?:open|unresolved|pending)\b/i;
const discussionPattern = /\b(?:discussed|discussion|proposed|suggested|preferred|supported|considered|raised|debated)\b/i;
const linkOnlyPattern = /^https?:\/\/\S+$/i;
const noisyActionPattern = /\b(action items?:|voice note translated summary|voice note transcript|privacy|connected only to the approved|not connected to people)/i;
const voiceTypes = new Set(['audio', 'ptt']);
const noUsefulContentPattern = /^(null|undefined|n\/a|\[object object\])$/i;
const supersededPlanPattern = /\b(?:originally|previously)\s+(?:planned|intended)\b|\b(?:will|can|shall)\s+not\b/i;

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
  if (unresolvedPattern.test(item) || rejectedOutcomePattern.test(item)) return false;
  if (supersededPlanPattern.test(item)) return false;
  if (item.length > 240) return false;
  return actionPattern.test(item);
}

function isConfirmedDecision(line) {
  const item = stripSpeaker(cleanLine(line));
  return isUsefulContent(item)
    && decisionPattern.test(item)
    && !unresolvedPattern.test(item)
    && !rejectedOutcomePattern.test(item);
}

function isDiscussionPoint(line) {
  const item = stripSpeaker(cleanLine(line));
  return isUsefulContent(item) && (discussionPattern.test(item) || unresolvedPattern.test(item) || rejectedOutcomePattern.test(item));
}

function statementTopics(value) {
  const text = String(value || '').toLowerCase();
  const topics = new Set();
  if (/\b(?:penalt(?:y|ies)|late payments?|payment reminders?)\b/.test(text)) topics.add('late-payment-policy');
  if (/\b(?:venue|venues|location|locations)\b/.test(text)) topics.add('venue');
  if (/\b(?:receipt|receipts|screenshots?|totals?)\b/.test(text)) topics.add('receipt-reporting');
  if (/\b(?:contribution list|contributions list)\b/.test(text)) topics.add('contribution-list');
  if (/\b(?:8\s*(?:pm|p\.m\.)|meeting every evening|meet every evening|daily meeting)\b/.test(text)) topics.add('meeting-schedule');
  if (/\b(?:rota|shift|agency cover|evening cover|staffing)\b/.test(text)) topics.add('staffing');
  if (/\b(?:boiler|pressure|plant-room|safety inspection)\b/.test(text)) topics.add('boiler');
  if (/\b(?:flat 3|tenant access|building access|site access)\b/.test(text)) topics.add('access');
  if (/\b(?:unit 14|job 14|alarm|valve part|replacement valve)\b/.test(text)) topics.add('field-job-14');
  if (/\b(?:volunteer rota|food-bank|food bank)\b/.test(text)) topics.add('volunteer-rota');
  if (/\b(?:application|reference)\b/.test(text)) topics.add('application');
  return topics;
}

function contradictedByUnresolved(item, unresolvedItems = []) {
  const topics = statementTopics(item?.text);
  if (!topics.size) return false;
  return unresolvedItems.some((unresolved) => {
    if (!rejectedOutcomePattern.test(unresolved?.text || '')) return false;
    const unresolvedTopics = statementTopics(unresolved.text);
    return [...topics].some((topic) => topic === 'late-payment-policy' && unresolvedTopics.has(topic));
  });
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
  const voiceSpeaker = speaker.match(/^voice note(?:\s*-\s*|\s+from\s+)(.+)$/i);
  if (voiceSpeaker?.[1]) return voiceSpeaker[1].trim();
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
    speaker: displaySpeaker(extractSpeaker(cleaned)),
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
  if (/\bi (?:will|can|shall)\b/i.test(text)) return item.speaker;
  const namedCommitment = text.match(/^(?:(?:decision\s*:|we\s+(?:agreed|decided|approved)(?:\s+that)?)\s*)?([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2})\s+(?:will|shall|is to|can)\b/iu);
  if (namedCommitment?.[1]) return namedCommitment[1].trim();
  return 'Needs owner';
}

function inferDue(item) {
  const text = item.text || '';
  const todayOrTomorrow = text.match(/\b(today|tomorrow)(?:\s+at)?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
  if (todayOrTomorrow) return `${todayOrTomorrow[1][0].toUpperCase()}${todayOrTomorrow[1].slice(1).toLowerCase()}, ${todayOrTomorrow[2]}`;
  const byDayTime = text.match(/\b(by|before)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\s+at)?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
  if (byDayTime) return `${byDayTime[1][0].toUpperCase()}${byDayTime[1].slice(1).toLowerCase()} ${byDayTime[2]}, ${byDayTime[3]}`;
  const byTime = text.match(/\b(by|before)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:\s+(today|tomorrow))?\b/i);
  if (byTime) return `${byTime[1][0].toUpperCase()}${byTime[1].slice(1).toLowerCase()} ${byTime[2]}${byTime[3] ? ` ${byTime[3].toLowerCase()}` : ''}`;
  const beforeDay = text.match(/\bbefore\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
  if (beforeDay) return `Before ${beforeDay[1]}`;
  const byDay = text.match(/\bby\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
  if (byDay) return `By ${byDay[1]}`;
  const recurringDay = text.match(/\b(?:every|on)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\b|\b(Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays|Sundays)\b/i);
  if (recurringDay) return recurringDay[1] ? `Every ${recurringDay[1]}` : recurringDay[2];
  return 'Not stated';
}

function actionTask(item) {
  const owner = inferOwner(item);
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(item.text || '')
    .replace(/^decision\s*:\s*/i, '')
    .replace(new RegExp(`^we\\s+(?:agreed|decided|approved)(?:\\s+that)?\\s+${escapedOwner}\\s+(?:will|shall|is to|can)\\s+`, 'i'), '')
    .replace(new RegExp(`^${escapedOwner}\\s+(?:will|shall|is to|can)\\s+`, 'i'), '')
    .replace(/^.*?\bi\s+(?:will|shall|can)\s+/i, '')
    .replace(/^i\s+(?:will|shall|can)\s+/i, '')
    .replace(/^./, (character) => character.toUpperCase())
    .trim();
}

function reconcileActionItems(items = []) {
  const reconciled = [];
  const reviewNotes = [];
  for (const item of items) {
    if (item.source?.includes('Review note')) {
      reconciled.push(item);
      continue;
    }
    const owner = inferOwner(item);
    const topics = statementTopics(item.text);
    const duplicateIndex = owner === 'Needs owner' || !topics.size
      ? -1
      : reconciled.findIndex((candidate) => {
          if (inferOwner(candidate).toLowerCase() !== owner.toLowerCase()) return false;
          const candidateTopics = statementTopics(candidate.text);
          return [...topics].some((topic) => candidateTopics.has(topic));
        });
    if (duplicateIndex < 0) {
      reconciled.push(item);
      continue;
    }
    const existing = reconciled[duplicateIndex];
    reviewNotes.push(`Confirm whether “${existing.text}” and “${item.text}” describe the same action for ${owner}.`);
  }
  return { items: reconciled, reviewNotes };
}

function formatActionItems(items) {
  return items
    .map(
      (item, index) => `${index + 1}. Owner: ${inferOwner(item)}
   Task: ${actionTask(item)}
   Due: ${inferDue(item)}
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
    .filter((message) => isConfirmedDecision(message.body || ''))
    .map((message) => itemFromMessage(message, stripSpeaker(message.body), 'Text chat'));
  const textActionItems = textMessages
    .filter((message) => isUsefulAction(message.body || ''))
    .map((message) => itemFromMessage(message, stripSpeaker(message.body), 'Text chat'));
  const textQuestionItems = textMessages
    .filter((message) => unresolvedPattern.test(message.body || '') || rejectedOutcomePattern.test(message.body || ''))
    .map((message) => itemFromMessage(message, stripSpeaker(message.body), 'Text chat'));
  const textPointItems = textMessages
    .filter((message) => isUsefulContent(message.body))
    .filter((message) => !isConfirmedDecision(message.body || ''))
    .filter((message) => !isUsefulAction(message.body || ''))
    .filter((message) => isDiscussionPoint(message.body || '') || !unresolvedPattern.test(message.body || ''))
    .map((message) => itemFromMessage(message, stripSpeaker(message.body), 'Text chat'));

  const decisionLines = allLines.filter(isConfirmedDecision).map((line) => itemFromLine(line));
  const actionLines = allLines.filter(isUsefulAction).map((line) => itemFromLine(line));
  const questionLines = allLines
    .filter((line) => unresolvedPattern.test(line) || rejectedOutcomePattern.test(line))
    .map((line) => itemFromLine(line));
  const pointLines = allLines
    .filter((line) => isUsefulContent(line))
    .filter((line) => !isConfirmedDecision(line))
    .filter((line) => !isUsefulAction(line))
    .filter((line) => isDiscussionPoint(line) || !unresolvedPattern.test(line))
    .map((line) => itemFromLine(line))
    .slice(0, 10);

  const reconciliationIssues = [...structuredVoice.issues, ...textQuestionItems, ...questionLines];
  const decisionItems = uniqueItems(
    [
      ...structuredVoice.decisions.filter((item) => isConfirmedDecision(item.text)),
      ...textDecisionItems,
      ...decisionLines,
    ].filter((item) => !contradictedByUnresolved(item, reconciliationIssues)),
    'No confirmed decision found. Mark the main point as needs confirmation before posting.'
  );
  const decisions = uniqueFirst(
    itemText(decisionItems),
    'No confirmed decision found. Mark the main point as needs confirmation before posting.'
  );
  const unresolvedText = new Set(reconciliationIssues.map((item) => cleanLine(item.text).toLowerCase()));
  const distinctPointItems = uniqueItems([...textPointItems, ...pointLines], 'No discussion points captured yet.', 8)
    .filter((item) => item.source?.includes('Review note') || !unresolvedText.has(cleanLine(item.text).toLowerCase()));
  const points = uniqueFirst(
    itemText(distinctPointItems),
    'No discussion points captured yet.'
  );
  const pointItems = distinctPointItems.length
    ? distinctPointItems
    : uniqueItems([], 'No separate discussion point was captured.', 8);
  const extractedActionItems = uniqueItems(
    [
      ...structuredVoice.actions.filter((item) => isUsefulAction(item.text)),
      ...textActionItems,
      ...actionLines,
    ],
    'No action item with owner found. Add owner and deadline if the group has one.'
  );
  const { items: actionItems, reviewNotes: actionReconciliationNotes } = reconcileActionItems(extractedActionItems);
  const actions = uniqueFirst(
    actionItems.map((item) => `${inferOwner(item)}: ${actionTask(item)}`),
    'No action item with owner found. Add owner and deadline if the group has one.'
  );
  const unresolvedItems = uniqueItems(
    reconciliationIssues,
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
  const realDecisions = decisionItems.filter((item) => !item.source.includes('Review note'));
  const realActions = actionItems.filter((item) => !item.source.includes('Review note'));
  const realUnresolved = unresolvedItems.filter((item) => !item.source.includes('Review note'));
  const decisionTopics = realDecisions.map((item) => statementTopics(item.text));
  const executiveActions = realActions.filter((item) => {
    const topics = statementTopics(item.text);
    return !topics.size || !decisionTopics.some((decisionTopic) => [...topics].some((topic) => decisionTopic.has(topic)));
  });
  const translatedVoiceCount = voiceSummaryItems.filter((item) => item.source === 'Voice note').length;
  const humanReviewItems = uniqueFirst([
    ...voiceSummaryItems
      .filter((item) => item.source === 'Voice note')
      .map((item) => `Validate ${item.speaker}'s translated voice note: ${item.text}`),
    ...actionReconciliationNotes,
  ], 'Confirm the draft against the source conversation before approval.', 6);
  const executivePoints = uniqueFirst([
    ...realDecisions.map((item) => item.text),
    ...executiveActions.map((item) => `${inferOwner(item)}: ${actionTask(item)}`),
    ...realUnresolved.map((item) => `Still unresolved: ${item.text}`),
    translatedVoiceCount ? `${translatedVoiceCount} translated voice-note item(s) require human validation.` : '',
  ], 'No confirmed outcome was detected. Review the source conversation.', 6);

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

Confirmed / likely decisions:
${formatSourcedNumbered(decisionItems)}

Action items:
${formatActionItems(actionItems)}

Discussion points:
${formatSourcedNumbered(pointItems)}

Open questions / needs confirmation:
${formatSourcedNumbered(unresolvedItems)}

Human review required:
${formatBullets(humanReviewItems)}

Corrections:
Please reply within 24 hours if any speaker, timestamp, decision, action item, or translation is missing or inaccurate.`,
  };
}
