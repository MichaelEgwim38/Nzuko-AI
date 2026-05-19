import { browserSupabase } from './supabase-browser.js';

const $ = (selector) => document.querySelector(selector);
let currentApprovedGroupId = '';
let supabaseClient = null;
let authConfig = null;
let managedWahaWorkspace = false;
let latestStatus = null;
let paymentQueryState = null;
let adminBillingLoaded = false;
let auditEntriesCache = [];
let recentUsageEventsCache = [];
let billingEntriesCache = [];
let showAllAudit = false;
let showAllAdminActivity = false;
let showAllBilling = false;
let upgradeNoteDismissTimeout = null;
let deferredInstallPrompt = null;

function isStandaloneMode() {
  return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone;
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent || '');
}

function updateInstallButton() {
  const button = $('#install-app');
  if (!button) return;
  const isStandalone = isStandaloneMode();
  const canShowIosHelp = isIosDevice();
  button.hidden = (!deferredInstallPrompt && !canShowIosHelp) || Boolean(isStandalone);
  button.textContent = deferredInstallPrompt ? 'Install app' : 'Add to Home Screen';
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (error) {
    console.warn('Service worker registration failed.', error);
  }
}

async function installApp() {
  if (!deferredInstallPrompt) {
    setInstallHelpOpen(true);
    return;
  }
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    deferredInstallPrompt = null;
  }
  updateInstallButton();
}

function firstNameFromUser(user = {}) {
  const displaySource = String(user.displayName || user.name || '').trim();
  if (displaySource) {
    return displaySource.split(/\s+/)[0];
  }
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return 'there';
  const localPart = email.split('@')[0] || '';
  const candidate = localPart.split(/[._-]+/).find(Boolean) || localPart;
  if (!candidate) return 'there';
  return candidate.charAt(0).toUpperCase() + candidate.slice(1);
}

function applyWelcomeUser(user = {}) {
  const firstName = firstNameFromUser(user);
  const heading = $('#welcome-heading');
  const kicker = $('#welcome-kicker');
  const sidebarName = $('#sidebar-account-name');
  const sidebarRole = $('#sidebar-account-role');
  const sidebarBadge = $('#sidebar-account-badge');
  if (heading) {
    heading.textContent = `Welcome back, ${firstName}`;
  }
  if (kicker) {
    kicker.textContent = 'Your WhatsApp meeting workspace';
  }
  if (sidebarName) {
    sidebarName.textContent = firstName;
  }
  if (sidebarRole) {
    sidebarRole.textContent = 'Your workspace';
  }
  if (sidebarBadge) {
    sidebarBadge.textContent = firstName.charAt(0).toUpperCase();
  }
}

function applyManagedWorkspaceUi() {
  document.querySelectorAll('[data-managed-hidden="true"]').forEach((node) => {
    node.classList.toggle('managed-hidden', managedWahaWorkspace);
  });
}

function setButtonDisabled(id, disabled) {
  const button = $(`#${id}`);
  if (button) {
    button.disabled = disabled;
  }
}

function setHintMessage(id, message = '') {
  const node = $(`#${id}`);
  if (!node) return;
  node.hidden = !message;
  node.textContent = message;
}

function readPaymentQueryState() {
  const url = new URL(window.location.href);
  const payment = url.searchParams.get('payment');
  if (!payment) return null;
  url.searchParams.delete('payment');
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  return payment;
}

function renderWorkspaceStatus(status = {}) {
  latestStatus = status;
  const trial = status.trial || {};
  const workspaceSession = status.workspaceSession || status.sharedSession || {};
  const billing = status.billing || {};
  const admin = status.admin || {};
  const trialSummary = $('#trial-summary');
  const paymentNotice = $('#payment-notice');
  const manageBillingButton = $('#manage-billing');
  const upgradeNote = $('#upgrade-note');
  const workspaceNotice = $('#workspace-notice');
  const adminBillingPanel = $('#admin-billing-panel');
  const checkWahaButton = $('#check-waha');

  if (trialSummary) {
    if (trial.isSubscribed) {
      trialSummary.hidden = false;
      trialSummary.textContent = `${billing.planName || trial.planName || 'Paid access'} is active.`;
    } else if (trial.isPendingActivation) {
      trialSummary.hidden = false;
      trialSummary.textContent = `Payment received. Your paid workspace is reserved and will be activated within ${billing.activationWindowDays || 7} days.`;
    } else if (trial.canUseApp) {
      trialSummary.hidden = false;
      trialSummary.textContent = `Trial: ${trial.daysRemaining} day${trial.daysRemaining === 1 ? '' : 's'} left - ${trial.recapRemaining} of ${trial.recapLimit} recaps remaining.`;
    } else {
      trialSummary.hidden = false;
      trialSummary.textContent = 'Your trial limit has ended. Upgrade to continue using this workspace.';
    }
  }

  if (manageBillingButton) {
    manageBillingButton.hidden = !trial.isSubscribed;
  }

  if (upgradeNote && trial.isSubscribed) {
    upgradeNote.hidden = true;
  }

  if (paymentNotice) {
    let message = '';
    if (paymentQueryState === 'success') {
      message = 'Payment received. Stripe will confirm your subscription and unlock paid access automatically.';
    } else if (paymentQueryState === 'cancel') {
      message = 'Checkout was canceled. Your workspace is still on its current plan.';
    } else if (trial.isSubscribed) {
      message = `Paid access is active${billing.activatedAt ? ` since ${new Date(billing.activatedAt).toLocaleString()}` : ''}.`;
    }
    paymentNotice.hidden = !message;
    paymentNotice.textContent = message;
  }

  if (adminBillingPanel) {
    const shouldShowAdmin = Boolean(admin.isAdmin);
    adminBillingPanel.hidden = !shouldShowAdmin;
    if (!shouldShowAdmin) {
      adminBillingLoaded = false;
    }
  }

  if (checkWahaButton) {
    checkWahaButton.hidden = !admin.isAdmin;
  }

  if (workspaceNotice) {
    let notice = '';
    let shouldBlink = false;
    if (!managedWahaWorkspace) {
      notice = '';
    } else if (workspaceSession.hasOwner && workspaceSession.isCurrentUserOwner) {
      notice = 'You are using the active workspace WhatsApp connection right now.';
    } else if (workspaceSession.hasOwner) {
      notice = 'Another WhatsApp account is currently connected. Click Disconnect and switch WhatsApp to connect your own account.';
    } else if (workspaceSession.isExpired) {
      notice = 'The current workspace WhatsApp connection appears inactive. You can disconnect and switch WhatsApp to connect your own account.';
    } else {
      notice = 'No WhatsApp account is connected to this workspace yet. Click Start session, get the QR code, then scan it with WhatsApp Linked Devices.';
      shouldBlink = true;
    }
    workspaceNotice.hidden = !notice;
    workspaceNotice.textContent = notice;
    workspaceNotice.classList.toggle('blinking-status', shouldBlink);
  }

  const canUseApp = Boolean(trial.canUseApp);
  const canClaimSession = canUseApp && (!workspaceSession.hasOwner || workspaceSession.isCurrentUserOwner || workspaceSession.isExpired);
  const canOperateLive = canUseApp && Boolean(workspaceSession.isCurrentUserOwner);

  ['save-settings', 'check-waha', 'switch-waha-user'].forEach((id) => setButtonDisabled(id, !canUseApp));
  ['start-waha', 'show-qr'].forEach((id) => setButtonDisabled(id, !canClaimSession));
  ['load-groups', 'configure-webhook', 'load-period-messages', 'generate-range', 'generate', 'approve', 'purge'].forEach((id) =>
    setButtonDisabled(id, !canOperateLive)
  );
}

function renderBillingPlans(status = {}) {
  const trial = status.trial || {};
  const billing = status.billing || {};
  const container = $('#pricing-plan-cards');
  const summary = $('#pricing-plan-status');
  const manageButton = $('#manage-billing');
  const plans = Array.isArray(billing.plans) ? billing.plans : [];
  const usage = billing.usage || {};

  if (manageButton) {
    manageButton.hidden = !billing.customerPortalAvailable;
  }

  if (!container || !summary) return;

  if (!plans.length) {
    summary.textContent = 'Pricing plans will appear here after billing configuration is complete.';
    container.textContent = 'Plans are not configured yet.';
    return;
  }

  const checkoutEnabled = plans.some((plan) => plan.checkoutEnabled);

  if (!checkoutEnabled) {
    summary.textContent = 'Starter and Pro are defined locally. Add Stripe price ids and webhook settings before checkout can go live.';
  } else if (trial.isSubscribed) {
    const usageNotes = [];
    if (Number.isFinite(usage.recapRemaining) && Number.isFinite(usage.recapLimit)) {
      usageNotes.push(`${usage.recapRemaining} of ${usage.recapLimit} recaps left`);
    }
    if (Number.isFinite(usage.voiceNoteRemaining) && Number.isFinite(usage.voiceNoteLimit)) {
      usageNotes.push(`${usage.voiceNoteRemaining} of ${usage.voiceNoteLimit} voice notes left`);
    }
    summary.textContent = usageNotes.length
      ? `${billing.planName || 'Paid access'} is active. ${usageNotes.join(' · ')} in the current billing window. Use Manage billing for plan changes or cancellations.`
      : `${billing.planName || 'Paid access'} is active. Use Manage billing for plan changes or cancellations.`;
  } else if (trial.canUseApp) {
    summary.textContent = `You are on the free trial. Choose Starter or Pro whenever you are ready to subscribe.`;
  } else {
    summary.textContent = 'Your trial has ended. Choose a paid plan in Stripe to keep using the workspace.';
  }

  container.innerHTML = plans
    .map((plan) => {
      const isCurrent = Boolean(plan.isCurrent && trial.isSubscribed);
      const buttonLabel = isCurrent
        ? 'Current plan'
        : trial.isSubscribed
          ? 'Manage in billing'
          : `Choose ${plan.name}`;
      return `
        <article class="plan-card${isCurrent ? ' plan-card-current' : ''}">
          <div class="plan-card-header">
            <div>
              <p class="plan-card-price">${escapeHtml(plan.priceLabel || '')}</p>
              <h3>${escapeHtml(plan.name || '')}</h3>
            </div>
            ${isCurrent ? '<span class="plan-badge">Active</span>' : ''}
          </div>
          <p class="plan-card-summary">${escapeHtml(plan.summary || '')}</p>
          <ul class="plan-feature-list">
            ${(plan.features || []).map((feature) => `<li>${escapeHtml(feature)}</li>`).join('')}
          </ul>
          <button
            class="button${isCurrent ? ' secondary' : ''}"
            type="button"
            data-plan-action="${trial.isSubscribed ? 'manage' : 'checkout'}"
            data-plan-id="${escapeHtml(plan.id || '')}"
            ${!trial.isSubscribed && !plan.checkoutEnabled ? 'disabled' : ''}
            ${isCurrent ? 'disabled' : ''}
          >${escapeHtml(buttonLabel)}</button>
        </article>
      `;
    })
    .join('');
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

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function setToggleState(buttonId, hidden, expanded) {
  const button = $(`#${buttonId}`);
  if (!button) return;
  button.hidden = hidden;
  if (!hidden) {
    button.textContent = expanded ? 'Show latest' : 'Show all';
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

function renderAuditFeed() {
  const summary = $('#audit-summary');
  const container = $('#audit-log');
  if (!summary || !container) return;

  const total = auditEntriesCache.length;
  const defaultVisibleCount = 4;
  const visibleEntries = showAllAudit ? auditEntriesCache : auditEntriesCache.slice(0, defaultVisibleCount);

  setToggleState('toggle-audit-feed', total <= defaultVisibleCount, showAllAudit);

  if (!total) {
    summary.textContent = 'Latest approved recaps will appear here.';
    container.textContent = 'No approved recaps yet.';
    return;
  }

  summary.textContent = showAllAudit
    ? `Showing all ${total} approved recap${total === 1 ? '' : 's'}.`
    : `Showing the latest ${visibleEntries.length} of ${total} approved recap${total === 1 ? '' : 's'}.`;

  container.innerHTML = visibleEntries
    .map((entry) => `
      <article class="activity-item">
        <div class="activity-item-header">
          <div class="activity-item-copy">
            <strong>${escapeHtml(entry.groupName)}</strong>
            <p>${entry.recap.decisions.length} decision item(s), ${entry.recap.actions.length} action item(s).</p>
          </div>
          <time datetime="${escapeHtml(entry.approvedAt)}">${escapeHtml(formatDateTime(entry.approvedAt))}</time>
        </div>
      </article>
    `)
    .join('');
}

function renderAdminActivityFeed() {
  const summary = $('#admin-activity-summary');
  const container = $('#admin-activity-log');
  if (!summary || !container) return;

  const total = recentUsageEventsCache.length;
  const defaultVisibleCount = 5;
  const visibleEntries = showAllAdminActivity ? recentUsageEventsCache : recentUsageEventsCache.slice(0, defaultVisibleCount);

  setToggleState('toggle-admin-activity', total <= defaultVisibleCount, showAllAdminActivity);

  if (!total) {
    summary.textContent = 'Latest workspace changes will appear here.';
    container.textContent = 'No recent workspace activity.';
    return;
  }

  summary.textContent = showAllAdminActivity
    ? `Showing all ${total} workspace event${total === 1 ? '' : 's'}.`
    : `Showing the latest ${visibleEntries.length} of ${total} workspace event${total === 1 ? '' : 's'}.`;

  container.innerHTML = visibleEntries
    .map((entry) => `
      <article class="activity-item">
        <div class="activity-item-header">
          <div class="activity-item-copy">
            <strong>${escapeHtml(entry.summary || entry.type || 'Activity')}</strong>
          </div>
          <time datetime="${escapeHtml(entry.createdAt || '')}">${escapeHtml(formatDateTime(entry.createdAt))}</time>
        </div>
      </article>
    `)
    .join('');
}

function renderBillingFeed() {
  const summary = $('#billing-admin-status');
  const container = $('#billing-admin-list');
  if (!summary || !container) return;

  const total = billingEntriesCache.length;
  const defaultVisibleCount = 4;
  const visibleEntries = showAllBilling ? billingEntriesCache : billingEntriesCache.slice(0, defaultVisibleCount);

  setToggleState('toggle-billing-feed', total <= defaultVisibleCount, showAllBilling);

  if (!total) {
    summary.textContent = 'Review paid, pending, and trial users here.';
    container.textContent = 'No billing records yet.';
    return;
  }

  summary.textContent = showAllBilling
    ? `Showing all ${total} billing record${total === 1 ? '' : 's'}.`
    : `Showing the latest ${visibleEntries.length} of ${total} billing record${total === 1 ? '' : 's'}.`;

  container.innerHTML = visibleEntries
    .map((entry) => {
      const actions = entry.email || entry.userId
        ? `
          <div class="billing-entry-actions">
            <button class="button compact-button" data-billing-action="activate" data-user-id="${escapeHtml(entry.userId || '')}" data-email="${escapeHtml(entry.email || '')}">Activate</button>
            <button class="button secondary compact-button" data-billing-action="reset" data-user-id="${escapeHtml(entry.userId || '')}" data-email="${escapeHtml(entry.email || '')}">Reset trial</button>
          </div>
        `
        : '';
      return `
        <article class="activity-item billing-activity-item">
          <div class="activity-item-header">
            <div class="activity-item-copy">
              <strong>${escapeHtml(entry.title || 'Billing record')}</strong>
              <p>${escapeHtml(entry.details || '')}</p>
            </div>
            ${entry.when ? `<time datetime="${escapeHtml(entry.when)}">${escapeHtml(formatDateTime(entry.when))}</time>` : ''}
          </div>
          ${actions}
        </article>
      `;
    })
    .join('');
}

function setQuickGuideOpen(isOpen) {
  const modal = $('#quick-guide-modal');
  if (!modal) return;
  modal.hidden = !isOpen;
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

function setPricingOpen(isOpen) {
  const modal = $('#pricing-modal');
  if (!modal) return;
  modal.hidden = !isOpen;
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

function setInstallHelpOpen(isOpen) {
  const modal = $('#install-help-modal');
  if (!modal) return;
  modal.hidden = !isOpen;
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

function showUpgradeNote() {
  const upgradeNote = $('#upgrade-note');
  if (!upgradeNote) return;
  upgradeNote.hidden = false;
  if (upgradeNoteDismissTimeout) {
    clearTimeout(upgradeNoteDismissTimeout);
  }
  upgradeNoteDismissTimeout = setTimeout(() => {
    upgradeNote.hidden = true;
  }, 6000);
}

async function startCheckout(planId) {
  showUpgradeNote();
  setPricingOpen(false);
  const payload = await api('/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ planId }),
  });
  window.location.href = payload.url;
}

async function openBillingPortal() {
  showUpgradeNote();
  setPricingOpen(false);
  const payload = await api('/api/billing/portal', {
    method: 'POST',
    body: '{}',
  });
  window.location.href = payload.url;
}

async function handlePlanAction(event) {
  const button = event.target.closest('[data-plan-action]');
  if (!button) return;
  const action = button.dataset.planAction;
  if (action === 'checkout') {
    await startCheckout(button.dataset.planId);
    return;
  }
  if (action === 'manage') {
    await openBillingPortal();
  }
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
  const status = $('#login-status');
  if (status) {
    status.textContent = message;
    status.hidden = !message;
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
  adminBillingLoaded = false;
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
  await loadAdminBilling();
}

async function loadStatus() {
  const status = await api('/api/status');
  managedWahaWorkspace = Boolean(status.managedWahaConnection);
  applyManagedWorkspaceUi();
  renderWorkspaceStatus(status);
  renderBillingPlans(status);
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
    setHintMessage('waha-status', 'WAHA is connected. Add OPENAI_API_KEY before real voice-note transcription will run.');
  } else {
    setHintMessage('waha-status', '');
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
  setHintMessage('settings-status', payload.settings.consentConfirmed
    ? 'Workspace settings saved. Recaps can be approved after you select a WhatsApp group.'
    : 'Consent must be confirmed before approving a recap.');
  await loadStatus();
}

async function checkWaha() {
  try {
    await saveSettings();
    const payload = await api('/api/waha/status');
    setHintMessage('waha-status', `WhatsApp session status: ${payload.status.status || 'reachable'}.`);
  } catch (error) {
    setHintMessage('waha-status', `WhatsApp check failed: ${error.message}`);
  }
}

async function startWaha() {
  try {
    await saveSettings();
    const payload = await api('/api/waha/start', { method: 'POST', body: '{}' });
    await loadStatus();
    setHintMessage('waha-status', `WhatsApp session status: ${payload.status.status || 'starting'}.`);
  } catch (error) {
    setHintMessage('waha-status', `WhatsApp start failed: ${error.message}`);
  }
}

async function switchWahaUser() {
  try {
    const payload = await api('/api/waha/logout', { method: 'POST', body: '{}' });
    currentApprovedGroupId = '';
    $('#group-name').value = '';
    $('#group-list').textContent = 'WhatsApp group not loaded yet.';
    $('#qr-box').textContent = 'Session ended. Start the session again, show the QR on the dashboard screen, and let the next person scan from WhatsApp Linked Devices.';
    setHintMessage('waha-status', `WhatsApp session status: ${payload.status.status || 'logged out'}. The next user can now scan a fresh QR from another screen.`);
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settingsPayload({
        approvedGroupId: '',
        approvedGroupName: '',
      })),
    });
    await loadStatus();
    setHintMessage('waha-status', `WhatsApp session status: ${payload.status.status || 'logged out'}. The next user can now scan a fresh QR from another screen.`);
  } catch (error) {
    setHintMessage('waha-status', `WhatsApp switch failed: ${error.message}`);
  }
}

async function showQr() {
  try {
    await saveSettings();
    const payload = await api('/api/waha/qr');
    if (!payload.qr?.data || !payload.qr?.mimetype) {
      $('#qr-box').textContent = 'QR is not available yet. Start or restart the session on another screen and try again.';
      return;
    }
    $('#qr-box').innerHTML = `
      <strong>Open this QR on another screen and scan it with your WhatsApp account.</strong>
      <img alt="WAHA WhatsApp QR code" src="data:${payload.qr.mimetype};base64,${payload.qr.data}" />
    `;
    setHintMessage('waha-status', 'QR loaded. Scan it now with WhatsApp Linked Devices while the QR stays open.');
  } catch (error) {
    $('#qr-box').textContent = `QR failed: ${error.message}`;
  }
}

async function loadGroups() {
  try {
    await saveSettings();
    const payload = await api('/api/groups');
    if (!payload.groups.length) {
      $('#group-list').textContent = 'No WhatsApp group found yet. Confirm the session is working, then try again.';
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
    setHintMessage('waha-status', `Loaded ${payload.groups.length} WhatsApp group chat(s). Choose the one group you want to summarize.`);
  } catch (error) {
    setHintMessage('waha-status', `Group load failed: ${error.message}`);
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
  setHintMessage('waha-status', `Selected group: ${payload.settings.approvedGroupName}.`);
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
    setHintMessage('waha-status', payload.warning
      ? `${payload.warning}. History is not available from WAHA right now; live capture only shows new messages received after the app is running. Captured now: ${payload.messages.length}.`
      : `Pulled ${payload.messages.length} captured message(s). Voice notes stay marked for review while transcription continues in the background.`);
  } catch (error) {
    setHintMessage('waha-status', `Pull failed: ${error.message}`);
  }
}

async function pullTodayMessages() {
  try {
    await saveSettings();
    const payload = await api('/api/waha/pull-today', { method: 'POST', body: '{}' });
    $('#chat-text').value = payload.chatText;
    $('#voice-notes').value = payload.voiceNotes || '';
    $('#summary-preset').value = 'today';
    setHintMessage('waha-status', payload.historyAvailable
      ? `Pulled ${payload.messages.length} WhatsApp message(s) from today and saved them. Voice-note transcription may finish shortly after this load.`
      : `WAHA cannot read today's earlier WhatsApp history in the current session. Loaded ${payload.messages.length} locally stored message(s) from today. Next fix: re-scan the NOWEB QR or import an exported chat.`);
    $('#range-status').textContent = `Today period loaded: ${payload.messages.length} stored message(s).`;
  } catch (error) {
    setHintMessage('waha-status', `Today's pull failed: ${error.message}`);
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

async function loadPeriodMessages() {
  const preset = $('#summary-preset').value;
  if (preset === 'today') {
    await pullTodayMessages();
    return;
  }
  await loadStoredRange();
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
    await loadStatus();
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
    setHintMessage('waha-status', `Live capture enabled for the selected group.`);
  } catch (error) {
    setHintMessage('waha-status', `Live capture setup failed: ${error.message}`);
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
  await loadStatus();
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
  auditEntriesCache = Array.isArray(payload.auditLog) ? payload.auditLog : [];
  renderAuditFeed();
}

function billingBadge(entry = {}) {
  const trial = entry.trial || {};
  const billing = entry.billing || {};
  if (billing.isSubscribed) return 'Paid';
  if (billing.isPendingActivation) return 'Pending activation';
  if (!trial.canUseApp) return 'Trial ended';
  return `Trial: ${trial.daysRemaining} day${trial.daysRemaining === 1 ? '' : 's'} left`;
}

function renderLatestAdminBilling(payload = {}) {
  const pendingEntries = (payload.pendingActivations || []).map((entry) => ({
    title: entry.email || 'Pending reservation',
    details: `${entry.planName || 'Nzuko AI Starter'} queued for activation${entry.workspaceName ? ` - ${entry.workspaceName}` : ''}.`,
    when: entry.queuedAt || '',
    userId: '',
    email: '',
  }));
  const userEntries = (payload.users || []).map((entry) => ({
    title: entry.displayName || entry.email || 'Workspace member',
    details: `${entry.email || 'No email recorded'} - ${billingBadge(entry)}${entry.workspaceName ? ` - ${entry.workspaceName}` : ''}`,
    when: entry.billing?.lastPaymentAt || entry.trial?.trialEndsAt || '',
    userId: entry.userId || '',
    email: entry.email || '',
  }));
  billingEntriesCache = [...pendingEntries, ...userEntries];
  renderBillingFeed();
  recentUsageEventsCache = Array.isArray(payload.recentUsageEvents) ? payload.recentUsageEvents : [];
  renderAdminActivityFeed();
}

function renderAdminBilling(payload = {}) {
  return renderLatestAdminBilling(payload);
  const status = $('#billing-admin-status');
  const list = $('#billing-admin-list');
  if (!status || !list) return;

  const pendingCount = Array.isArray(payload.pendingActivations) ? payload.pendingActivations.length : 0;
  status.textContent = pendingCount
    ? `${pendingCount} payment reservation${pendingCount === 1 ? '' : 's'} waiting for activation.`
    : 'No pending payment reservations right now.';

  const sections = [];

  if (pendingCount) {
    sections.push(`
      <div class="billing-section">
        <strong>Pending reservations</strong>
        ${payload.pendingActivations.map((entry) => `
          <article class="billing-user-card">
            <div>
              <strong>${escapeHtml(entry.email)}</strong>
              <small>${escapeHtml(entry.planName || 'Nzuko AI Starter')} · queued ${escapeHtml(formatDateTime(entry.queuedAt))}</small>
            </div>
          </article>
        `).join('')}
      </div>
    `);
  }

  sections.push(`
    <div class="billing-section">
      <strong>Workspace users</strong>
      ${(payload.users || []).map((entry) => `
        <article class="billing-user-card">
          <div>
            <strong>${escapeHtml(entry.displayName || entry.email || 'Workspace member')}</strong>
            <small>${escapeHtml(entry.email || '')}</small>
            <small>${escapeHtml(billingBadge(entry))}</small>
          </div>
          <div class="billing-user-actions">
            <button class="button" data-billing-action="activate" data-user-id="${escapeHtml(entry.userId || '')}" data-email="${escapeHtml(entry.email || '')}">Activate</button>
            <button class="button secondary" data-billing-action="reset" data-user-id="${escapeHtml(entry.userId || '')}" data-email="${escapeHtml(entry.email || '')}">Reset trial</button>
          </div>
        </article>
      `).join('')}
    </div>
  `);

  list.innerHTML = sections.join('');
  recentUsageEventsCache = Array.isArray(payload.recentUsageEvents) ? payload.recentUsageEvents : [];
  renderAdminActivityFeed();
}

async function loadAdminBilling(force = false) {
  if (!latestStatus?.admin?.isAdmin) return;
  if (adminBillingLoaded && !force) return;
  try {
    const payload = await api('/api/admin/billing');
    renderLatestAdminBilling(payload);
    adminBillingLoaded = true;
  } catch (error) {
    const status = $('#billing-admin-status');
    if (status) {
      status.textContent = `Billing controls are temporarily unavailable: ${error.message}`;
    }
  }
}

async function handleBillingAdminAction(event) {
  const button = event.target.closest('[data-billing-action]');
  if (!button) return;
  const action = button.dataset.billingAction;
  const payload = {
    userId: button.dataset.userId,
    email: button.dataset.email,
  };
  if (action === 'activate') {
    await api('/api/admin/billing/activate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } else if (action === 'reset') {
    await api('/api/admin/billing/reset', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } else {
    return;
  }
  await Promise.all([loadStatus(), loadAdminBilling(true)]);
}

$('#save-settings').addEventListener('click', saveSettings);
$('#check-waha').addEventListener('click', checkWaha);
$('#start-waha').addEventListener('click', startWaha);
$('#show-qr').addEventListener('click', showQr);
$('#switch-waha-user').addEventListener('click', switchWahaUser);
$('#load-groups').addEventListener('click', loadGroups);
$('#group-list').addEventListener('click', chooseGroup);
$('#configure-webhook').addEventListener('click', configureWebhook);
$('#load-period-messages').addEventListener('click', loadPeriodMessages);
$('#generate-range').addEventListener('click', generateRangeRecap);
$('#generate').addEventListener('click', generateRecap);
$('#approve').addEventListener('click', approveRecap);
$('#purge').addEventListener('click', purgeDraft);
$('#continue-google').addEventListener('click', continueWithGoogle);
$('#sign-in-link').addEventListener('click', continueWithGoogle);
$('#logout')?.addEventListener('click', logout);
$('#back-to-login')?.addEventListener('click', logout);
$('#open-quick-guide')?.addEventListener('click', () => setQuickGuideOpen(true));
$('#close-quick-guide')?.addEventListener('click', () => setQuickGuideOpen(false));
$('#quick-guide-backdrop')?.addEventListener('click', () => setQuickGuideOpen(false));
$('#open-pricing')?.addEventListener('click', () => setPricingOpen(true));
$('#close-pricing')?.addEventListener('click', () => setPricingOpen(false));
$('#pricing-backdrop')?.addEventListener('click', () => setPricingOpen(false));
$('#close-install-help')?.addEventListener('click', () => setInstallHelpOpen(false));
$('#install-help-backdrop')?.addEventListener('click', () => setInstallHelpOpen(false));
$('#refresh-billing')?.addEventListener('click', () => loadAdminBilling(true));
$('#billing-admin-list')?.addEventListener('click', handleBillingAdminAction);
$('#manage-billing')?.addEventListener('click', openBillingPortal);
$('#install-app')?.addEventListener('click', installApp);
$('#pricing-plan-cards')?.addEventListener('click', handlePlanAction);
$('#toggle-audit-feed')?.addEventListener('click', () => {
  showAllAudit = !showAllAudit;
  renderAuditFeed();
});
$('#toggle-billing-feed')?.addEventListener('click', () => {
  showAllBilling = !showAllBilling;
  renderBillingFeed();
});
$('#toggle-admin-activity')?.addEventListener('click', () => {
  showAllAdminActivity = !showAllAdminActivity;
  renderAdminActivityFeed();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setQuickGuideOpen(false);
    setPricingOpen(false);
    setInstallHelpOpen(false);
  }
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallButton();
});

clearDraftFields();
paymentQueryState = readPaymentQueryState();
await registerServiceWorker();
updateInstallButton();
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
