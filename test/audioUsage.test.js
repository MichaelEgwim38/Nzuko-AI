import test from 'node:test';
import assert from 'node:assert/strict';
import { audioDurationSeconds, maximumVoiceNoteMinutes, totalTranscriptionMinutes, transcriptionMinutes } from '../src/audioUsage.js';

test('reads WAHA audio duration and rounds billing to a tenth of a minute', () => {
  assert.equal(audioDurationSeconds({ _data: { duration: 61 } }), 61);
  assert.equal(transcriptionMinutes({ _data: { duration: 61 } }), 1.1);
});

test('uses a conservative one-minute fallback when duration is unavailable', () => {
  assert.equal(transcriptionMinutes({}), 1);
});

test('totals transcription minutes across voice notes', () => {
  assert.equal(totalTranscriptionMinutes([{ duration: 30 }, { media: { duration: 90 } }]), 2);
});

test('uses a configurable maximum voice-note duration', () => {
  assert.equal(maximumVoiceNoteMinutes({ MAX_VOICE_NOTE_MINUTES: '12' }), 12);
});
