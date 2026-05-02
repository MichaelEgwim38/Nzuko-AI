function normaliseBaseUrl(baseUrl) {
  return String(baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
}

function wahaHeaders(apiKey) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
  };

  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  return headers;
}

async function parseWahaResponse(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = payload?.message || payload?.error || `WAHA returned ${response.status}`;
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }

  return payload;
}

export async function getWahaStatus({ baseUrl, session, apiKey }) {
  const response = await fetch(`${normaliseBaseUrl(baseUrl)}/api/sessions/${encodeURIComponent(session)}/`, {
    headers: wahaHeaders(apiKey),
  });
  return parseWahaResponse(response);
}

export async function startWahaSession({ baseUrl, session, apiKey }) {
  const response = await fetch(`${normaliseBaseUrl(baseUrl)}/api/sessions/${encodeURIComponent(session)}/start`, {
    method: 'POST',
    headers: wahaHeaders(apiKey),
  });
  return parseWahaResponse(response);
}

export async function logoutWahaSession({ baseUrl, session, apiKey }) {
  const response = await fetch(`${normaliseBaseUrl(baseUrl)}/api/sessions/${encodeURIComponent(session)}/logout`, {
    method: 'POST',
    headers: wahaHeaders(apiKey),
  });
  return parseWahaResponse(response);
}

export async function getWahaQr({ baseUrl, session, apiKey }) {
  const response = await fetch(`${normaliseBaseUrl(baseUrl)}/api/${encodeURIComponent(session)}/auth/qr`, {
    headers: {
      ...wahaHeaders(apiKey),
      accept: 'application/json',
    },
  });
  return parseWahaResponse(response);
}

export async function listGroupsFromWaha({ baseUrl, session, apiKey, limit = 100 }) {
  const groupsResponse = await fetch(
    `${normaliseBaseUrl(baseUrl)}/api/${encodeURIComponent(session)}/groups`,
    { headers: wahaHeaders(apiKey) }
  );
  const groups = await parseWahaResponse(groupsResponse);
  const mappedGroups = (Array.isArray(groups) ? groups : [])
    .map((group) => {
      const id = group.id?._serialized || group.id || group.groupMetadata?.id?._serialized;
      const name = group.name || group.groupMetadata?.subject || id;
      const participants = group.groupMetadata?.participants || group.participants || [];
      return {
        id,
        name,
        memberCount: participants.length || null,
        lastMessageAt: group.timestamp || group.lastMessage?.timestamp || null,
        consentStatus: 'needs-review',
      };
    })
    .filter((group) => String(group.id || '').endsWith('@g.us'));

  if (mappedGroups.length) {
    return mappedGroups.slice(0, limit);
  }

  const query = new URLSearchParams({
    limit: String(limit),
    offset: '0',
    sortBy: 'conversationTimestamp',
    sortOrder: 'desc',
  });
  const response = await fetch(
    `${normaliseBaseUrl(baseUrl)}/api/${encodeURIComponent(session)}/chats?${query.toString()}`,
    { headers: wahaHeaders(apiKey) }
  );
  const chats = await parseWahaResponse(response);
  return (Array.isArray(chats) ? chats : [])
    .filter((chat) => String(chat.id || '').endsWith('@g.us'))
    .map((chat) => ({
      id: chat.id,
      name: chat.name || chat.id,
      memberCount: chat.participants?.length || chat._chat?.participants?.length || null,
      lastMessageAt: chat.messageTimestamp || chat.timestamp || chat.lastMessage?.timestamp || null,
      consentStatus: 'needs-review',
    }));
}

function mapWahaMessage(message) {
  const from =
    message.fromMe
      ? 'Assistant account'
      : message.author ||
        message.participant ||
        message._data?.key?.participant ||
        message._data?.participant ||
        (String(message.from || '').endsWith('@g.us') ? 'Group member' : message.from) ||
        'Group member';
  return {
    id: message.id?._serialized || message.id,
    from,
    body: message.body,
    timestamp: message.timestamp,
    hasMedia: Boolean(message.hasMedia),
    type: message.type || (String(message.media?.mimetype || '').startsWith('audio/') ? 'audio' : 'chat'),
    media: message.media,
    mimetype: message.media?.mimetype || message.mimetype,
  };
}

export async function getGroupMessagesFromWaha({ baseUrl, session, apiKey, chatId, limit = 100, fromTimestamp, toTimestamp, downloadMedia = false }) {
  const query = new URLSearchParams({
    limit: String(limit),
    downloadMedia: String(downloadMedia),
  });
  if (fromTimestamp) {
    query.set('filter.timestamp.gte', String(fromTimestamp));
  }
  if (toTimestamp) {
    query.set('filter.timestamp.lte', String(toTimestamp));
  }
  const response = await fetch(
    `${normaliseBaseUrl(baseUrl)}/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages?${query.toString()}`,
    { headers: wahaHeaders(apiKey) }
  );
  const messages = await parseWahaResponse(response);
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message.body || String(message.media?.mimetype || '').startsWith('audio/'))
    .map(mapWahaMessage);
}

export async function getGroupMessagesFromWahaSearch({ baseUrl, session, apiKey, chatId, limit = 100, fromTimestamp, toTimestamp, downloadMedia = false }) {
  const query = new URLSearchParams({
    session,
    chatId,
    limit: String(limit),
    downloadMedia: String(downloadMedia),
  });
  if (fromTimestamp) {
    query.set('filter.timestamp.gte', String(fromTimestamp));
  }
  if (toTimestamp) {
    query.set('filter.timestamp.lte', String(toTimestamp));
  }
  const response = await fetch(
    `${normaliseBaseUrl(baseUrl)}/api/messages?${query.toString()}`,
    { headers: wahaHeaders(apiKey) }
  );
  const messages = await parseWahaResponse(response);
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message.body || String(message.media?.mimetype || '').startsWith('audio/'))
    .map(mapWahaMessage);
}

export async function postRecapToWaha({ baseUrl, session, apiKey, chatId, text }) {
  const response = await fetch(`${normaliseBaseUrl(baseUrl)}/api/sendText`, {
    method: 'POST',
    headers: wahaHeaders(apiKey),
    body: JSON.stringify({
      session,
      chatId,
      text,
      linkPreview: false,
    }),
  });
  return parseWahaResponse(response);
}

export async function configureWahaWebhook({ baseUrl, session, apiKey, webhookUrl }) {
  const config = {
    noweb: {
      store: {
        enabled: true,
        fullSync: true,
      },
    },
    client: {
      deviceName: 'Nzuko AI',
      browserName: 'Chrome',
    },
    webhooks: [
      {
        url: webhookUrl,
        events: ['message', 'message.any'],
      },
    ],
  };
  const response = await fetch(`${normaliseBaseUrl(baseUrl)}/api/sessions/${encodeURIComponent(session)}`, {
    method: 'PUT',
    headers: wahaHeaders(apiKey),
    body: JSON.stringify({
      name: session,
      config,
    }),
  });
  return parseWahaResponse(response);
}

export async function createWahaSession({ baseUrl, session, apiKey, webhookUrl }) {
  const response = await fetch(`${normaliseBaseUrl(baseUrl)}/api/sessions`, {
    method: 'POST',
    headers: wahaHeaders(apiKey),
    body: JSON.stringify({
      name: session,
      start: false,
      config: {
        noweb: {
          store: {
            enabled: true,
            fullSync: true,
          },
        },
        client: {
          deviceName: 'Nzuko AI',
          browserName: 'Chrome',
        },
        webhooks: [
          {
            url: webhookUrl,
            events: ['message', 'message.any'],
          },
        ],
      },
    }),
  });
  return parseWahaResponse(response);
}
