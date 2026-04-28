export const transcriptionLanguageOptions = [
  { value: 'auto', label: 'Auto detect', mode: 'auto', promptLabel: 'auto-detect' },
  { value: 'en', label: 'English', mode: 'param', code: 'en', promptLabel: 'English' },
  { value: 'pl', label: 'Polish', mode: 'param', code: 'pl', promptLabel: 'Polish' },
  { value: 'ro', label: 'Romanian', mode: 'param', code: 'ro', promptLabel: 'Romanian' },
  { value: 'pa', label: 'Punjabi', mode: 'prompt', promptLabel: 'Punjabi' },
  { value: 'ur', label: 'Urdu', mode: 'param', code: 'ur', promptLabel: 'Urdu' },
  { value: 'igbo', label: 'Igbo', mode: 'prompt', promptLabel: 'Igbo' },
  { value: 'yoruba', label: 'Yoruba', mode: 'prompt', promptLabel: 'Yoruba' },
  { value: 'zimbabwe-shona', label: 'Zimbabwe (Shona)', mode: 'prompt', promptLabel: 'Shona' },
  { value: 'ghana-twi', label: 'Ghana (Twi)', mode: 'prompt', promptLabel: 'Twi' },
  { value: 'india-hindi', label: 'India (Hindi)', mode: 'param', code: 'hi', promptLabel: 'Hindi' },
];

export function isValidTranscriptionLanguage(value) {
  return transcriptionLanguageOptions.some((option) => option.value === value);
}

export function transcriptionLanguageConfig(value) {
  return transcriptionLanguageOptions.find((option) => option.value === value) || transcriptionLanguageOptions[0];
}
