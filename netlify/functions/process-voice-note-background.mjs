import { backgroundTaskSecret } from '../../src/netlifyAuth.js';
import { loadAppState, saveCapturedMessage } from '../../src/netlifyStore.js';
import { transcribeVoiceNote } from '../../src/transcription.js';

function unauthorized() {
  return new Response('', { status: 401 });
}

export default async function handler(request) {
  if (request.headers.get('x-nzuko-task-secret') !== backgroundTaskSecret()) {
    return unauthorized();
  }

  const body = await request.text();
  const parsed = body ? JSON.parse(body) : {};
  const payload = parsed.payload || null;
  const scope = parsed.scope || 'shared';
  if (!payload) {
    return new Response('', { status: 202 });
  }

  try {
    const state = await loadAppState(scope);
    const settings = state.settings;
    const transcribed = await transcribeVoiceNote({
      payload,
      wahaBaseUrl: settings.wahaBaseUrl,
      wahaApiKey: settings.wahaApiKey,
      openaiApiKey: process.env.OPENAI_API_KEY,
      transcribeLanguage: settings.transcribeLanguage,
    });
    await saveCapturedMessage(scope, {
      ...transcribed,
      groupId: payload.groupId || settings.approvedGroupId,
    });
  } catch (error) {
    const state = await loadAppState(scope);
    await saveCapturedMessage(scope, {
      id: payload.id?._serialized || payload.id || `voice-${Date.now()}`,
      groupId: payload.groupId || state.settings.approvedGroupId,
      from: payload.fromMe ? 'Assistant account' : payload.author || payload.participant || payload.from || 'Group member',
      body: `[Voice note pending transcription: ${error.message || 'background transcription failed'}]`,
      timestamp: payload.timestamp || Date.now(),
      hasMedia: true,
      type: payload.type || 'audio',
      needsReview: true,
      voiceNote: {
        status: 'pending',
        reason: error.message || 'background transcription failed',
        mimetype: payload.media?.mimetype || payload.mimetype || payload._data?.mimetype || 'unknown',
      },
    });
  }

  return new Response('', { status: 202 });
}
