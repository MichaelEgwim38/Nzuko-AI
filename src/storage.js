import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = join(__dirname, '..');
const messagesPath = join(rootDir, 'data', 'messages.json');
let writeChain = Promise.resolve();

function normaliseTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 20_000_000_000 ? numeric * 1000 : numeric;
  }
  return Date.now();
}

export function timestampMs(message = {}) {
  return normaliseTimestamp(message.timestamp || message.receivedAt || message.createdAt);
}

async function readJsonArray(path) {
  try {
    const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeJsonArray(path, items) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

export async function saveCapturedMessage(message) {
  writeChain = writeChain.then(async () => {
    const messages = await readJsonArray(messagesPath);
    const stored = {
      ...message,
      timestamp: timestampMs(message),
      receivedAt: message.receivedAt || new Date().toISOString(),
    };
    const nextMessages = messages.filter((item) => item.id !== stored.id);
    nextMessages.unshift(stored);
    await writeJsonArray(messagesPath, nextMessages.slice(0, 10000));
    return stored;
  });
  return writeChain;
}

export async function loadCapturedMessages({ groupId, from, to, limit = 500 } = {}) {
  const fromMs = from ? new Date(from).getTime() : null;
  const toMs = to ? new Date(to).getTime() : null;
  const messages = await readJsonArray(messagesPath);
  return messages
    .filter((message) => !groupId || message.groupId === groupId)
    .filter((message) => {
      const ms = timestampMs(message);
      if (fromMs && ms < fromMs) return false;
      if (toMs && ms > toMs) return false;
      return true;
    })
    .sort((a, b) => timestampMs(b) - timestampMs(a))
    .slice(0, limit);
}
