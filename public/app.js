import { browserSupabase } from './supabase-browser.js';

const $ = (selector) => document.querySelector(selector);
let currentApprovedGroupId = '';
let supabaseClient = null;
let authConfig = null;
let managedWahaWorkspace = false;

function firstNameFromUser(user = {}) {
  const fullName = String(user.displayName || user.name || user.email || '').trim();
  if (!fullName) return 'there';
  return fullName.split(/\s+/)[0];
}

function applyWelcomeUser(user = {}) {
  const firstName = firstNameFromUser(user);
  const heading = $('#welcome-heading');
  const kicker = $('#welcome-kicker');
  if (heading) {
    heading.textContent = `Welcome back, ${firstName}`;
  }
  if (kicker) {
    kicker.textContent = 'Your WhatsApp meeting workspace';
  }
}

function applyManagedWorkspaceUi() {
  document.querySelectorAll('[data-managed-hidden="true"]').forEach((node) => {
    node.classList.toggle('managed-hidden', managedWahaWorkspace);
  });
}

function syncLanguageOptions(options = [], selected = 'auto') {
  const select = $('#transcribe-language');
  if (!select || !options.length) return;
  select.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join('');
  select.value = selected;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

function showLogin(message = '') {
  $('#login-screen').hidden = false;
  $('#app-shell').hidden = true;
  if (message) {
    $('#login-status').textContent = message;
  }
}

function showApp() {
  $('#login-screen').hidden = true;
  $('#app-shell').hidden = false;
}

function ensureSupabase() {
  if (!authConfig?.configured) {
    throw new Error('Social login is not configured yet. Add Supabase settings in Netlify first.');
  }
  if (!supabaseClient) {
    supabaseClient = browserSupabase({
      url: authConfig.supabaseUrl,
      publishableKey: authConfig.supabasePublishableKey,
    });
  }
  return supabaseClient;
}

async function completeSocialSession() {
  const supabase = ensureSupabase();
  const currentUrl = new URL(window.location.href);
  const code = currentUrl.searchParams.get('code');
  const hashParams = new URLSearchParams(currentUrl.hash.startsWith('#') ? currentUrl.hash.slice(1) : currentUrl.hash);
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      throw error;
    }
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (hashParams.get('access_token') && hashParams.get('refresh_token')) {
    const { error } = await supabase.auth.setSession({
      access_token: hashParams.get('access_token'),
      refresh_token: hashParams.get('refresh_token'),
    });
    if (error) {
      throw error;
    }
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw error;
  }
  const accessToken = data.session?.access_token;
  if (!accessToken) {
    return false;
  }

  await api('/api/auth/social-session', {
    method: 'POST',
    body: JSON.stringify({ accessToken }),
  });
  return true;
}

async function startProviderLogin(provider) {
  try {
    const supabase = ensureSupabase();
    const options = {
      redirectTo: window.location.origin,
    };
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options,
    });
    if (error) throw error;
  } catch (error) {
    showLogin(error.message);
  }
}

async function continueWithGoogle() {
  await startProviderLogin('google');
}

async function logout() {
  try {
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
    }
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } catch {
    // Still return the browser to the login screen if the session already expired.
  }
  clearDraftFields();
  window.scrollTo({ top: 0, behavior: 'instant' });
  showLogin('Choose a sign-in option to continue.');
}

async function startApp() {
  await loadStatus();
  if (currentApprovedGroupId && currentApprovedGroupId.endsWith('@g.us')) {
    collapseGroupList({
      approvedGroupName: $('#group-name').value,
      approvedGroupId: currentApprovedGroupId,
    });
  }
  await loadAudit();
}

async function loadStatus() {
  const status = await api('/api/status');
  managedWahaWorkspace = Boolean(status.managedWahaConnection);
  applyManagedWorkspaceUi();
  currentApprovedGroupId = status.settings.approvedGroupId || '';
  $('#group-name').value = status.settings.approvedGroupName || '';
  $('#connector-mode').value = status.settings.connectorMode;
  $('#consent-confirmed').checked = status.settings.consentConfirmed;
  $('#waha-base-url').value = status.settings.wahaBaseUrl;
  $('#waha-session').value = status.settings.wahaSession;
  $('#waha-base-url').readOnly = managedWahaWorkspace;
  $('#waha-session').readOnly = managedWahaWorkspace;
  $('#waha-api-key').disabled = managedWahaWorkspace;
  syncLanguageOptions(status.transcription?.languageOptions || [], status.settings.transcribeLanguage || status.transcription?.language || 'auto');
  $('#waha-api-key').placeholder = status.settings.wahaApiKey ? 'API key configured' : 'Only if WAHA requires X-Api-Key';
  if (status.transcription && !status.transcription.openaiKeyConfigured) {
    $('#waha-status').textContent = 'WAHA is connected. Add OPENAI_API_KEY to .env before real voice-note transcription will run.';
  } else if (managedWahaWorkspace) {
    $('#waha-status').textContent = 'This workspace uses one shared WhatsApp connection. If you need to switch people, end the current session and let the next user scan the new QR.';
  }
  $('#approve-status').textContent = managedWahaWorkspace
    ? 'Review the recap, then approve it when you are ready to post or export it.'
    : 'Posting uses the currently selected connector mode.';
}

function settingsPayload(extra = {}) {
  const payload = {
    approvedGroupName: $('#group-name').value.trim(),
    consentConfirmed: $('#consent-confirmed').checked,
    connectorMode: $('#connector-mode').value,
    transcribeLanguage: $('#transcribe-language').value,
    retentionDays: 14,
    ...extra,
  };
  if (!managedWahaWorkspace) {
    payload.wahaBaseUrl = $('#waha-base-url').value.trim();
    payload.wahaSession = $('#waha-session').value.trim();
    const apiKey = $('#waha-api-key').value;
    if (apiKey) {
      payload.wahaApiKey = apiKey;
    }
  }
  return payload;
}

async function saveSettings() {
  const payload = await api('/api/settings', {
    method: 'POST',
    body: JSON.stringify(settingsPayload()),
  });
  $('#settings-status').textContent = payload.settings.consentConfirmed
    ? 'Workspace settings saved. Recaps can be approved after you select a WhatsApp group.'
    : 'Consent must be confirmed before approving a recap.';
  await loadStatus();
}

async function checkWaha() {
  try {
    await saveSettings();
    const payload = await api('/api/waha/status');
    $('#waha-status').textContent = `WhatsApp session status: ${payload.status.status || 'reachable'}.`;
  } catch (error) {
    $('#waha-status').textContent = `WhatsApp check failed: ${error.message}`;
  }
}

async function startWaha() {
  try {
    await saveSettings();
    const payload = await api('/api/waha/start', { method: 'POST', body: '{}' });
    $('#waha-status').textContent = `WhatsApp session status: ${payload.status.status || 'starting'}.`;
  } catch (error) {
    $('#waha-status').textContent = `WhatsApp start failed: ${error.message}`;
  }
}

async function switchWahaUser() {
  try {
    const payload = await api('/api/waha/logout', { method: 'POST', body: '{}' });
    currentApprovedGroupId = '';
    $('#group-name').value = '';
    $('#group-list').textContent = 'No WAHA groups loaded yet.';
    $('#qr-box').textContent = 'Session ended. Start the session again, show the QR, and let the next person scan from WhatsApp Linked Devices.';
    $('#waha-status').textContent = `WhatsApp session status: ${payload.status.status || 'logged out'}. The next user can now scan a fresh QR.`;
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settingsPayload({
        approvedGroupId: '',
        approvedGroupName: '',
      })),
    });
    await loadStatus();
  } catch (error) {
    $('#waha-status').textContent = `WhatsApp switch failed: ${error.message}`;
  }
}

async function showQr() {
  try {
    await saveSettings();
    const payload = await api('/api/waha/qr');
    if (!payload.qr?.data || !payload.qr?.mimetype) {
      $('#qr-box').textContent = 'QR is not available yet. Start or restart the session and try again.';
      return;
    }
    $('#qr-box').innerHTML = `
      <strong>Scan with your WhatsApp account.</strong>
      <img alt="WAHA WhatsApp QR code" src="data:${payload.qr.mimetype};base64,${payload.qr.data}" />
    `;
    $('#waha-status').textContent = 'QR loaded. It expires quickly, so scan it now from WhatsApp Linked Devices.';
  } catch (error) {
    $('#qr-box').textContent = `QR failed: ${error.message}`;
  }
}

async function loadGroups() {
  try {
    await saveSettings();
    const payload = await api('/api/groups');
    if (!payload.groups.length) {
      $('#group-list').textContent = 'No groups found yet. Confirm the shared WhatsApp session is working, then try again.';
      return;
    }

    $('#group-list').innerHTML = payload.groups
      .map((group) => {
        const selected = group.id === currentApprovedGroupId;
        return `
        <button
          type="button"
          class="group-option${selected ? ' selected' : ''}"
          data-group-id="${escapeHtml(group.id)}"
          data-group-name="${escapeHtml(group.name)}"
          aria-pressed="${selected ? 'true' : 'false'}"
        >
          <span>
            <strong>${escapeHtml(group.name)}</strong>
            <small>${escapeHtml(group.id)}${group.memberCount ? ` &middot; ${group.memberCount} members` : ''}</small>
          </span>
          <em>${selected ? 'Selected' : 'Select group'}</em>
        </button>
      `;
      })
      .join('');
    $('#waha-status').textContent = `Loaded ${payload.groups.length} group chat(s) from ${payload.connector}. Choose the one group the current shared WhatsApp session should summarize.`;
  } catch (error) {
    $('#waha-status').textContent = `Group load failed: ${error.message}`;
  }
}

async function chooseGroup(event) {
  const button = event.target.closest('.group-option');
  if (!button) return;

  const payload = await api('/api/settings', {
    method: 'POST',
    body: JSON.stringify(settingsPayload({
      approvedGroupId: button.dataset.groupId,
      approvedGroupName: button.dataset.groupName,
    })),
  });
  currentApprovedGroupId = payload.settings.approvedGroupId;
  $('#group-name').value = payload.settings.approvedGroupName;
  document.querySelectorAll('.group-option').forEach((option) => {
    const selected = option.dataset.groupId === payload.settings.approvedGroupId;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-pressed', selected ? 'true' : 'false');
    option.querySelector('em').textContent = selected ? 'Selected' : 'Select group';
  });
  collapseGroupList(payload.settings);
  $('#waha-status').textContent = `Selected group: ${payload.settings.approvedGroupName}.`;
}

function collapseGroupList(settings) {
  if (!settings.approvedGroupId) {
    $('#group-list').textContent = 'No approved group selected yet.';
    return;
  }
  $('#group-list').innerHTML = `
    <div class="selected-group">
      <span>
        <strong>Selected group</strong>
        <small>${escapeHtml(settings.approvedGroupName)} &middot; ${escapeHtml(settings.approvedGroupId)}</small>
      </span>
      <button id="change-group" type="button" class="button secondary">Choose another group</button>
    </div>
  `;
  $('#change-group').addEventListener('click', loadGroups);
}

async function pullWahaMessages() {
  try {
    await saveSettings();
    const payload = await api('/api/waha/pull', { method: 'POST', body: JSON.stringify({ limit: 100 }) });
    $('#chat-text').value = payload.chatText;
    $('#voice-notes').value = payload.voiceNotes || '';
    $('#waha-status').textContent = payload.warning
      ? `${payload.warning}. History is not available from WAHA right now; live capture only shows new messages received after the app is running. Captured now: ${payload.messages.length}.`
      : `Pulled ${payload.messages.length} captured message(s). Voice notes stay marked for review while transcription continues in the background.`;
  } catch (error) {
    $('#waha-status').textContent = `Pull failed: ${error.message}`;
  }
}

async function pullTodayMessages() {
  try {
    await saveSettings();
    const payload = await api('/api/waha/pull-today', { method: 'POST', body: '{}' });
    $('#chat-text').value = payload.chatText;
    $('#voice-notes').value = payload.voiceNotes || '';
    $('#summary-preset').value = 'today';
    $('#waha-status').textContent = payload.historyAvailable
      ? `Pulled ${payload.messages.length} WhatsApp message(s) from today and saved them. Voice-note transcription may finish shortly after this load.`
      : `WAHA cannot read today's earlier WhatsApp history in the current session. Loaded ${payload.messages.length} locally stored message(s) from today. Next fix: re-scan the NOWEB QR or import an exported chat.`;
    $('#range-status').textContent = `Today period loaded: ${payload.messages.length} stored message(s).`;
  } catch (error) {
    $('#waha-status').textContent = `Today's pull failed: ${error.message}`;
  }
}

function rangeParams() {
  const preset = $('#summary-preset').value;
  const params = new URLSearchParams({ preset, limit: '1000' });
  if (preset === 'custom') {
    if ($('#summary-from').value) params.set('from', $('#summary-from').value);
    if ($('#summary-to').value) params.set('to', $('#summary-to').value);
  }
  return params;
}

function rangePayload() {
  const preset = $('#summary-preset').value;
  return {
    preset,
    from: preset === 'custom' ? $('#summary-from').value : '',
    to: preset === 'custom' ? $('#summary-to').value : '',
  };
}

async function loadStoredRange() {
  try {
    const payload = await api(`/api/messages/range?${rangeParams().toString()}`);
    $('#chat-text').value = payload.chatText;
    $('#voice-notes').value = payload.voiceNotes || '';
    $('#range-status').textContent = `Loaded ${payload.messages.length} stored message(s) for this period.`;
  } catch (error) {
    $('#range-status').textContent = `Stored period load failed: ${error.message}`;
  }
}

async function generateRangeRecap() {
  try {
    const payload = await api('/api/recap/generate', {
      method: 'POST',
      body: JSON.stringify({
        useStoredRange: true,
        range: rangePayload(),
        limit: 1000,
      }),
    });
    $('#recap-output').textContent = payload.draft.recap.text;
    $('#approve-status').textContent = 'Period draft ready. Review before approving.';
    $('#range-status').textContent = 'Generated from stored approved-group messages for the selected period.';
  } catch (error) {
    $('#range-status').textContent = `Period recap failed: ${error.message}`;
  }
}

function clearDraftFields() {
  $('#chat-text').value = '';
  $('#voice-notes').value = '';
  $('#recap-output').textContent = 'Generate a recap to preview the WhatsApp-ready post.';
}

async function configureWebhook() {
  try {
    await saveSettings();
    const payload = await api('/api/waha/webhook', { method: 'POST', body: '{}' });
    $('#waha-status').textContent = `Live capture enabled for the selected group. Webhook: ${payload.webhookUrl}`;
  } catch (error) {
    $('#waha-status').textContent = `Live capture setup failed: ${error.message}`;
  }
}

async function generateRecap() {
  const payload = await api('/api/recap/generate', {
    method: 'POST',
    body: JSON.stringify({
      chatText: $('#chat-text').value,
      voiceNotes: $('#voice-notes').value,
    }),
  });
  $('#recap-output').textContent = payload.draft.recap.text;
  $('#approve-status').textContent = 'Draft ready. Review before approving.';
}

async function approveRecap() {
  try {
    const payload = await api('/api/recap/approve', { method: 'POST', body: '{}' });
    $('#approve-status').textContent = `Approved through ${payload.auditEntry.posted.provider || $('#connector-mode').value} at ${payload.auditEntry.approvedAt}.`;
    $('#recap-output').textContent = 'Generate a new recap to preview the next WhatsApp-ready post.';
    await loadAudit();
    await loadStatus();
  } catch (error) {
    $('#approve-status').textContent = error.message;
  }
}

async function purgeDraft() {
  const payload = await api('/api/purge', { method: 'POST', body: '{}' });
  $('#approve-status').textContent = payload.message;
  $('#recap-output').textContent = 'Generate a recap to preview the WhatsApp-ready post.';
}

async function loadAudit() {
  const payload = await api('/api/audit');
  if (!payload.auditLog.length) {
    $('#audit-log').textContent = 'No approved recaps yet.';
    return;
  }

  $('#audit-log').innerHTML = payload.auditLog
    .map((entry) => `
      <article class="audit-entry">
        <strong>${escapeHtml(entry.groupName)}</strong>
        <p>${escapeHtml(entry.approvedAt)}</p>
        <p>${entry.recap.decisions.length} decision item(s), ${entry.recap.actions.length} action item(s).</p>
      </article>
    `)
    .join('');
}

$('#save-settings').addEventListener('click', saveSettings);
$('#check-waha').addEventListener('click', checkWaha);
$('#start-waha').addEventListener('click', startWaha);
$('#show-qr').addEventListener('click', showQr);
$('#switch-waha-user').addEventListener('click', switchWahaUser);
$('#load-groups').addEventListener('click', loadGroups);
$('#group-list').addEventListener('click', chooseGroup);
$('#pull-waha').addEventListener('click', pullWahaMessages);
$('#pull-today').addEventListener('click', pullTodayMessages);
$('#configure-webhook').addEventListener('click', configureWebhook);
$('#load-range').addEventListener('click', loadStoredRange);
$('#generate-range').addEventListener('click', generateRangeRecap);
$('#generate').addEventListener('click', generateRecap);
$('#approve').addEventListener('click', approveRecap);
$('#purge').addEventListener('click', purgeDraft);
$('#continue-google').addEventListener('click', continueWithGoogle);
$('#sign-in-link').addEventListener('click', continueWithGoogle);
$('#logout').addEventListener('click', logout);
$('#back-to-login').addEventListener('click', logout);

clearDraftFields();
const auth = await api('/api/auth/status');
authConfig = auth.auth || null;
if (auth.authenticated) {
  applyWelcomeUser(auth.user || {});
  showApp();
  await startApp();
} else {
  try {
    const connected = await completeSocialSession();
    if (connected) {
      const refreshedAuth = await api('/api/auth/status');
      applyWelcomeUser(refreshedAuth.user || {});
      showApp();
      await startApp();
    } else if (!authConfig?.configured) {
      showLogin('Social login is not configured yet. Add Supabase settings in Netlify first.');
    } else {
      showLogin('Choose a sign-in option to continue.');
    }
  } catch (error) {
    showLogin(error.message || 'Could not complete social sign-in.');
  }
}
