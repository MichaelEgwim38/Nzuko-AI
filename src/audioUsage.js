const fallbackSeconds = 60;

export function audioDurationSeconds(payload = {}) {
  const candidates = [
    payload.duration,
    payload.durationSeconds,
    payload.media?.duration,
    payload.media?.durationSeconds,
    payload._data?.duration,
    payload._data?.durationSeconds,
  ];
  const duration = candidates.map(Number).find((value) => Number.isFinite(value) && value > 0);
  return duration || fallbackSeconds;
}

export function transcriptionMinutes(payload = {}) {
  const minutes = audioDurationSeconds(payload) / 60;
  return Math.ceil(minutes * 10) / 10;
}

export function totalTranscriptionMinutes(messages = []) {
  return Math.round(messages.reduce((total, message) => total + transcriptionMinutes(message), 0) * 10) / 10;
}

export function maximumVoiceNoteMinutes(environment = process.env) {
  const configured = Number(environment.MAX_VOICE_NOTE_MINUTES || 15);
  return Number.isFinite(configured) && configured > 0 ? configured : 15;
}
