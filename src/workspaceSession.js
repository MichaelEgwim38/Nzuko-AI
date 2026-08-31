import { createHash } from 'node:crypto';

const defaultPrefix = 'nzuko';

function safePrefix(value = defaultPrefix) {
  const prefix = String(value || defaultPrefix)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return prefix || defaultPrefix;
}

function workspaceIdentity(workspace = {}) {
  return String(workspace.id || workspace.workspaceId || 'shared').trim() || 'shared';
}

export function selectWahaWorker(workspace = {}, environment = process.env) {
  const rawPool = String(environment.WAHA_WORKERS_JSON || '').trim();
  if (!rawPool) return null;

  let workers;
  try {
    workers = JSON.parse(rawPool);
  } catch {
    throw new Error('WAHA_WORKERS_JSON must be valid JSON.');
  }
  if (!Array.isArray(workers) || workers.length === 0) {
    throw new Error('WAHA_WORKERS_JSON must contain at least one worker.');
  }

  const usableWorkers = workers
    .map((worker, index) => ({
      id: String(worker.id || `worker-${index + 1}`).trim(),
      baseUrl: String(worker.baseUrl || '').replace(/\/+$/, ''),
      apiKey: String(worker.apiKey || ''),
    }))
    .filter((worker) => worker.baseUrl);
  if (!usableWorkers.length) {
    throw new Error('WAHA_WORKERS_JSON does not contain a worker with a baseUrl.');
  }

  const assignedWorkerId = String(workspace.wahaWorkerId || '').trim();
  const assignedWorker = usableWorkers.find((worker) => worker.id === assignedWorkerId);
  if (assignedWorker) return assignedWorker;

  const hash = createHash('sha256').update(workspaceIdentity(workspace)).digest();
  return usableWorkers[hash.readUInt32BE(0) % usableWorkers.length];
}

export function wahaSessionForWorkspace(workspace = {}, options = {}) {
  const workspaceId = String(workspace.id || workspace.workspaceId || '').trim();
  const legacyShared = workspace.legacyShared || workspaceId === 'shared' || !workspaceId;

  if (legacyShared && options.legacySession) {
    return String(options.legacySession).trim();
  }

  const identity = workspaceId || 'shared';
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return `${safePrefix(options.prefix)}-${digest}`;
}

export function applyWorkspaceWahaSettings(settings = {}, workspace = {}, environment = process.env) {
  const worker = selectWahaWorker(workspace, environment);
  const managedBaseUrl = worker?.baseUrl || String(environment.WAHA_BASE_URL || '').replace(/\/+$/, '');
  const managedApiKey = worker?.apiKey || String(environment.WAHA_API_KEY || '');
  return {
    ...settings,
    connectorMode: managedBaseUrl ? 'waha' : settings.connectorMode,
    wahaBaseUrl: managedBaseUrl || settings.wahaBaseUrl,
    wahaApiKey: managedApiKey || settings.wahaApiKey,
    wahaWorkerId: worker?.id || (managedBaseUrl ? 'primary' : ''),
    wahaSession: wahaSessionForWorkspace(workspace, {
      prefix: environment.WAHA_SESSION_PREFIX || defaultPrefix,
      legacySession: environment.WAHA_SESSION || settings.wahaSession || 'default',
    }),
  };
}
