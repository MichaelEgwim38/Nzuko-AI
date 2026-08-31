import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkspaceWahaSettings, selectWahaWorker, wahaSessionForWorkspace } from '../src/workspaceSession.js';

test('allocates a stable isolated WAHA session for each workspace', () => {
  const first = wahaSessionForWorkspace({ id: 'workspace-one' });
  const repeated = wahaSessionForWorkspace({ id: 'workspace-one' });
  const second = wahaSessionForWorkspace({ id: 'workspace-two' });

  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.match(first, /^nzuko-[a-f0-9]{24}$/);
});

test('does not let a global WAHA_SESSION collapse tenant isolation', () => {
  const environment = {
    WAHA_BASE_URL: 'https://worker.example.com/',
    WAHA_API_KEY: 'secret',
    WAHA_SESSION: 'old-shared-session',
  };
  const first = applyWorkspaceWahaSettings({}, { id: 'tenant-a' }, environment);
  const second = applyWorkspaceWahaSettings({}, { id: 'tenant-b' }, environment);

  assert.equal(first.wahaBaseUrl, 'https://worker.example.com');
  assert.equal(first.wahaApiKey, 'secret');
  assert.notEqual(first.wahaSession, second.wahaSession);
  assert.notEqual(first.wahaSession, environment.WAHA_SESSION);
});

test('preserves the configured legacy session only for the legacy workspace', () => {
  const settings = applyWorkspaceWahaSettings(
    { wahaSession: 'stored-default' },
    { id: 'shared', legacyShared: true },
    { WAHA_SESSION: 'legacy-production' }
  );

  assert.equal(settings.wahaSession, 'legacy-production');
});

test('routes a workspace to a stable worker from a horizontal pool', () => {
  const environment = {
    WAHA_WORKERS_JSON: JSON.stringify([
      { id: 'worker-a', baseUrl: 'https://a.example.com/', apiKey: 'a-key' },
      { id: 'worker-b', baseUrl: 'https://b.example.com', apiKey: 'b-key' },
    ]),
  };
  const workspace = { id: 'tenant-stable' };
  const first = selectWahaWorker(workspace, environment);
  const repeated = selectWahaWorker(workspace, environment);
  const settings = applyWorkspaceWahaSettings({}, workspace, environment);

  assert.deepEqual(first, repeated);
  assert.equal(settings.wahaWorkerId, first.id);
  assert.equal(settings.wahaBaseUrl, first.baseUrl);
  assert.equal(settings.wahaApiKey, first.apiKey);
});

test('keeps an assigned workspace on its worker when the pool grows', () => {
  const environment = {
    WAHA_WORKERS_JSON: JSON.stringify([
      { id: 'worker-a', baseUrl: 'https://a.example.com' },
      { id: 'worker-b', baseUrl: 'https://b.example.com' },
      { id: 'worker-c', baseUrl: 'https://c.example.com' },
    ]),
  };

  assert.equal(
    selectWahaWorker({ id: 'tenant-stable', wahaWorkerId: 'worker-b' }, environment).id,
    'worker-b'
  );
});

test('rejects an invalid worker-pool configuration early', () => {
  assert.throws(
    () => selectWahaWorker({ id: 'tenant-a' }, { WAHA_WORKERS_JSON: 'not-json' }),
    /valid JSON/
  );
});
