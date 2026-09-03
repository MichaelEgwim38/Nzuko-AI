import { browserSupabase } from './supabase-browser.js';
import { importedConversationText } from './importText.js';

const $ = (selector) => document.querySelector(selector);
let currentApprovedGroupId = '';
let currentApprovedGroups = [];
let currentGroupLimit = 1;
let supabaseClient = null;
let authConfig = null;
let managedWahaWorkspace = false;
let currentWorkflowType = 'meeting-minutes';
let currentWorkspaceTemplate = '';
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
let selectedBillingInterval = 'monthly';
let currentTelegramGroupId = '';
let currentTelegramGroupName = '';
let telegramPollTimer = null;
let operationalActionsCache = [];
let activeActionFilter = 'open';
let messagePeriodSource = '';
let selectedMessagePeriod = 'today';

const workspaceTemplates = {
  'healthcare-operations': {
    name: 'Healthcare operations',
    icon: '/assets/purpose/healthcare-operations.png',
    description: 'Staff handovers, actions and operational escalations',
    workflowType: 'shift-handover',
    instructions: '',
  },
  'property-facilities': {
    name: 'Property & facilities',
    icon: '/assets/purpose/property-facilities.png',
    description: 'Faults, site visits, owners and follow-ups',
    workflowType: 'custom',
    instructions: 'Identify the site or asset, reported fault, urgency or safety concern, work completed, evidence provided, responsible person, access requirement, deadline and unresolved follow-up.',
  },
  'field-service': {
    name: 'Field service',
    icon: '/assets/purpose/field-service.png',
    description: 'Job updates, blockers and next steps',
    workflowType: 'project-update',
    instructions: '',
  },
  'community-charity': {
    name: 'Community & charity',
    icon: '/assets/purpose/community-charity.png',
    description: 'Minutes, decisions, volunteers and actions',
    workflowType: 'meeting-minutes',
    instructions: '',
  },
  personal: {
    name: 'Personal productivity',
    icon: '/assets/purpose/personal-productivity.png',
    description: 'Commitments, reminders and follow-ups',
    workflowType: 'custom',
    instructions: 'Identify commitments, reminders, appointments, promised follow-ups, owners, deadlines and unresolved personal actions.',
  },
};

const landingModeExamples = {
  'property-facilities': {
    conversation: '“The boiler at Oak House is losing pressure again. James will inspect it tomorrow and report back by 2pm.”',
    report: [['Issue', 'Boiler losing pressure'], ['Location', 'Oak House'], ['Owner', 'James'], ['Deadline', 'Tomorrow, 2pm']],
  },
  'healthcare-operations': {
    conversation: '“The evening rota is short by one person. Amara will call the agency and confirm cover before 4pm.”',
    report: [['Operational issue', 'Evening rota short'], ['Action', 'Contact staffing agency'], ['Owner', 'Amara'], ['Deadline', 'Today, 4pm']],
  },
  'field-service': {
    conversation: '“Unit 14 is repaired, but the replacement valve still needs ordering. Leon will send the part number this afternoon.”',
    report: [['Job', 'Unit 14 repair'], ['Status', 'Repair completed'], ['Outstanding', 'Order replacement valve'], ['Owner', 'Leon']],
  },
  'community-charity': {
    conversation: '“We agreed to hold the food-drive on Saturday. Ruth will book the hall and Daniel will organise six volunteers.”',
    report: [['Decision', 'Food-drive on Saturday'], ['Venue owner', 'Ruth'], ['Volunteer owner', 'Daniel'], ['Requirement', 'Six volunteers']],
  },
  personal: {
    conversation: '“I need to send the application by Friday, call the dentist tomorrow and follow up with Maya about the invoice.”',
    report: [['Priority', 'Submit application'], ['Deadline', 'Friday'], ['Reminder', 'Call dentist tomorrow'], ['Follow-up', 'Maya — invoice']],
  },
};

let selectedLandingMode = 'property-facilities';
let whatsappQrVisible = false;
let telegramQrVisible = false;
let whatsappPollTimer = null;

const actionModeCopy = {
  'healthcare-operations': { eyebrow: 'Approved shift actions', heading: 'Keep every handover accountable', owner: 'Responsible staff member', empty: 'Approved handover actions will appear here.' },
  'property-facilities': { eyebrow: 'Approved site actions', heading: 'Keep every site issue moving', owner: 'Owner or contractor', empty: 'Approved faults, visits and follow-ups will appear here.' },
  'field-service': { eyebrow: 'Approved job actions', heading: 'Move every job to completion', owner: 'Technician or owner', empty: 'Approved job actions and next steps will appear here.' },
  'community-charity': { eyebrow: 'Approved community actions', heading: 'Keep every commitment moving', owner: 'Volunteer or owner', empty: 'Approved meeting commitments will appear here.' },
  personal: { eyebrow: 'My approved actions', heading: 'Turn conversations into progress', owner: 'Owner', empty: 'Your approved reminders and follow-ups will appear here.' },
};

const EMPTY_DRAFT_MESSAGE = 'No draft yet. Load messages from WhatsApp or Telegram, or try a sample report.';

function setConnectionStatus(statusId, manageId, label, state = 'disconnected') {
  const status = $(`#${statusId}`);
  const manage = $(`#${manageId}`);
  if (status) {
    status.textContent = label;
    status.classList.toggle('is-connected', state === 'connected');
    status.classList.toggle('is-pending', state === 'pending');
    status.classList.toggle('is-disconnected', state === 'disconnected' || state === 'error');
  }
  if (manage) manage.hidden = state !== 'connected';
}

function isStandaloneMode() {
  return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone;
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent || '');
}

function isMobileDevice() {
  return window.matchMedia?.('(max-width: 760px)')?.matches || /android|iphone|ipad|ipod/i.test(window.navigator.userAgent || '');
}

function configureConnectionExperience() {
  const mobile = isMobileDevice();
  document.body.classList.toggle('mobile-connection-experience', mobile);
  document.querySelectorAll('.mobile-connect-control').forEach((element) => {
    if (!mobile) element.hidden = true;
    else if (element.matches('button.mobile-connect-control')) element.hidden = false;
  });
  if (mobile) {
    $('#show-qr').textContent = 'Get QR code';
    $('#start-telegram').textContent = 'Connect Telegram';
  }
}

function updateInstallButton() {
  const button = $('#install-app');
  const loginButton = $('#login-install-app');
  const footerButton = $('#footer-install-app');
  const currentDeviceButton = $('#install-current-device');
  const isStandalone = isStandaloneMode();
  const canShowIosHelp = isIosDevice();
  if (button) {
    button.hidden = (!deferredInstallPrompt && !canShowIosHelp) || Boolean(isStandalone);
    button.textContent = 'Get the app';
  }
  if (loginButton) {
    loginButton.hidden = Boolean(isStandalone);
    loginButton.textContent = 'Get the app';
  }
  if (footerButton) {
    footerButton.hidden = Boolean(isStandalone);
    footerButton.textContent = 'Get the app';
  }
  if (currentDeviceButton) {
    currentDeviceButton.hidden = !deferredInstallPrompt || Boolean(isStandalone);
  }
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
  const sidebarEmail = $('#sidebar-account-email');
  if (heading) {
    heading.textContent = `Welcome back, ${firstName}`;
  }
  if (kicker) {
    kicker.textContent = 'Your conversation operations workspace';
  }
  if (sidebarName) {
    sidebarName.textContent = firstName;
  }
  if (sidebarRole) {
    sidebarRole.textContent = 'Workspace member';
  }
  if (sidebarEmail) {
    sidebarEmail.textContent = String(user.email || '').trim();
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
  const openAdminButton = $('#open-admin');
  const sidebarRole = $('#sidebar-account-role');
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
    if (!shouldShowAdmin) {
      adminBillingPanel.hidden = true;
      adminBillingLoaded = false;
    }
  }

  if (openAdminButton) {
    openAdminButton.hidden = !admin.isAdmin;
  }

  if (sidebarRole && admin.isAdmin) {
    sidebarRole.textContent = 'Owner account';
  }
  const ownerIdentity = $('#admin-owner-identity');
  if (ownerIdentity) {
    ownerIdentity.textContent = admin.isAdmin ? `Signed in as ${status.user?.email || ''}` : '';
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
  ['load-groups', 'configure-webhook', 'load-whatsapp-messages', 'load-telegram-messages', 'generate', 'approve'].forEach((id) =>
    setButtonDisabled(id, !canOperateLive)
  );
}

function renderBillingPlans(status = {}) {
  const publicPricing = Boolean(status.publicPricing);
  const trial = status.trial || {};
  const billing = status.billing || {};
  const container = $('#pricing-plan-cards');
  const summary = $('#pricing-plan-status');
  const manageButton = $('#manage-billing');
  const trialRow = $('#pricing-trial-row');
  const plans = Array.isArray(billing.plans) ? billing.plans : [];
  const usage = billing.usage || {};
  const topUpSection = $('#pricing-topups');
  const topUpContainer = $('#pricing-topup-cards');
  const topUpBalance = $('#topup-balance');

  if (topUpSection) topUpSection.hidden = !trial.isSubscribed;
  if (topUpContainer && trial.isSubscribed) {
    const topUps = Array.isArray(billing.topUps) ? billing.topUps : [];
    topUpContainer.innerHTML = topUps.map((topUp) => `
      <article class="topup-card">
        <div><strong>${escapeHtml(topUp.name || '')}</strong><small>${escapeHtml(topUp.priceLabel || '')} one-time payment</small></div>
        <button class="button compact-button" type="button" data-topup-id="${escapeHtml(topUp.id || '')}" ${topUp.checkoutEnabled ? '' : 'disabled'}>Buy</button>
      </article>
    `).join('');
  }
  if (topUpBalance && trial.isSubscribed) {
    topUpBalance.textContent = `Available top-ups: ${usage.recapTopUpCredits || 0} reports and ${usage.transcriptionTopUpMinutes || 0} transcription minutes.`;
  }

  if (manageButton) {
    manageButton.hidden = !billing.customerPortalAvailable;
  }

  if (trialRow) {
    trialRow.hidden = publicPricing || trial.isSubscribed || !trial.canUseApp;
  }

  if (!container || !summary) return;

  if (!plans.length) {
    summary.textContent = 'Pricing plans will appear here after billing configuration is complete.';
    container.textContent = 'Plans are not configured yet.';
    return;
  }

  const checkoutEnabled = plans.some((plan) => plan.checkoutEnabled);

  if (!checkoutEnabled) {
    summary.textContent = 'Personal, Starter and Pro are defined locally. Add Stripe price ids and webhook settings before checkout can go live.';
  } else if (trial.isSubscribed) {
    const usageNotes = [];
    if (Number.isFinite(usage.recapRemaining) && Number.isFinite(usage.recapLimit)) {
      usageNotes.push(`${usage.recapRemaining} of ${usage.recapLimit} recaps left`);
    }
    if (Number.isFinite(usage.transcriptionMinutesRemaining) && Number.isFinite(usage.transcriptionMinuteLimit)) {
      usageNotes.push(`${usage.transcriptionMinutesRemaining} of ${usage.transcriptionMinuteLimit} transcription minutes left`);
    }
    summary.textContent = usageNotes.length
      ? `${billing.planName || 'Paid access'} is active. ${usageNotes.join(' · ')} in the current billing window. Use Manage billing for plan changes or cancellations.`
      : `${billing.planName || 'Paid access'} is active. Use Manage billing for plan changes or cancellations.`;
  } else if (publicPricing) {
    summary.textContent = 'Choose a plan after your free trial. Sign in with Google to create your workspace—no card required.';
  } else if (trial.canUseApp) {
    summary.textContent = 'You are on the free trial. Choose Personal for your own follow-ups, Starter for a small team or Pro for busy operations.';
  } else {
    summary.textContent = 'Your trial has ended. Choose a paid plan in Stripe to keep using the workspace.';
  }

  container.innerHTML = plans
    .map((plan) => {
      const selectedPrice = plan.prices?.[selectedBillingInterval] || {
        label: plan.priceLabel,
        checkoutEnabled: plan.checkoutEnabled,
      };
      const isCurrent = Boolean(plan.isCurrent && trial.isSubscribed);
      const buttonLabel = publicPricing
        ? `Start free with ${plan.name}`
        : isCurrent
        ? 'Current plan'
        : trial.isSubscribed
          ? 'Manage in billing'
          : `Choose ${plan.name}`;
      return `
        <article class="plan-card${isCurrent ? ' plan-card-current' : ''}">
          <div class="plan-card-header">
            <div>
              <p class="plan-card-price">${escapeHtml(selectedPrice.label || '')}</p>
              <h3>${escapeHtml(plan.name || '')}</h3>
            </div>
            ${isCurrent ? '<span class="plan-badge">Active</span>' : plan.badgeLabel ? `<span class="plan-badge">${escapeHtml(plan.badgeLabel)}</span>` : ''}
          </div>
          <p class="plan-card-summary">${escapeHtml(plan.summary || '')}</p>
          <ul class="plan-feature-list">
            ${(plan.features || []).map((feature) => `<li>${escapeHtml(feature)}</li>`).join('')}
          </ul>
          <button
            class="button${isCurrent ? ' secondary' : ''}"
            type="button"
            data-plan-action="${publicPricing ? 'signin' : trial.isSubscribed ? 'manage' : 'checkout'}"
            data-plan-id="${escapeHtml(plan.id || '')}"
            data-billing-interval="${escapeHtml(selectedBillingInterval)}"
            ${!publicPricing && !trial.isSubscribed && !selectedPrice.checkoutEnabled ? 'disabled' : ''}
            ${isCurrent ? 'disabled' : ''}
          >${escapeHtml(buttonLabel)}</button>
        </article>
      `;
    })
    .join('');
}

function syncLanguageOptions(options = [], whatsappSelected = 'auto', telegramSelected = 'auto') {
  if (!options.length) return;
  [
    ['whatsapp-transcribe-language', whatsappSelected],
    ['telegram-transcribe-language', telegramSelected],
  ].forEach(([id, selected]) => {
    const select = $(`#${id}`);
    if (!select) return;
    select.innerHTML = options
      .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join('');
    select.value = selected;
  });
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
            <p>${escapeHtml(entry.recap.workflowName || 'Meeting Minutes')} · ${(entry.recap.decisions || []).length} decision item(s), ${(entry.recap.actions || []).length} action item(s).</p>
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
      const accessAction = entry.isSuspended
        ? `<button class="button secondary compact-button" data-billing-action="restore" data-user-id="${escapeHtml(entry.userId || '')}" data-email="${escapeHtml(entry.email || '')}">Restore</button>`
        : `<button class="button danger compact-button" data-billing-action="suspend" data-user-id="${escapeHtml(entry.userId || '')}" data-email="${escapeHtml(entry.email || '')}">Suspend</button>`;
      const actions = entry.email || entry.userId
        ? `
          <div class="billing-entry-actions">
            <button class="button compact-button" data-billing-action="activate" data-user-id="${escapeHtml(entry.userId || '')}" data-email="${escapeHtml(entry.email || '')}">Activate</button>
            <button class="button secondary compact-button" data-billing-action="reset" data-user-id="${escapeHtml(entry.userId || '')}" data-email="${escapeHtml(entry.email || '')}">Reset trial</button>
            ${accessAction}
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

function startFreeTrial() {
  setPricingOpen(false);
  const setup = $('#workflow-setup');
  setup?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setup?.querySelector('select, button, input')?.focus({ preventScroll: true });
}

async function openPricing() {
  setPricingOpen(true);
  const container = $('#pricing-plan-cards');
  const summary = $('#pricing-plan-status');
  if (container) container.textContent = 'Loading current plans…';
  if (summary) summary.textContent = 'Checking your trial and subscription options.';
  try {
    if (latestStatus?.user?.userId) {
      await loadStatus();
    } else {
      const publicPlans = await api('/api/plans');
      renderBillingPlans(publicPlans);
    }
  } catch (error) {
    if (container) container.textContent = 'Plans could not be loaded.';
    if (summary) summary.textContent = error.message || 'Please close this window and try again.';
  }
}

function setInstallHelpOpen(isOpen) {
  const modal = $('#install-help-modal');
  if (!modal) return;
  modal.hidden = !isOpen;
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

function setContactOpen(isOpen) {
  const modal = $('#contact-modal');
  if (!modal) return;
  modal.hidden = !isOpen;
  document.body.style.overflow = isOpen ? 'hidden' : '';
  if (isOpen) window.requestAnimationFrame(() => $('#contact-form input[name="name"]')?.focus());
}

async function submitContactForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#submit-contact');
  const status = $('#contact-status');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Sending your message…';
  try {
    const body = new URLSearchParams(new FormData(form));
    const response = await fetch('/contact.html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) throw new Error('Message could not be sent.');
    form.reset();
    if (status) status.textContent = 'Thank you. Your message has been sent to Rohari Group.';
  } catch (error) {
    if (status) status.textContent = `${error.message || 'Message could not be sent.'} Please email info@roharigroup.com.`;
  } finally {
    if (button) button.disabled = false;
  }
}

function setAdminOpen(isOpen) {
  const modal = $('#admin-billing-panel');
  if (!modal || !latestStatus?.admin?.isAdmin) return;
  modal.hidden = !isOpen;
  document.body.style.overflow = isOpen ? 'hidden' : '';
  if (isOpen) loadAdminBilling(true);
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

async function startCheckout(planId, billingInterval = 'monthly') {
  showUpgradeNote();
  setPricingOpen(false);
  const payload = await api('/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ planId, billingInterval }),
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

async function startTopUpCheckout(topUpId) {
  showUpgradeNote();
  setPricingOpen(false);
  const payload = await api('/api/billing/topup-checkout', {
    method: 'POST',
    body: JSON.stringify({ topUpId }),
  });
  window.location.href = payload.url;
}

async function handlePlanAction(event) {
  const topUpButton = event.target.closest('[data-topup-id]');
  if (topUpButton) {
    await startTopUpCheckout(topUpButton.dataset.topupId);
    return;
  }
  const button = event.target.closest('[data-plan-action]');
  if (!button) return;
  const action = button.dataset.planAction;
  if (action === 'signin') {
    setPricingOpen(false);
    await continueWithGoogle();
    return;
  }
  if (action === 'checkout') {
    await startCheckout(button.dataset.planId, button.dataset.billingInterval);
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
  $('#source-screen').hidden = true;
  $('#purpose-screen').hidden = true;
  $('#app-shell').hidden = true;
  const status = $('#login-status');
  if (status) {
    status.textContent = message;
    status.hidden = !message;
  }
}

function showPilotInterest() {
  const title = $('.login-title');
  const providers = $('#provider-buttons');
  const signInPrompt = $('.auth-signin-prompt');
  const form = $('#pilot-interest');
  if (title) title.textContent = 'Join the Nzuko AI private pilot';
  if (providers) providers.hidden = true;
  if (signInPrompt) signInPrompt.hidden = true;
  if (form) form.hidden = false;
  showLogin('Turn busy WhatsApp group conversations into clear minutes, decisions, and action items. Request early access today.');
}

function showApp() {
  $('#login-screen').hidden = true;
  $('#source-screen').hidden = true;
  $('#purpose-screen').hidden = true;
  $('#app-shell').hidden = false;
}

function renderLandingMode(modeId) {
  const template = workspaceTemplates[modeId];
  const example = landingModeExamples[modeId];
  if (!template || !example) return;
  selectedLandingMode = modeId;
  if ($('#mode-discovery')) $('#mode-discovery').dataset.activeMode = modeId;
  document.querySelectorAll('[data-landing-mode]').forEach((button) => {
    const selected = button.dataset.landingMode === modeId;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  $('#mode-demo-label').textContent = template.name;
  $('#mode-demo-conversation').textContent = example.conversation;
  $('#mode-demo-report').innerHTML = example.report.map(([label, value]) => `<p><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></p>`).join('');
  $('#try-selected-mode').innerHTML = `Try ${escapeHtml(template.name)} free <span aria-hidden="true">→</span>`;
}

function scrollToModeDiscovery() {
  $('#mode-discovery')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function startSelectedMode() {
  window.localStorage.setItem('nzuko-pending-mode', selectedLandingMode);
  await continueWithGoogle();
}

function showSourceScreen() {
  const template = workspaceTemplates[currentWorkspaceTemplate];
  $('#login-screen').hidden = true;
  $('#purpose-screen').hidden = true;
  $('#app-shell').hidden = true;
  $('#source-screen').hidden = false;
  $('#source-screen').dataset.activeMode = currentWorkspaceTemplate || 'personal';
  if ($('#source-mode-icon')) $('#source-mode-icon').src = template?.icon || '/assets/purpose/personal-productivity.png';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function chooseConversationSource(event) {
  const source = event.currentTarget.dataset.sourceChoice;
  showApp();
  if (source === 'whatsapp') {
    window.location.hash = 'connect';
    $('#connect .connection-disclosure').open = true;
  } else if (source === 'telegram') {
    window.location.hash = 'telegram-connect';
    $('#telegram-connect .connection-disclosure').open = true;
  } else if (source === 'sample') {
    await runSampleReport();
  }
}

async function runSampleReport() {
  showApp();
  setQuickGuideOpen(false);
  try {
    const payload = await api('/api/sample');
    $('#chat-text').value = payload.chatText || '';
    $('#voice-notes').value = payload.voiceNotes || '';
    $('#input-source').value = 'sample';
    $('#recap-output').textContent = payload.recap?.text || 'The sample preview could not be generated.';
    $('#draft-workflow-name').textContent = `${payload.recap?.workflowName || workflowName()} sample`;
    $('#approve-status').textContent = 'Sample preview only. Load your own WhatsApp or Telegram messages to create an approvable report.';
    setButtonDisabled('approve', true);
    setHintMessage('import-status', 'Sample conversation used for this preview. It does not use your report allowance.');
    window.location.hash = 'review';
  } catch (error) {
    setHintMessage('import-status', `The sample could not be loaded: ${error.message}`);
    $('#source-material-review').open = true;
    window.location.hash = 'review';
  }
}

function setPurposeScreenOpen(isOpen) {
  const purposeScreen = $('#purpose-screen');
  const appShell = $('#app-shell');
  if (!purposeScreen || !appShell) return;
  purposeScreen.hidden = !isOpen;
  $('#source-screen').hidden = true;
  appShell.hidden = isOpen;
  $('#purpose-back').hidden = !currentWorkspaceTemplate;
  if (isOpen) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    window.requestAnimationFrame(() => $('#purpose-heading')?.focus?.());
  }
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
  await Promise.all([loadAudit(), loadActions(), checkWaha(), checkTelegramStatus()]);
  await loadAdminBilling();
}

async function loadStatus() {
  const status = await api('/api/status');
  managedWahaWorkspace = Boolean(status.managedWahaConnection);
  applyManagedWorkspaceUi();
  renderWorkspaceStatus(status);
  renderBillingPlans(status);
  currentApprovedGroupId = status.settings.approvedGroupId || '';
  currentApprovedGroups = Array.isArray(status.settings.approvedGroups) ? status.settings.approvedGroups : [];
  currentGroupLimit = Number(status.groupAccess?.limit || 1);
  $('#group-name').value = status.settings.approvedGroupName || '';
  setConnectionStatus(
    'connection-summary-status',
    'whatsapp-manage-connection',
    'Checking connection...',
    'pending'
  );
  $('#connector-mode').value = status.settings.connectorMode;
  $('#consent-confirmed').checked = status.settings.consentConfirmed;
  setButtonDisabled('load-whatsapp-messages', !currentApprovedGroupId || !status.settings.consentConfirmed);
  setWorkflowSelection(status.settings.workflowType || 'meeting-minutes');
  $('#workflow-custom-instructions').value = status.settings.workflowCustomInstructions || '';
  const pendingWorkspaceTemplate = window.localStorage.getItem('nzuko-pending-mode') || '';
  const shouldApplyPendingTemplate = !status.settings.workspaceTemplate && Boolean(workspaceTemplates[pendingWorkspaceTemplate]);
  currentWorkspaceTemplate = status.settings.workspaceTemplate || (shouldApplyPendingTemplate ? pendingWorkspaceTemplate : '');
  if (shouldApplyPendingTemplate) {
    const pendingTemplate = workspaceTemplates[currentWorkspaceTemplate];
    setWorkflowSelection(pendingTemplate.workflowType);
    $('#workflow-custom-instructions').value = pendingTemplate.instructions;
  }
  renderWorkspaceTemplate();
  renderWorkspacePurposeSummary();
  $('#outbound-webhook-url').value = status.settings.outboundWebhookUrl || '';
  $('#outbound-webhook-enabled').checked = Boolean(status.settings.outboundWebhookEnabled);
  $('#outbound-webhook-secret').value = '';
  $('#outbound-webhook-secret').placeholder = status.settings.outboundWebhookSecret
    ? 'Signing secret configured'
    : 'Create a strong secret for signature verification';
  currentTelegramGroupId = status.settings.telegramGroupId || '';
  currentTelegramGroupName = status.settings.telegramGroupName || '';
  $('#telegram-group-name').value = currentTelegramGroupName;
  $('#telegram-consent-confirmed').checked = Boolean(status.settings.telegramConsentConfirmed);
  $('#ai-processing-confirmed').checked = Boolean(status.settings.aiProcessingConfirmed);
  setHintMessage('ai-processing-status', status.settings.aiProcessingConfirmed
    ? `Authorised${status.settings.aiProcessingConfirmedAt ? ` on ${new Date(status.settings.aiProcessingConfirmedAt).toLocaleDateString()}` : ''}.`
    : 'Off. Nzuko AI will use its standard local report rules.');
  setButtonDisabled('load-telegram-messages', !currentTelegramGroupId || !status.settings.telegramConsentConfirmed);
  setConnectionStatus(
    'telegram-summary-status',
    'telegram-manage-connection',
    'Checking connection...',
    'pending'
  );
  $('#waha-base-url').value = status.settings.wahaBaseUrl;
  $('#waha-session').value = status.settings.wahaSession;
  $('#waha-base-url').readOnly = managedWahaWorkspace;
  $('#waha-session').readOnly = managedWahaWorkspace;
  $('#waha-api-key').disabled = managedWahaWorkspace;
  syncLanguageOptions(
    status.transcription?.languageOptions || [],
    status.settings.transcribeLanguage || status.transcription?.language || 'auto',
    status.settings.telegramTranscribeLanguage || 'auto'
  );
  $('#waha-api-key').placeholder = status.settings.wahaApiKey ? 'API key configured' : 'Only if WAHA requires X-Api-Key';
  if (status.transcription && !status.transcription.openaiKeyConfigured) {
    setHintMessage('waha-status', 'WAHA is connected. Add OPENAI_API_KEY before real voice-note transcription will run.');
  } else {
    setHintMessage('waha-status', '');
  }
  $('#approve-status').textContent = managedWahaWorkspace
    ? 'Review the draft, then approve it when you are ready to post or export it.'
    : 'Posting uses the currently selected connector mode.';
  if (shouldApplyPendingTemplate) {
    await saveWorkflow();
    window.localStorage.removeItem('nzuko-pending-mode');
    showSourceScreen();
  } else {
    setPurposeScreenOpen(!currentWorkspaceTemplate);
  }
}

function selectedWorkflowType() {
  return $('#workflow-type')?.value || 'meeting-minutes';
}

function renderWorkspaceTemplate() {
  document.body.dataset.nzukoMode = currentWorkspaceTemplate || 'personal';
  document.querySelectorAll('.purpose-card').forEach((card) => {
    const selected = card.dataset.workspaceTemplate === currentWorkspaceTemplate;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

function renderWorkspacePurposeSummary() {
  const template = workspaceTemplates[currentWorkspaceTemplate];
  const name = $('#workspace-purpose-name');
  const heroIcon = $('#dashboard-purpose-icon');
  if (name) name.textContent = template?.name || 'Choose your Nzuko Mode';
  if (heroIcon) heroIcon.src = template?.icon || '/assets/purpose/personal-productivity.png';
  renderActionMode();
}

function renderActionMode() {
  const copy = actionModeCopy[currentWorkspaceTemplate] || {
    eyebrow: 'Approved operational actions',
    heading: 'Keep every commitment moving',
    owner: 'Owner',
    empty: 'Approved report actions will appear here.',
  };
  if ($('#actions-eyebrow')) $('#actions-eyebrow').textContent = copy.eyebrow;
  if ($('#actions-heading')) $('#actions-heading').textContent = copy.heading;
  if ($('#actions-description')) $('#actions-description').textContent = currentWorkspaceTemplate === 'personal'
    ? 'Your actions become official only after you approve the source report.'
    : 'Actions become official only after a person approves the source report.';
  $('#acknowledgement-metric')?.toggleAttribute('hidden', currentWorkspaceTemplate === 'personal');
  renderActions();
}

async function chooseWorkspaceTemplate(event) {
  const templateId = event.currentTarget.dataset.workspaceTemplate;
  const template = workspaceTemplates[templateId];
  if (!template) return;
  currentWorkspaceTemplate = templateId;
  setWorkflowSelection(template.workflowType);
  $('#workflow-custom-instructions').value = template.instructions;
  renderWorkspaceTemplate();
  try {
    await saveWorkflow();
    renderWorkspacePurposeSummary();
    setHintMessage('workflow-status', `${template.name} selected. Your reports are now configured for this workspace.`);
    showSourceScreen();
  } catch (error) {
    setHintMessage('workflow-status', error.message);
  }
}

function workflowName(type = selectedWorkflowType()) {
  return ({
    'meeting-minutes': 'Meeting Minutes',
    'shift-handover': 'Shift Handover',
    'project-update': 'Project Update',
    custom: 'Custom Workflow',
  })[type] || 'Meeting Minutes';
}

function setWorkflowSelection(type) {
  currentWorkflowType = type;
  const select = $('#workflow-type');
  if (select) {
    select.value = [...select.options].some((option) => option.value === type) ? type : 'meeting-minutes';
  }
  $('#custom-workflow-field').hidden = selectedWorkflowType() !== 'custom';
  $('#draft-workflow-name').textContent = `${workflowName()} draft`;
  if ($('#generate')) $('#generate').textContent = `Generate ${workflowName().toLowerCase()}`;
}

function settingsPayload(extra = {}) {
  const payload = {
    approvedGroupName: $('#group-name').value.trim(),
    approvedGroups: currentApprovedGroups,
    consentConfirmed: $('#consent-confirmed').checked,
    connectorMode: $('#connector-mode').value,
    transcribeLanguage: $('#whatsapp-transcribe-language')?.value || 'auto',
    telegramTranscribeLanguage: $('#telegram-transcribe-language')?.value || 'auto',
    workflowType: selectedWorkflowType(),
    workflowCustomInstructions: $('#workflow-custom-instructions').value.trim(),
    workspaceTemplate: currentWorkspaceTemplate,
    outboundWebhookUrl: $('#outbound-webhook-url')?.value.trim() || '',
    outboundWebhookEnabled: Boolean($('#outbound-webhook-enabled')?.checked),
    telegramGroupId: currentTelegramGroupId,
    telegramGroupName: currentTelegramGroupName,
    telegramConsentConfirmed: $('#telegram-consent-confirmed')?.checked || false,
    aiProcessingConfirmed: $('#ai-processing-confirmed')?.checked || false,
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
  const outboundSecret = $('#outbound-webhook-secret')?.value;
  if (outboundSecret) payload.outboundWebhookSecret = outboundSecret;
  return payload;
}

async function saveWorkflow() {
  if (selectedWorkflowType() === 'custom' && !$('#workflow-custom-instructions').value.trim()) {
    setHintMessage('workflow-status', 'Describe what the custom workflow should extract before saving.');
    return;
  }
  const payload = await api('/api/settings', {
    method: 'POST',
    body: JSON.stringify(settingsPayload()),
  });
  setWorkflowSelection(payload.settings.workflowType);
  setHintMessage('workflow-status', `${workflowName(payload.settings.workflowType)} saved for this workspace.`);
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

async function saveConnectorConsent(event) {
  const isTelegram = event.currentTarget.id === 'telegram-consent-confirmed';
  try {
    const payload = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settingsPayload()),
    });
    const confirmed = isTelegram
      ? Boolean(payload.settings.telegramConsentConfirmed)
      : Boolean(payload.settings.consentConfirmed);
    event.currentTarget.checked = confirmed;
    if (isTelegram) {
      setButtonDisabled('load-telegram-messages', !currentTelegramGroupId || !confirmed);
      setHintMessage('telegram-status', confirmed
        ? 'Permission saved. You can now load messages from the selected Telegram group.'
        : 'Permission is required before Telegram messages can be loaded.');
    } else {
      setButtonDisabled('load-whatsapp-messages', !currentApprovedGroupId || !confirmed);
      setHintMessage('settings-status', confirmed
        ? 'Permission saved automatically.'
        : 'Permission is required before WhatsApp messages can be processed.');
    }
  } catch (error) {
    event.currentTarget.checked = !event.currentTarget.checked;
    setHintMessage(isTelegram ? 'telegram-status' : 'settings-status', `Permission could not be saved: ${error.message}`);
  }
}

async function saveTranscriptionLanguage(event) {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(settingsPayload()) });
    const connectorName = event.currentTarget.id.startsWith('telegram') ? 'Telegram' : 'WhatsApp';
    setHintMessage(event.currentTarget.id.startsWith('telegram') ? 'telegram-status' : 'waha-status',
      `${connectorName} voice-note language saved: ${event.currentTarget.selectedOptions?.[0]?.textContent || 'Auto detect'}.`);
  } catch (error) {
    setHintMessage(event.currentTarget.id.startsWith('telegram') ? 'telegram-status' : 'waha-status',
      `Language could not be saved: ${error.message}`);
  }
}

async function importConversationFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Choose a file smaller than 5 MB.');
    const imported = importedConversationText(await file.text(), file.name);
    if (!imported) throw new Error('No readable conversation text was found.');
    const target = $('#chat-text');
    target.value = target.value.trim() ? `${target.value.trim()}\n\n${imported}` : imported;
    const source = $('#input-source')?.selectedOptions?.[0]?.textContent || 'Conversation';
    setHintMessage('import-status', `${source} import loaded from ${file.name}. Review it before generating a report.`);
  } catch (error) {
    setHintMessage('import-status', `Import failed: ${error.message}`);
  } finally {
    event.target.value = '';
  }
}

async function saveIntegration() {
  const payload = await api('/api/settings', { method: 'POST', body: JSON.stringify(settingsPayload()) });
  setHintMessage('integration-status', payload.settings.outboundWebhookEnabled
    ? 'Integration saved and approved-report delivery is enabled.'
    : 'Integration saved. Delivery remains disabled until you enable it.');
  await loadStatus();
}

async function testIntegration() {
  try {
    await saveIntegration();
    const payload = await api('/api/integrations/webhook/test', { method: 'POST', body: '{}' });
    setHintMessage('integration-status', `Test delivered successfully (HTTP ${payload.status}).`);
  } catch (error) {
    setHintMessage('integration-status', `Test failed: ${error.message}`);
  }
}

async function checkWaha() {
  try {
    const payload = await api('/api/waha/status');
    const state = String(payload.status.status || '').toLowerCase();
    const connected = ['working', 'connected', 'authenticated'].includes(state);
    setConnectionStatus('connection-summary-status', 'whatsapp-manage-connection', connected ? 'Connected' : 'Not connected', connected ? 'connected' : 'disconnected');
    setHintMessage('waha-status', `WhatsApp session status: ${payload.status.status || 'reachable'}.`);
    return connected;
  } catch (error) {
    setConnectionStatus('connection-summary-status', 'whatsapp-manage-connection', 'Not connected', 'error');
    setHintMessage('waha-status', `WhatsApp check failed: ${error.message}`);
    return false;
  }
}

async function pollWhatsAppConnection() {
  clearTimeout(whatsappPollTimer);
  if (!whatsappQrVisible) return;
  const connected = await checkWaha();
  if (connected) {
    whatsappQrVisible = false;
    $('#qr-box').hidden = true;
    $('#show-qr').textContent = 'Get QR code';
    $('#show-qr').setAttribute('aria-expanded', 'false');
    return;
  }
  setConnectionStatus('connection-summary-status', 'whatsapp-manage-connection', 'Scan QR to connect', 'pending');
  whatsappPollTimer = setTimeout(pollWhatsAppConnection, 2000);
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
    whatsappQrVisible = false;
    $('#qr-box').hidden = true;
    $('#show-qr').textContent = 'Get QR code';
    $('#show-qr').setAttribute('aria-expanded', 'false');
    currentApprovedGroupId = '';
    currentApprovedGroups = [];
    $('#group-name').value = '';
    $('#group-list').textContent = 'WhatsApp group not loaded yet.';
    $('#qr-box').textContent = 'Session ended. Start the session again, show the QR on the dashboard screen, and let the next person scan from WhatsApp Linked Devices.';
    setHintMessage('waha-status', `WhatsApp session status: ${payload.status.status || 'logged out'}. The next user can now scan a fresh QR from another screen.`);
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settingsPayload({
        approvedGroupId: '',
        approvedGroupName: '',
        approvedGroups: [],
      })),
    });
    await loadStatus();
    setHintMessage('waha-status', `WhatsApp session status: ${payload.status.status || 'logged out'}. The next user can now scan a fresh QR from another screen.`);
  } catch (error) {
    setHintMessage('waha-status', `WhatsApp switch failed: ${error.message}`);
  }
}

async function showQr() {
  const button = $('#show-qr');
  const box = $('#qr-box');
  if (whatsappQrVisible) {
    clearTimeout(whatsappPollTimer);
    whatsappQrVisible = false;
    box.hidden = true;
    button.textContent = 'Get QR code';
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = 'Preparing QR...';
    }
    await saveSettings();
    await api('/api/waha/start', { method: 'POST', body: '{}' });
    let payload = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await new Promise((resolve) => window.setTimeout(resolve, 750));
      try {
        payload = await api('/api/waha/qr');
        if (payload.qr?.data && payload.qr?.mimetype) break;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
    if (!payload?.qr?.data || !payload?.qr?.mimetype) {
      box.hidden = false;
      box.textContent = 'The QR is still being prepared. Please select Get QR code again.';
      return;
    }
    box.hidden = false;
    box.innerHTML = `
      <strong>Open this QR on another screen and scan it with your WhatsApp account.</strong>
      <img alt="WAHA WhatsApp QR code" src="data:${payload.qr.mimetype};base64,${payload.qr.data}" />
    `;
    whatsappQrVisible = true;
    button.setAttribute('aria-expanded', 'true');
    setConnectionStatus('connection-summary-status', 'whatsapp-manage-connection', 'Scan QR to connect', 'pending');
    whatsappPollTimer = setTimeout(pollWhatsAppConnection, 1500);
    setHintMessage('waha-status', 'QR loaded. Scan it now with WhatsApp Linked Devices while the QR stays open.');
  } catch (error) {
    box.hidden = false;
    box.textContent = `QR failed: ${error.message}`;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = whatsappQrVisible ? 'Hide QR code' : 'Get QR code';
    }
  }
}

function showPairingBox() {
  const box = $('#pairing-box');
  box.hidden = !box.hidden;
  if (!box.hidden) $('#pairing-phone')?.focus();
}

async function requestPairingCode() {
  const phoneNumber = $('#pairing-phone').value.trim();
  const result = $('#pairing-result');
  result.hidden = false;
  result.textContent = 'Preparing your secure WhatsApp pairing code…';
  try {
    await saveSettings();
    const payload = await api('/api/waha/pairing-code', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    });
    if (!payload.code) throw new Error('WhatsApp did not return a pairing code. Use the QR fallback instead.');
    result.innerHTML = `
      <span>Your pairing code</span>
      <strong>${escapeHtml(payload.code)}</strong>
      <ol>
        <li>Open WhatsApp on this phone.</li>
        <li>Go to Linked Devices and choose <b>Link with phone number instead</b>.</li>
        <li>Enter the code above, then return to Nzuko AI.</li>
      </ol>`;
    setHintMessage('waha-status', 'Pairing code ready. Complete the three steps shown, then load your WhatsApp groups.');
  } catch (error) {
    result.textContent = `Pairing code unavailable: ${error.message}`;
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
        const approved = currentApprovedGroups.some((entry) => entry.id === group.id);
        const selected = group.id === currentApprovedGroupId;
        return `
        <button
          type="button"
          class="group-option${approved ? ' selected' : ''}"
          data-group-id="${escapeHtml(group.id)}"
          data-group-name="${escapeHtml(group.name)}"
          aria-pressed="${approved ? 'true' : 'false'}"
        >
          <span>
            <strong>${escapeHtml(group.name)}</strong>
            <small>${escapeHtml(group.id)}${group.memberCount ? ` &middot; ${group.memberCount} members` : ''}</small>
          </span>
          <em>${selected ? 'Active' : approved ? 'Added' : 'Add group'}</em>
        </button>
      `;
      })
      .join('');
    setHintMessage('waha-status', `Loaded ${payload.groups.length} WhatsApp group chat(s). Your plan allows ${currentGroupLimit}.`);
  } catch (error) {
    setHintMessage('waha-status', `Group load failed: ${error.message}`);
  }
}

function renderTelegramStatus(payload = {}) {
  clearTimeout(telegramPollTimer);
  $('#telegram-password-box').hidden = !payload.passwordRequired;
  if (payload.connected) {
    telegramQrVisible = false;
    $('#telegram-qr-box').hidden = true;
    $('#start-telegram').textContent = 'Get QR code';
    $('#telegram-phone-box').hidden = true;
    setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', `Connected · ${payload.account?.name || 'Telegram'}`, 'connected');
    $('#telegram-qr-box').innerHTML = `<strong>Connected as ${escapeHtml(payload.account?.name || 'Telegram user')}</strong>`;
    setHintMessage('telegram-status', 'Telegram is connected. Load the groups available to this account.');
    return;
  }
  if (payload.qr) {
    telegramQrVisible = true;
    $('#telegram-qr-box').hidden = false;
    $('#start-telegram').textContent = 'Hide QR code';
    $('#start-telegram').setAttribute('aria-expanded', 'true');
    $('#telegram-phone-box').hidden = true;
    setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', 'Not connected', 'disconnected');
    $('#telegram-qr-box').innerHTML = `<img alt="Telegram login QR code" src="${payload.qr}" /><p>${isMobileDevice() ? 'This QR must be displayed on another screen. On your phone, open Telegram → Settings → Devices → Link Desktop Device, then scan it.' : 'Telegram → Settings → Devices → Link Desktop Device'}</p>`;
    telegramPollTimer = setTimeout(checkTelegramStatus, 2000);
    return;
  }
  if (payload.phoneCodeRequired) {
    setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', 'Enter Telegram code', 'pending');
    $('#telegram-phone-box').hidden = false;
    $('#telegram-phone-stage').hidden = true;
    $('#telegram-code-stage').hidden = false;
    $('#telegram-code')?.focus();
    setHintMessage('telegram-status', `Telegram sent a verification code${payload.phoneNumber ? ` to ${payload.phoneNumber}` : ''}. Enter it here to connect.`);
    return;
  }
  if (payload.passwordRequired) {
    $('#telegram-phone-box').hidden = true;
    setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', 'Password required', 'pending');
    setHintMessage('telegram-status', `Enter your Telegram two-step verification password${payload.passwordHint ? ` (${payload.passwordHint})` : ''}.`);
    telegramPollTimer = setTimeout(checkTelegramStatus, 2500);
    return;
  }
  if (payload.status === 'starting' || payload.status === 'authorising' || payload.status === 'sending_code') {
    setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', 'Connecting…', 'pending');
    telegramPollTimer = setTimeout(checkTelegramStatus, 1500);
    return;
  }
  setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', payload.status === 'error' ? 'Connection failed' : 'Not connected', payload.status === 'error' ? 'error' : 'disconnected');
  telegramQrVisible = false;
  $('#telegram-qr-box').hidden = true;
  $('#start-telegram').textContent = 'Get QR code';
  $('#start-telegram').setAttribute('aria-expanded', 'false');
  if (payload.error) setHintMessage('telegram-status', payload.error);
}

async function checkTelegramStatus() {
  try { renderTelegramStatus(await api('/api/telegram/status')); } catch (error) { setHintMessage('telegram-status', error.message); }
}

async function startTelegram() {
  const box = $('#telegram-qr-box');
  const button = $('#start-telegram');
  if (telegramQrVisible) {
    clearTimeout(telegramPollTimer);
    telegramQrVisible = false;
    box.hidden = true;
    button.textContent = 'Get QR code';
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  try {
    $('#telegram-phone-box').hidden = true;
    setHintMessage('telegram-status', 'Preparing a secure Telegram QR code…');
    renderTelegramStatus(await api('/api/telegram/start', { method: 'POST', body: '{}' }));
  } catch (error) { setHintMessage('telegram-status', error.message); }
}

function showTelegramPhoneBox() {
  const box = $('#telegram-phone-box');
  box.hidden = !box.hidden;
  if (box.hidden) return;
  clearTimeout(telegramPollTimer);
  telegramQrVisible = false;
  $('#telegram-qr-box').hidden = true;
  $('#start-telegram').textContent = 'Get QR code';
  $('#start-telegram').setAttribute('aria-expanded', 'false');
  $('#telegram-phone-stage').hidden = false;
  $('#telegram-code-stage').hidden = true;
  $('#telegram-phone')?.focus();
}

async function requestTelegramCode() {
  const phoneNumber = $('#telegram-phone').value.trim();
  try {
    setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', 'Sending code…', 'pending');
    setHintMessage('telegram-status', 'Asking Telegram to send a secure verification code…');
    renderTelegramStatus(await api('/api/telegram/phone', { method: 'POST', body: JSON.stringify({ phoneNumber }) }));
  } catch (error) {
    setHintMessage('telegram-status', error.message);
    setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', 'Not connected', 'disconnected');
  }
}

async function submitTelegramCode() {
  const code = $('#telegram-code').value.trim();
  try {
    setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', 'Verifying…', 'pending');
    renderTelegramStatus(await api('/api/telegram/code', { method: 'POST', body: JSON.stringify({ code }) }));
    telegramPollTimer = setTimeout(checkTelegramStatus, 1200);
  } catch (error) {
    setHintMessage('telegram-status', error.message);
  }
}

async function submitTelegramPassword() {
  try {
    const password = $('#telegram-password').value;
    if (!password) return setHintMessage('telegram-status', 'Enter your Telegram two-step verification password.');
    $('#telegram-password').value = '';
    renderTelegramStatus(await api('/api/telegram/password', { method: 'POST', body: JSON.stringify({ password }) }));
  } catch (error) { setHintMessage('telegram-status', error.message); }
}

async function loadTelegramGroups() {
  try {
    const payload = await api('/api/telegram/groups');
    if (!payload.groups?.length) {
      $('#telegram-group-list').textContent = 'No Telegram groups were found for this account.';
      return;
    }
    $('#telegram-group-list').innerHTML = payload.groups.map((group) => `
      <button type="button" class="group-option telegram-group-option${group.id === currentTelegramGroupId ? ' selected' : ''}" data-group-id="${escapeHtml(group.id)}" data-group-name="${escapeHtml(group.name)}">
        <span><strong>${escapeHtml(group.name)}</strong><small>${group.unreadCount || 0} unread</small></span>
        <em>${group.id === currentTelegramGroupId ? 'Selected' : 'Choose'}</em>
      </button>`).join('');
    document.querySelectorAll('.telegram-group-option').forEach((button) => button.addEventListener('click', chooseTelegramGroup));
  } catch (error) { setHintMessage('telegram-status', error.message); }
}

async function chooseTelegramGroup(event) {
  currentTelegramGroupId = event.currentTarget.dataset.groupId;
  currentTelegramGroupName = event.currentTarget.dataset.groupName;
  $('#telegram-group-name').value = currentTelegramGroupName;
  await api('/api/settings', { method: 'POST', body: JSON.stringify(settingsPayload()) });
  setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', `Connected · ${currentTelegramGroupName}`, 'connected');
  setButtonDisabled('load-telegram-messages', !$('#telegram-consent-confirmed').checked);
  setHintMessage('telegram-status', `Selected Telegram group: ${currentTelegramGroupName}. Confirm permission below before loading messages.`);
  await loadTelegramGroups();
}

async function loadTelegramMessages(range = {}) {
  try {
    const payload = await api('/api/telegram/pull', { method: 'POST', body: JSON.stringify(range) });
    $('#chat-text').value = payload.chatText || '';
    $('#voice-notes').value = payload.voiceNotes || '';
    $('#input-source').value = 'telegram';
    setHintMessage('telegram-status', `Loaded ${payload.messages?.length || 0} Telegram messages for review.`);
    return payload;
  } catch (error) { setHintMessage('telegram-status', error.message); return false; }
}

async function disconnectTelegram() {
  try {
    clearTimeout(telegramPollTimer);
    telegramQrVisible = false;
    $('#telegram-qr-box').hidden = true;
    $('#start-telegram').textContent = 'Get QR code';
    $('#start-telegram').setAttribute('aria-expanded', 'false');
    await api('/api/telegram/logout', { method: 'POST', body: '{}' });
    currentTelegramGroupId = '';
    currentTelegramGroupName = '';
    $('#telegram-group-name').value = '';
    $('#telegram-phone').value = '';
    $('#telegram-code').value = '';
    $('#telegram-phone-box').hidden = true;
    $('#telegram-consent-confirmed').checked = false;
    setButtonDisabled('load-telegram-messages', true);
    $('#telegram-group-list').textContent = 'Telegram group not loaded yet.';
    $('#telegram-qr-box').textContent = 'Telegram disconnected. Click Get Telegram QR to connect another account.';
    setConnectionStatus('telegram-summary-status', 'telegram-manage-connection', 'Not connected', 'disconnected');
    setHintMessage('telegram-status', 'Telegram has been disconnected from this workspace.');
  } catch (error) { setHintMessage('telegram-status', error.message); }
}

async function chooseGroup(event) {
  const button = event.target.closest('.group-option');
  if (!button) return;

  const alreadyApproved = currentApprovedGroups.some((group) => group.id === button.dataset.groupId);
  if (!alreadyApproved && currentApprovedGroups.length >= currentGroupLimit) {
    setHintMessage('waha-status', `Your plan allows ${currentGroupLimit} WhatsApp group${currentGroupLimit === 1 ? '' : 's'}. Upgrade or remove a group first.`);
    return;
  }
  const approvedGroups = alreadyApproved
    ? currentApprovedGroups
    : [...currentApprovedGroups, { id: button.dataset.groupId, name: button.dataset.groupName }];

  const payload = await api('/api/settings', {
    method: 'POST',
    body: JSON.stringify(settingsPayload({
      approvedGroupId: button.dataset.groupId,
      approvedGroupName: button.dataset.groupName,
      approvedGroups,
    })),
  });
  currentApprovedGroupId = payload.settings.approvedGroupId;
  currentApprovedGroups = payload.settings.approvedGroups || [];
  $('#group-name').value = payload.settings.approvedGroupName;
  setButtonDisabled('load-whatsapp-messages', !payload.settings.consentConfirmed);
  document.querySelectorAll('.group-option').forEach((option) => {
    const approved = currentApprovedGroups.some((group) => group.id === option.dataset.groupId);
    const active = option.dataset.groupId === payload.settings.approvedGroupId;
    option.classList.toggle('selected', approved);
    option.setAttribute('aria-pressed', approved ? 'true' : 'false');
    option.querySelector('em').textContent = active ? 'Active' : approved ? 'Added' : 'Add group';
  });
  collapseGroupList(payload.settings);
  setConnectionStatus(
    'connection-summary-status',
    'whatsapp-manage-connection',
    `Connected · ${currentApprovedGroups.length} group${currentApprovedGroups.length === 1 ? '' : 's'}`,
    'connected'
  );
  setHintMessage('waha-status', `Active report group: ${payload.settings.approvedGroupName}. ${currentApprovedGroups.length} of ${currentGroupLimit} groups connected.`);
}

function collapseGroupList(settings) {
  const groups = Array.isArray(settings.approvedGroups) ? settings.approvedGroups : currentApprovedGroups;
  if (!groups.length) {
    $('#group-list').textContent = 'No approved group selected yet.';
    return;
  }
  $('#group-list').innerHTML = groups.map((group) => `
    <div class="selected-group">
      <span>
        <strong>${escapeHtml(group.name)}${group.id === settings.approvedGroupId ? ' · Active' : ''}</strong>
        <small>${escapeHtml(group.id)}</small>
      </span>
      <button type="button" class="button secondary compact-button remove-approved-group" data-group-id="${escapeHtml(group.id)}">Remove</button>
    </div>
  `).join('') + '<button id="change-group" type="button" class="button secondary">Manage WhatsApp groups</button>';
  $('#change-group').addEventListener('click', loadGroups);
  document.querySelectorAll('.remove-approved-group').forEach((button) => button.addEventListener('click', removeApprovedGroup));
}

async function removeApprovedGroup(event) {
  const groupId = event.currentTarget.dataset.groupId;
  const approvedGroups = currentApprovedGroups.filter((group) => group.id !== groupId);
  const nextActive = approvedGroups.find((group) => group.id === currentApprovedGroupId) || approvedGroups[0] || { id: '', name: '' };
  const payload = await api('/api/settings', {
    method: 'POST',
    body: JSON.stringify(settingsPayload({ approvedGroups, approvedGroupId: nextActive.id, approvedGroupName: nextActive.name })),
  });
  currentApprovedGroups = payload.settings.approvedGroups || [];
  currentApprovedGroupId = payload.settings.approvedGroupId || '';
  $('#group-name').value = payload.settings.approvedGroupName || '';
  setButtonDisabled('load-whatsapp-messages', !currentApprovedGroupId || !payload.settings.consentConfirmed);
  collapseGroupList(payload.settings);
  setConnectionStatus(
    'connection-summary-status',
    'whatsapp-manage-connection',
    currentApprovedGroups.length ? `Connected · ${currentApprovedGroups.length} group${currentApprovedGroups.length === 1 ? '' : 's'}` : 'Not connected',
    currentApprovedGroups.length ? 'connected' : 'disconnected'
  );
  setHintMessage('waha-status', `${currentApprovedGroups.length} of ${currentGroupLimit} WhatsApp groups connected.`);
}

async function pullWahaMessages(range = {}) {
  try {
    await saveSettings();
    const payload = await api('/api/waha/pull', { method: 'POST', body: JSON.stringify({ limit: 1000, ...range }) });
    $('#chat-text').value = payload.chatText;
    $('#voice-notes').value = payload.voiceNotes || '';
    $('#input-source').value = 'whatsapp';
    setHintMessage('waha-status', payload.warning
      ? `${payload.warning}. History is not available from WAHA right now; live capture only shows new messages received after the app is running. Captured now: ${payload.messages.length}.`
      : `Pulled ${payload.messages.length} captured message(s). Voice notes stay marked for review while transcription continues in the background.`);
    return payload;
  } catch (error) {
    setHintMessage('waha-status', `Pull failed: ${error.message}`);
    return false;
  }
}

function setMessagePeriodOpen(isOpen, source = messagePeriodSource) {
  const modal = $('#message-period-modal');
  if (!modal) return;
  if (source) messagePeriodSource = source;
  modal.hidden = !isOpen;
  document.body.classList.toggle('modal-open', isOpen);
  if (!isOpen) return;
  selectedMessagePeriod = window.localStorage.getItem(`nzuko-message-period-${messagePeriodSource}`) || 'today';
  document.querySelectorAll('[data-message-period]').forEach((button) => button.classList.toggle('active', button.dataset.messagePeriod === selectedMessagePeriod));
  $('#message-custom-dates').hidden = selectedMessagePeriod !== 'custom';
  $('#message-period-channel').textContent = `${messagePeriodSource === 'telegram' ? 'Telegram' : 'WhatsApp'} messages`;
  updateMessagePeriodButton();
  setHintMessage('message-period-status', 'Creating the draft uses one report from your allowance. Nothing is approved or shared automatically.');
}

function updateMessagePeriodButton() {
  const labels = { today: 'today', week: 'this week', month: 'this month', custom: 'these dates' };
  $('#confirm-message-period').textContent = `Load ${messagePeriodSource === 'telegram' ? 'Telegram' : 'WhatsApp'} & create draft · ${labels[selectedMessagePeriod]}`;
}

function selectMessagePeriod(event) {
  selectedMessagePeriod = event.currentTarget.dataset.messagePeriod;
  document.querySelectorAll('[data-message-period]').forEach((button) => button.classList.toggle('active', button === event.currentTarget));
  $('#message-custom-dates').hidden = selectedMessagePeriod !== 'custom';
  updateMessagePeriodButton();
}

async function confirmMessagePeriod() {
  const range = { preset: selectedMessagePeriod };
  if (selectedMessagePeriod === 'custom') {
    range.from = $('#message-period-from').value;
    range.to = $('#message-period-to').value;
    if (!range.from || !range.to) return setHintMessage('message-period-status', 'Choose both a start date and an end date.');
    if (range.from > range.to) return setHintMessage('message-period-status', 'The start date must be before the end date.');
  }
  const button = $('#confirm-message-period');
  button.disabled = true;
  button.textContent = 'Loading messages…';
  const loaded = messagePeriodSource === 'telegram' ? await loadTelegramMessages(range) : await pullWahaMessages(range);
  button.disabled = false;
  if (loaded) {
    if (!loaded.messages?.length) {
      updateMessagePeriodButton();
      return setHintMessage('message-period-status', 'No messages were found for this period. Choose another period and try again.');
    }
    window.localStorage.setItem(`nzuko-message-period-${messagePeriodSource}`, selectedMessagePeriod);
    setMessagePeriodOpen(false);
    try {
      await generateRecap();
      location.hash = '#review';
    } catch (error) {
      setHintMessage('import-status', `Messages were loaded, but the draft could not be created: ${error.message}`);
      $('#source-material-review').open = true;
      location.hash = '#review';
    }
  } else {
    updateMessagePeriodButton();
    setHintMessage('message-period-status', 'Messages could not be loaded. Check the connection message and try again.');
  }
}

function clearDraftFields() {
  $('#chat-text').value = '';
  $('#voice-notes').value = '';
  $('#recap-output').textContent = EMPTY_DRAFT_MESSAGE;
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
  setButtonDisabled('approve', false);
  $('#draft-workflow-name').textContent = `${payload.draft.recap.workflowName || workflowName()} draft`;
  $('#approve-status').textContent = 'Draft ready. Review before approving.';
  await loadStatus();
}

async function approveRecap() {
  try {
    const payload = await api('/api/recap/approve', { method: 'POST', body: '{}' });
    $('#approve-status').textContent = `Approved through ${payload.auditEntry.posted.provider || $('#connector-mode').value} at ${payload.auditEntry.approvedAt}.`;
    $('#recap-output').textContent = EMPTY_DRAFT_MESSAGE;
    await Promise.all([loadAudit(), loadActions()]);
    await loadStatus();
  } catch (error) {
    $('#approve-status').textContent = error.message;
  }
}

async function purgeDraft() {
  try {
    const payload = await api('/api/purge', { method: 'POST', body: '{}' });
    clearDraftFields();
    $('#approve-status').textContent = payload.message;
    $('#draft-workflow-name').textContent = `${workflowName()} draft`;
  } catch (error) {
    $('#approve-status').textContent = `Source material could not be cleared: ${error.message}`;
  }
}

async function loadAudit() {
  const payload = await api('/api/audit');
  auditEntriesCache = Array.isArray(payload.auditLog) ? payload.auditLog : [];
  renderAuditFeed();
}

function actionStateLabel(action) {
  if (action.status === 'done') return 'Completed';
  if (action.overdue) return 'Overdue';
  if (action.escalated) return 'Escalated';
  if (action.acknowledgement === 'acknowledged') return 'Acknowledged';
  return 'Awaiting acknowledgement';
}

function renderActions() {
  const list = $('#actions-list');
  const status = $('#actions-status');
  const metrics = $('#action-metrics');
  if (!list || !status || !metrics) return;
  const open = operationalActionsCache.filter((action) => action.status !== 'done');
  const awaiting = open.filter((action) => action.acknowledgement !== 'acknowledged');
  const overdue = open.filter((action) => action.overdue);
  const escalated = open.filter((action) => action.escalated);
  const personal = currentWorkspaceTemplate === 'personal';
  const panel = $('#actions');
  const toolbar = $('#action-toolbar');
  const isEmpty = operationalActionsCache.length === 0;
  panel?.classList.toggle('is-empty', isEmpty);
  if (toolbar) toolbar.hidden = isEmpty;
  const metricItems = [
    [open.length, 'Open'],
    ...(!personal ? [[awaiting.length, 'Awaiting acknowledgement']] : []),
    [overdue.length, 'Overdue'],
    [escalated.length, 'Escalated'],
  ];
  metrics.classList.toggle('personal-metrics', personal);
  metrics.innerHTML = metricItems.map(([count, label]) => `<article><strong>${count}</strong><span>${label}</span></article>`).join('');

  const visible = operationalActionsCache.filter((action) => {
    if (activeActionFilter === 'open') return action.status !== 'done';
    if (activeActionFilter === 'overdue') return action.overdue;
    if (activeActionFilter === 'done') return action.status === 'done';
    return true;
  });
  const modeCopy = actionModeCopy[currentWorkspaceTemplate];
  status.textContent = operationalActionsCache.length
    ? `${open.length} unresolved action${open.length === 1 ? '' : 's'} across approved reports.`
    : `${modeCopy?.empty || 'No official actions yet.'} Approved report actions will appear automatically.`;
  list.hidden = isEmpty;
  list.innerHTML = visible.length ? visible.map((action) => `
    <article class="action-card ${action.overdue ? 'is-overdue' : ''} ${action.escalated ? 'is-escalated' : ''}" data-action-id="${escapeHtml(action.id)}">
      <div class="action-card-topline">
        <span class="action-state">${escapeHtml(actionStateLabel(action))}</span>
        <span class="action-source">${escapeHtml(action.sourceGroupName || 'Approved report')}</span>
      </div>
      <h3>${escapeHtml(action.title)}</h3>
      <div class="action-fields">
        <label>${escapeHtml(modeCopy?.owner || 'Owner')}<input data-action-field="owner" value="${escapeHtml(action.owner || (personal ? 'Me' : ''))}" placeholder="${personal ? 'Me' : 'Assign an owner'}" /></label>
        <label>Due date<input data-action-field="dueDate" type="date" value="${escapeHtml(action.dueDate || '')}" /></label>
      </div>
      <div class="action-card-controls">
        ${!personal && action.acknowledgement !== 'acknowledged' && action.status !== 'done' ? '<button class="button secondary compact-button" type="button" data-action-command="acknowledge">Acknowledge</button>' : ''}
        ${action.status !== 'done' ? '<button class="button compact-button" type="button" data-action-command="complete">Mark complete</button>' : '<button class="button secondary compact-button" type="button" data-action-command="reopen">Reopen</button>'}
        ${action.status !== 'done' ? `<button class="button ${action.escalated ? 'secondary' : 'danger'} compact-button" type="button" data-action-command="${action.escalated ? 'clear-escalation' : 'escalate'}">${action.escalated ? 'Clear escalation' : 'Escalate'}</button>` : ''}
      </div>
    </article>`).join('') : '<div class="actions-empty">Nothing matches this view.</div>';
}

async function loadActions() {
  try {
    const payload = await api('/api/actions');
    operationalActionsCache = Array.isArray(payload.actions) ? payload.actions : [];
    renderActions();
  } catch (error) {
    const status = $('#actions-status');
    if (status) status.textContent = `Actions could not be loaded: ${error.message}`;
  }
}

async function updateAction(actionId, changes) {
  const payload = await api(`/api/actions/${encodeURIComponent(actionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(changes),
  });
  operationalActionsCache = operationalActionsCache.map((action) => action.id === payload.action.id ? payload.action : action);
  renderActions();
}

async function handleActionInteraction(event) {
  const card = event.target.closest('[data-action-id]');
  if (!card) return;
  const actionId = card.dataset.actionId;
  try {
    if (event.target.matches('[data-action-field]') && event.type === 'change') {
      await updateAction(actionId, { [event.target.dataset.actionField]: event.target.value });
      return;
    }
    const command = event.target.closest('[data-action-command]')?.dataset.actionCommand;
    if (!command) return;
    const changes = {
      acknowledge: { acknowledgement: 'acknowledged' },
      complete: { status: 'done' },
      reopen: { status: 'open' },
      escalate: { escalated: true, priority: 'urgent' },
      'clear-escalation': { escalated: false, priority: 'normal' },
    }[command];
    await updateAction(actionId, changes);
  } catch (error) {
    $('#actions-status').textContent = `Action could not be updated: ${error.message}`;
  }
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
    isSuspended: Boolean(entry.trial?.isSuspended),
  }));
  billingEntriesCache = [...pendingEntries, ...userEntries];
  renderBillingFeed();
  recentUsageEventsCache = Array.isArray(payload.recentUsageEvents) ? payload.recentUsageEvents : [];
  renderAdminActivityFeed();

  const summary = payload.summary || {};
  const metrics = [
    ['Users', summary.totalUsers || 0],
    ['Active trials', summary.activeTrials || 0],
    ['Paid', summary.paidUsers || 0],
    ['WhatsApp connected', summary.connectedWorkspaces || 0],
    ['Approved reports', summary.totalRecaps || 0],
  ];
  const metricsNode = $('#admin-metrics');
  if (metricsNode) {
    metricsNode.innerHTML = metrics.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
  }

  const workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
  const workspaceStatus = $('#admin-workspace-status');
  const workspaceList = $('#admin-workspace-list');
  if (workspaceStatus) {
    workspaceStatus.textContent = `${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} · ${summary.totalCapturedMessages || 0} captured message${summary.totalCapturedMessages === 1 ? '' : 's'}.`;
  }
  if (workspaceList) {
    workspaceList.innerHTML = workspaces.length ? `
      <table class="admin-table">
        <thead><tr><th>Workspace</th><th>WhatsApp</th><th>Group</th><th>Reports</th><th>Messages</th><th>Last activity</th></tr></thead>
        <tbody>${workspaces.map((workspace) => `
          <tr>
            <td><strong>${escapeHtml(workspace.name || 'Workspace')}</strong></td>
            <td><span class="health-badge health-${escapeHtml(workspace.connectionStatus || 'not_started')}">${escapeHtml(String(workspace.connectionStatus || 'not started').replaceAll('_', ' '))}</span></td>
            <td>${escapeHtml(workspace.groupName || 'Not selected')}</td>
            <td>${escapeHtml(workspace.approvedRecapCount || 0)}</td>
            <td>${escapeHtml(workspace.capturedCount || 0)}</td>
            <td>${workspace.lastActivityAt ? escapeHtml(formatDateTime(workspace.lastActivityAt)) : 'No activity'}</td>
          </tr>`).join('')}</tbody>
      </table>` : 'No customer workspaces yet.';
  }
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
  } else if (action === 'suspend' || action === 'restore') {
    await api('/api/admin/users/access', {
      method: 'POST',
      body: JSON.stringify({ ...payload, action }),
    });
  } else {
    return;
  }
  await Promise.all([loadStatus(), loadAdminBilling(true)]);
}

$('#save-settings')?.addEventListener('click', saveSettings);
$('#consent-confirmed')?.addEventListener('change', saveConnectorConsent);
$('#telegram-consent-confirmed')?.addEventListener('change', saveConnectorConsent);
$('#ai-processing-confirmed')?.addEventListener('change', async (event) => {
  try {
    const payload = await api('/api/settings', { method: 'POST', body: JSON.stringify(settingsPayload()) });
    event.currentTarget.checked = Boolean(payload.settings.aiProcessingConfirmed);
    setHintMessage('ai-processing-status', event.currentTarget.checked
      ? 'AI reconciliation authorised for this workspace. Every result remains a draft for human review.'
      : 'AI reconciliation is off. Standard local report rules remain available.');
  } catch (error) {
    event.currentTarget.checked = !event.currentTarget.checked;
    setHintMessage('ai-processing-status', `The privacy setting could not be saved: ${error.message}`);
  }
});
$('#whatsapp-transcribe-language')?.addEventListener('change', saveTranscriptionLanguage);
$('#telegram-transcribe-language')?.addEventListener('change', saveTranscriptionLanguage);
$('#save-integration')?.addEventListener('click', saveIntegration);
$('#test-integration')?.addEventListener('click', testIntegration);
$('#save-workflow').addEventListener('click', saveWorkflow);
$('#workflow-type').addEventListener('change', () => setWorkflowSelection(selectedWorkflowType()));
document.querySelectorAll('.purpose-card').forEach((card) => card.addEventListener('click', chooseWorkspaceTemplate));
document.querySelectorAll('[data-landing-mode]').forEach((card) => card.addEventListener('click', () => renderLandingMode(card.dataset.landingMode)));
document.querySelectorAll('[data-mode-discovery]').forEach((button) => button.addEventListener('click', scrollToModeDiscovery));
document.querySelectorAll('[data-source-choice]').forEach((button) => button.addEventListener('click', chooseConversationSource));
$('#try-selected-mode')?.addEventListener('click', startSelectedMode);
$('#source-skip')?.addEventListener('click', showApp);
$('#change-workspace-purpose')?.addEventListener('click', () => setPurposeScreenOpen(true));
$('#purpose-back')?.addEventListener('click', () => setPurposeScreenOpen(false));
$('#check-waha')?.addEventListener('click', checkWaha);
$('#start-waha')?.addEventListener('click', startWaha);
$('#show-qr').addEventListener('click', showQr);
$('#show-pairing')?.addEventListener('click', showPairingBox);
$('#request-pairing-code')?.addEventListener('click', requestPairingCode);
$('#switch-waha-user').addEventListener('click', switchWahaUser);
$('#load-groups').addEventListener('click', loadGroups);
$('#manage-whatsapp-groups')?.addEventListener('click', loadGroups);
$('#group-list').addEventListener('click', chooseGroup);
$('#start-telegram')?.addEventListener('click', startTelegram);
$('#show-telegram-phone')?.addEventListener('click', showTelegramPhoneBox);
$('#request-telegram-code')?.addEventListener('click', requestTelegramCode);
$('#submit-telegram-code')?.addEventListener('click', submitTelegramCode);
$('#load-telegram-groups')?.addEventListener('click', loadTelegramGroups);
$('#submit-telegram-password')?.addEventListener('click', submitTelegramPassword);
$('#load-telegram-messages')?.addEventListener('click', () => setMessagePeriodOpen(true, 'telegram'));
$('#load-whatsapp-messages')?.addEventListener('click', () => setMessagePeriodOpen(true, 'whatsapp'));
$('#disconnect-telegram')?.addEventListener('click', disconnectTelegram);
$('#manage-telegram-groups')?.addEventListener('click', loadTelegramGroups);
$('#configure-webhook').addEventListener('click', configureWebhook);
document.querySelectorAll('[data-message-period]').forEach((button) => button.addEventListener('click', selectMessagePeriod));
$('#confirm-message-period')?.addEventListener('click', confirmMessagePeriod);
$('#close-message-period')?.addEventListener('click', () => setMessagePeriodOpen(false));
$('#message-period-backdrop')?.addEventListener('click', () => setMessagePeriodOpen(false));
$('#approve').addEventListener('click', approveRecap);
$('#purge').addEventListener('click', purgeDraft);
$('#actions-list')?.addEventListener('click', handleActionInteraction);
$('#actions-list')?.addEventListener('change', handleActionInteraction);
document.querySelectorAll('[data-action-filter]').forEach((button) => button.addEventListener('click', () => {
  activeActionFilter = button.dataset.actionFilter;
  document.querySelectorAll('[data-action-filter]').forEach((entry) => entry.classList.toggle('active', entry === button));
  renderActions();
}));
$('#continue-google').addEventListener('click', continueWithGoogle);
$('#sign-in-link').addEventListener('click', continueWithGoogle);
document.querySelectorAll('[data-google-login]').forEach((button) => button.addEventListener('click', continueWithGoogle));
$('#logout')?.addEventListener('click', logout);
$('#back-to-login')?.addEventListener('click', logout);
$('#open-quick-guide')?.addEventListener('click', () => setQuickGuideOpen(true));
$('#close-quick-guide')?.addEventListener('click', () => setQuickGuideOpen(false));
$('#quick-guide-backdrop')?.addEventListener('click', () => setQuickGuideOpen(false));
$('#quick-guide-sample')?.addEventListener('click', runSampleReport);
$('#open-pricing')?.addEventListener('click', openPricing);
$('#login-pricing')?.addEventListener('click', openPricing);
$('#footer-pricing')?.addEventListener('click', openPricing);
$('#open-contact')?.addEventListener('click', () => setContactOpen(true));
$('#close-pricing')?.addEventListener('click', () => setPricingOpen(false));
$('#pricing-backdrop')?.addEventListener('click', () => setPricingOpen(false));
$('#start-free-trial')?.addEventListener('click', startFreeTrial);
$('#close-install-help')?.addEventListener('click', () => setInstallHelpOpen(false));
$('#install-help-backdrop')?.addEventListener('click', () => setInstallHelpOpen(false));
$('#refresh-billing')?.addEventListener('click', () => loadAdminBilling(true));
$('#open-admin')?.addEventListener('click', () => setAdminOpen(true));
$('#close-admin')?.addEventListener('click', () => setAdminOpen(false));
$('#admin-backdrop')?.addEventListener('click', () => setAdminOpen(false));
$('#billing-admin-list')?.addEventListener('click', handleBillingAdminAction);
$('#manage-billing')?.addEventListener('click', openBillingPortal);
$('#install-app')?.addEventListener('click', installApp);
$('#login-install-app')?.addEventListener('click', () => setInstallHelpOpen(true));
$('#footer-install-app')?.addEventListener('click', () => setInstallHelpOpen(true));
$('#install-current-device')?.addEventListener('click', installApp);
$('#close-contact')?.addEventListener('click', () => setContactOpen(false));
$('#contact-backdrop')?.addEventListener('click', () => setContactOpen(false));
$('#contact-form')?.addEventListener('submit', submitContactForm);
$('#pricing-plan-cards')?.addEventListener('click', handlePlanAction);
$('#pricing-topup-cards')?.addEventListener('click', handlePlanAction);
document.querySelectorAll('[data-billing-interval]').forEach((button) => {
  if (!button.classList.contains('billing-interval-option')) return;
  button.addEventListener('click', () => {
    selectedBillingInterval = button.dataset.billingInterval === 'annual' ? 'annual' : 'monthly';
    document.querySelectorAll('.billing-interval-option').forEach((option) => {
      option.classList.toggle('active', option.dataset.billingInterval === selectedBillingInterval);
    });
    renderBillingPlans(latestStatus || {});
  });
});
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
    setAdminOpen(false);
    setQuickGuideOpen(false);
    setPricingOpen(false);
    setInstallHelpOpen(false);
    setContactOpen(false);
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
configureConnectionExperience();
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
      showPilotInterest();
    } else {
      showLogin('Choose a sign-in option to continue.');
    }
  } catch (error) {
    showLogin(error.message || 'Could not complete social sign-in.');
  }
}
