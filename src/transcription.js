import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { transcriptionLanguageConfig } from './transcriptionLanguages.js';
import { audioDurationSeconds, maximumVoiceNoteMinutes } from './audioUsage.js';

const supportedFallbackName = 'voice-note.webm';
const openaiSupportedAudioTypes = ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'];

function filenameForMedia(media = {}) {
  if (media.filename) return media.filename;
  const mimetype = String(media.mimetype || '').toLowerCase();
  if (mimetype.includes('mpeg')) return 'voice-note.mp3';
  if (mimetype.includes('mp4')) return 'voice-note.mp4';
  if (mimetype.includes('mpga')) return 'voice-note.mpga';
  if (mimetype.includes('m4a')) return 'voice-note.m4a';
  if (mimetype.includes('wav')) return 'voice-note.wav';
  if (mimetype.includes('webm')) return supportedFallbackName;
  if (mimetype.includes('ogg') || mimetype.includes('opus')) return 'voice-note.ogg';
  return supportedFallbackName;
}

function openaiSupportsMedia({ filename = '', mimetype = '' }) {
  const extension = String(filename).split('.').pop()?.toLowerCase();
  if (openaiSupportedAudioTypes.includes(extension)) return true;
  const mediaType = String(mimetype || '').toLowerCase();
  return openaiSupportedAudioTypes.some((type) => mediaType.includes(type));
}

function normaliseMediaUrl(mediaUrl, baseUrl) {
  if (!mediaUrl) return '';
  if (mediaUrl.startsWith('http://localhost:3000')) {
    return mediaUrl.replace('http://localhost:3000', String(baseUrl || 'http://localhost:3000').replace(/\/+$/, ''));
  }
  return mediaUrl;
}

function convertAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '96k',
      outputPath,
    ]);
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg conversion failed with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function convertToSupportedAudio(arrayBuffer, mimetype) {
  const tempDir = await mkdtemp(join(tmpdir(), 'nzuko-audio-'));
  const inputPath = join(tempDir, 'voice-note.ogg');
  const outputPath = join(tempDir, 'voice-note.mp3');

  try {
    await writeFile(inputPath, Buffer.from(arrayBuffer));
    await convertAudio(inputPath, outputPath);
    return {
      arrayBuffer: await readFile(outputPath),
      filename: 'voice-note.mp3',
      mimetype: 'audio/mpeg',
    };
  } catch (error) {
    throw new Error(`audio format ${mimetype} conversion failed: ${error.message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function isVoiceMedia(payload = {}) {
  const type = String(payload.type || payload._data?.type || '').toLowerCase();
  const mimetype = String(payload.media?.mimetype || payload.mimetype || payload._data?.mimetype || '').toLowerCase();
  return type === 'ptt' || type === 'audio' || mimetype.startsWith('audio/');
}

export function buildPendingVoiceNote({ payload, reason }) {
  return {
    id: payload.id?._serialized || payload.id || `voice-${Date.now()}`,
    from: payload.fromMe ? 'Assistant account' : payload.author || payload.participant || payload.from || 'Group member',
    body: `[Voice note pending transcription: ${reason}]`,
    timestamp: payload.timestamp || Date.now(),
    hasMedia: true,
    type: payload.type || 'audio',
    needsReview: true,
    voiceNote: {
      status: 'pending',
      reason,
      mimetype: payload.media?.mimetype || payload.mimetype || payload._data?.mimetype || 'unknown',
    },
  };
}

async function translateAndSummarizeTranscript({ transcript, openaiApiKey, sourceLanguageHint = 'Igbo, Nigerian Pidgin, and English' }) {
  if (!openaiApiKey) {
    return { status: 'pending', reason: 'OPENAI_API_KEY is not configured' };
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.TRANSLATE_MODEL || 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content:
            `You help review operational voice-note transcripts. The transcript may contain ${sourceLanguageHint}, names, mixed-language speech, and transcription errors. Translate the likely meaning into clear English, then reconcile discussion, proposals, agreements, decisions, actions, owners, deadlines, contradictions, and unresolved issues across the whole transcript. A proposal or statement followed by "no final decision", "not approved", "pending", disagreement, or equivalent must not appear in decisions or actionItems. Preserve named owners and first-person commitments: if Yusuf says "I will" or the transcript says "Yusuf will", make Yusuf explicit in the action item. Preserve stated deadlines. Do not invent facts. Put uncertainty and conflicting interpretations in issues and reviewNote.`,
        },
        {
          role: 'user',
          content: `Raw transcript:\n${transcript}\n\nReturn only JSON with these keys: englishSummary, decisions, actionItems, issues, confidence, reviewNote. Use arrays for decisions/actionItems/issues. Mark uncertainty in reviewNote.`,
        },
      ],
      text: {
        format: {
          type: 'json_object',
        },
      },
    }),
  });

  const resultText = await response.text();
  let result;
  try {
    result = resultText ? JSON.parse(resultText) : {};
  } catch {
    result = { output_text: resultText };
  }

  if (!response.ok) {
    return {
      status: 'pending',
      reason: result.error?.message || `translation failed with ${response.status}`,
    };
  }

  const outputText =
    result.output_text ||
    result.output?.flatMap((item) => item.content || [])?.map((item) => item.text || '').join('') ||
    '';
  try {
    return {
      status: 'translated',
      ...JSON.parse(outputText),
    };
  } catch {
    return {
      status: 'translated',
      englishSummary: outputText.trim(),
      decisions: [],
      actionItems: [],
      issues: ['Translation output needs manual review.'],
      confidence: 'low',
      reviewNote: 'Model returned non-JSON translation output.',
    };
  }
}

function formatTranslationForRecap(translation, transcript) {
  if (translation?.status !== 'translated') {
    return `[Voice note transcript - needs review] ${transcript}`;
  }

  const parts = [
    `[Voice note translated summary - needs review] ${translation.englishSummary || 'No English summary returned.'}`,
  ];
  if (translation.decisions?.length) {
    parts.push(`Decisions: ${translation.decisions.join('; ')}`);
  }
  if (translation.actionItems?.length) {
    parts.push(`Action items: ${translation.actionItems.join('; ')}`);
  }
  if (translation.issues?.length) {
    parts.push(`Issues: ${translation.issues.join('; ')}`);
  }
  if (translation.reviewNote) {
    parts.push(`Review note: ${translation.reviewNote}`);
  }
  return parts.join(' ');
}

export async function transcribeVoiceNote({ payload, wahaBaseUrl, wahaApiKey, openaiApiKey, transcribeLanguage = process.env.TRANSCRIBE_LANGUAGE || 'auto' }) {
  const media = payload.media || {};
  const mediaUrl = normaliseMediaUrl(media.url || payload.mediaUrl, wahaBaseUrl);
  const languageConfig = transcriptionLanguageConfig(transcribeLanguage);
  const durationSeconds = audioDurationSeconds(payload);
  const maximumMinutes = maximumVoiceNoteMinutes();

  if (durationSeconds > maximumMinutes * 60) {
    return buildPendingVoiceNote({ payload, reason: `voice note exceeds the ${maximumMinutes}-minute processing limit` });
  }

  if (!mediaUrl) {
    return buildPendingVoiceNote({ payload, reason: 'WAHA did not provide a media URL for this voice note' });
  }

  if (!openaiApiKey) {
    return buildPendingVoiceNote({ payload, reason: 'OPENAI_API_KEY is not configured' });
  }

  const mediaResponse = await fetch(mediaUrl, {
    headers: wahaApiKey ? { 'X-Api-Key': wahaApiKey } : {},
  });

  if (!mediaResponse.ok) {
    return buildPendingVoiceNote({ payload, reason: `media download failed with ${mediaResponse.status}` });
  }

  let arrayBuffer = await mediaResponse.arrayBuffer();
  let mimetype = media.mimetype || mediaResponse.headers.get('content-type') || 'application/octet-stream';
  let filename = filenameForMedia(media);
  if (!openaiSupportsMedia({ filename, mimetype })) {
    try {
      const converted = await convertToSupportedAudio(arrayBuffer, mimetype);
      arrayBuffer = converted.arrayBuffer;
      filename = converted.filename;
      mimetype = converted.mimetype;
    } catch (error) {
      return buildPendingVoiceNote({
        payload,
        reason: error.message,
      });
    }
  }
  const form = new FormData();
  form.append('model', process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe');
  if (languageConfig.mode === 'param' && languageConfig.code) {
    form.append('language', languageConfig.code);
  }
  form.append(
    'prompt',
    languageConfig.value === 'auto'
      ? 'The audio may switch between Igbo, Nigerian Pidgin, English, or other community languages, with names and informal discussion. Transcribe in the same language the speaker uses. Preserve original words when uncertain instead of inventing English. Do not summarize; write the spoken words as accurately as possible.'
      : `The audio is likely in ${languageConfig.promptLabel} and may include names, code-switching, and informal community discussion. Transcribe in the same language the speaker uses. Preserve original words when uncertain instead of inventing English. Do not summarize; write the spoken words as accurately as possible.`
  );
  form.append('file', new Blob([arrayBuffer], { type: mimetype }), filename);

  const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: form,
  });

  const resultText = await transcriptionResponse.text();
  let result;
  try {
    result = resultText ? JSON.parse(resultText) : {};
  } catch {
    result = { text: resultText };
  }

  if (!transcriptionResponse.ok) {
    return buildPendingVoiceNote({
      payload,
      reason: result.error?.message || `transcription failed with ${transcriptionResponse.status}`,
    });
  }

  const transcript = String(result.text || '').trim();
  if (!transcript) {
    return buildPendingVoiceNote({ payload, reason: 'transcription returned empty text' });
  }

  const from = payload.fromMe ? 'Assistant account' : payload.author || payload.participant || payload.from || 'Group member';
  const translation = await translateAndSummarizeTranscript({
    transcript,
    openaiApiKey,
    sourceLanguageHint:
      languageConfig.value === 'auto'
        ? 'Igbo, Nigerian Pidgin, English, or other mixed community languages'
        : languageConfig.promptLabel,
  });
  return {
    id: payload.id?._serialized || payload.id || `voice-${Date.now()}`,
    from,
    body: formatTranslationForRecap(translation, transcript),
    timestamp: payload.timestamp || Date.now(),
    hasMedia: true,
    type: payload.type || 'audio',
    needsReview: true,
    voiceNote: {
      status: translation.status === 'translated' ? 'translated' : 'transcribed',
      transcript,
      translation,
      mimetype,
      durationSeconds,
      model: process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
      language: languageConfig.value,
      translationModel: process.env.TRANSLATE_MODEL || 'gpt-4.1-mini',
      note: 'Transcript and English meaning summary require human review before posting.',
    },
  };
}
