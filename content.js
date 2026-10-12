(function () {
  const DEFAULT_CLICK_SELECTOR = '.btn-buynow, .btn-item a.btn, a.btn-buynow, a.btn-red[href*="booking"], a[href*="/booking/"]';
  const SCRIPT_INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // chrome.storage.session is available in content scripts only from Chrome 112+.
  // Fall back to chrome.storage.local so the bot runs on older versions too.
  const sessionStore = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session)
    ? chrome.storage.session
    : chrome.storage.local;

  let settings = {
    isActive: false,
    targetUrl: '',
    targetDate: '',
    targetTime: '',
    zoneSelector: '',  // comma-separated priority list e.g. "A1, V3, B1"
    seatSelector: '',  // comma-separated row priority list e.g. "AA, A, B"
    excludedZones: '', // comma-separated zones to never select
    excludedSeats: '', // comma-separated seat names or rows to never select
    autoNavigate: true,
    autoClick: true,
    passportCountry: '',
    passportNumber: ''
  };

  const clickedElements = new WeakSet();
  let currentObserver = null;
  let verifyRetryTimer = null;
  let queueRetryTimer = null;
  let seatUnavailableTimer = null;
  let eventRetryTimer = null;
  let zoneClickPending = false;
  let availabilityRefreshPending = false;
  let seatClickPending = false;
  let bookNowClickPending = false;
  let enrollSubmitPending = false;
  let seatObserver = null;
  let lastVerifyClickAt = 0;
  let lastQueueRedirectAt = 0;
  let lastEventNoMatchLogAt = 0;
  let lastZoneClickAt = 0;
  let zoneClickLogs = [];
  let hudRoot = null;
  let hudStatusEl = null;
  let hudPageEl = null;
  let hudLogEl = null;
  let hudZoneLogs = [];
  let cachedAvailabilityRows = null;
  let cachedMapAreas = null;
  let cachedMapZoneCandidates = null;
  const SKIPPED_ZONES_KEY = 'ttmHelperSkippedZones';
  const SKIPPED_ZONE_TTL_MS = 10 * 60 * 1000;
  const LAST_ATTEMPTED_ZONE_KEY = 'ttmHelperLastAttemptedZone';
  const PENDING_ZONE_ATTEMPT_KEY = 'ttmHelperPendingZoneAttempt';
  const ZONE_CLICK_LOGS_KEY = 'ttmHelperZoneClickLogs';
  const LAST_ZONE_CLICK_AT_KEY = 'ttmHelperLastZoneClickAt';
  const EVENT_ACTION_LOCK_KEY = 'ttmHelperEventActionLock';
  const EVENT_DEBUG_LOG_KEY = 'ttmHelperEventDebugLog';
  const MAX_EVENT_DEBUG_ENTRIES = 200;
  const EVENT_ACTION_LOCK_MS = 12000;

  // In-memory booking state — chrome.storage.local is the persistence layer.
  // localStorage/sessionStorage are NOT used for these because TTM's own page
  // JavaScript clears them on page load, wiping the skipped-zone tracking.
  let _skippedZones = []; // [{zone: string, skippedAt: number}] — in-memory cache, persisted to chrome.storage.session
  let _lastAttemptedZone = '';
  let _pendingZoneAttempt = null;
  let _zoneClickLogsHydrated = false;
  let _isNavigatingBack = false; // guard: prevent multiple simultaneous navigateBackToZoneSelection calls

  // Keys managed internally — changes to these must not re-trigger runAutomationCycle.
  const INTERNAL_STORAGE_KEYS = new Set([
    SKIPPED_ZONES_KEY, LAST_ATTEMPTED_ZONE_KEY, PENDING_ZONE_ATTEMPT_KEY,
    ZONE_CLICK_LOGS_KEY, LAST_ZONE_CLICK_AT_KEY
  ]);
  const MAX_AVAILABILITY_WAIT_MS = 2500;
  const AVAILABILITY_WAIT_POLL_MS = 100;
  const ZONE_CLICK_VERIFY_MS = 250;
  const ZONE_SEAT_MAP_WAIT_MS = 2500;
  const SEAT_MAP_LOAD_TIMEOUT_MS = 3000;
  const ENABLE_CONSOLE_LOGS = true;
  const STEP_DELAY_MS = {
    event: 0,
    selectPerformance: 0,
    verify: 0,
    enroll: 0,
    round: 0,
    availability: 0,
    zone: 0,
    seat: 0,
    bookNow: 0
  };

  function debugLog(message, data) {
    const entry = {
      at: new Date().toISOString(),
      page: window.location.href,
      message,
      data: data === undefined ? null : data
    };

    if (ENABLE_CONSOLE_LOGS) {
      console.log('[TTM Helper]', message, data || '');
    }

    return entry;
  }

  function appendZoneClickLog(zoneName, status = 'clicked', details = {}) {
    hydrateZoneLogsFromStorage();
    const now = Date.now();
    const deltaMs = lastZoneClickAt > 0 ? now - lastZoneClickAt : null;
    lastZoneClickAt = now;

    zoneClickLogs.push({
      at: new Date(now).toISOString(),
      zone: zoneName || 'unknown',
      status,
      sincePrevMs: deltaMs,
      scriptInstanceId: SCRIPT_INSTANCE_ID,
      ...getZoneTraceContext(),
      ...details
    });
    if (zoneClickLogs.length > 500) {
      zoneClickLogs = zoneClickLogs.slice(-500);
    }
    persistZoneLogsToStorage();
    persistZoneLogsToChromeStorage();
  }

  function getZoneTraceContext() {
    return {
      url: window.location.href,
      pageType: getHudPageLabel(),
      readyState: document.readyState
    };
  }

  function getElementDebugInfo(el) {
    if (!el) return null;

    return {
      tag: el.tagName,
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className : '',
      text: (el.textContent || '').trim().slice(0, 120),
      href: el.getAttribute('href') || '',
      title: el.getAttribute('title') || ''
    };
  }

  // Load settings and booking state together so automation never runs
  // with a stale (or missing) skipped-zone list.
  chrome.storage.local.get(
    [
      'isActive', 'targetUrl', 'targetDate', 'targetTime',
      'zoneSelector', 'seatSelector', 'excludedZones', 'excludedSeats',
      'autoNavigate', 'autoClick', 'fullname', 'passportCountry', 'passportNumber',
      LAST_ATTEMPTED_ZONE_KEY, PENDING_ZONE_ATTEMPT_KEY,
      ZONE_CLICK_LOGS_KEY, LAST_ZONE_CLICK_AT_KEY
    ],
    (result) => {
      _lastAttemptedZone = normalizeZoneName(result[LAST_ATTEMPTED_ZONE_KEY] || '').toUpperCase();
      const pa = result[PENDING_ZONE_ATTEMPT_KEY];
      if (pa && pa.zone && pa.startedAt) {
        const zone = normalizeZoneName(pa.zone);
        const startedAt = Number(pa.startedAt) || 0;
        _pendingZoneAttempt = (zone && startedAt) ? { zone, startedAt } : null;
      }
      if (Array.isArray(result[ZONE_CLICK_LOGS_KEY])) {
        zoneClickLogs = result[ZONE_CLICK_LOGS_KEY];
      }
      lastZoneClickAt = Number(result[LAST_ZONE_CLICK_AT_KEY]) || 0;
      _zoneClickLogsHydrated = true;

      // Load skipped zones from session storage last — automation must not start
      // until _skippedZones is hydrated, otherwise bot ignores previously skipped zones.
      sessionStore.get([SKIPPED_ZONES_KEY], (sessionResult) => {
        if (Array.isArray(sessionResult[SKIPPED_ZONES_KEY])) {
          const now = Date.now();
          _skippedZones = sessionResult[SKIPPED_ZONES_KEY]
            .filter(e => e && e.zone && (now - (e.skippedAt || 0)) < SKIPPED_ZONE_TTL_MS)
            .map(e => ({ zone: normalizeZoneName(e.zone), skippedAt: e.skippedAt }))
            .filter(e => e.zone);
        }
        updateSettings(result);
      });
    }
  );

  // Monitor storage changes — skip internal keys so booking state writes
  // (markZoneSkipped, persistPendingZoneAttempt, etc.) don't trigger
  // runAutomationCycle as a side-effect.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      const newSettings = {};
      for (let key in changes) {
        if (!INTERNAL_STORAGE_KEYS.has(key)) {
          newSettings[key] = changes[key].newValue;
        }
      }
      if (Object.keys(newSettings).length === 0) return;
      updateSettings(newSettings);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'downloadLogs') return;
    downloadZoneLogsWhenReady().then(sendResponse);
    return true;
  });

  hydrateZoneLogsFromStorage();
  // Remove any legacy skipped-zones entry left in local storage — state now lives in session storage.
  chrome.storage.local.remove([SKIPPED_ZONES_KEY]);

  function updateSettings(newSettings) {
    for (let key in newSettings) {
      if (newSettings[key] === undefined) delete newSettings[key];
    }
    settings = { ...settings, ...newSettings };
    const debugInfo = getSettingsDebugInfo();
    debugLog('Settings updated', debugInfo);
    appendEventDebugLog({ at: new Date().toISOString(), event: 'settings-updated', url: window.location.href, settings: debugInfo });
    updateHud();

    if (settings.isActive) {
      if (handleQueuePage()) return;
      runNavigationLogic();
      runAutomationCycle();
    }
  }

  function getSettingsDebugInfo() {
    return {
      isActive: settings.isActive,
      targetUrl: settings.targetUrl,
      targetDate: settings.targetDate,
      targetTime: settings.targetTime,
      zoneSelector: settings.zoneSelector,
      seatSelector: settings.seatSelector,
      excludedZones: settings.excludedZones,
      excludedSeats: settings.excludedSeats,
      autoNavigate: settings.autoNavigate,
      autoClick: settings.autoClick
    };
  }

  function ensureHud() {
    if (hudRoot?.isConnected) return hudRoot;
    if (!document.documentElement) return null;

    hudRoot = document.createElement('div');
    hudRoot.id = 'ttm-helper-hud';
    hudRoot.style.cssText = [
      'position:fixed',
      'top:12px',
      'right:12px',
      'z-index:2147483647',
      'min-width:220px',
      'max-width:320px',
      'padding:10px 12px',
      'border-radius:12px',
      'background:rgba(11,12,22,0.92)',
      'border:1px solid rgba(255,255,255,0.12)',
      'box-shadow:0 10px 30px rgba(0,0,0,0.28)',
      'backdrop-filter:blur(12px)',
      'color:#ffffff',
      'font:12px/1.4 Outfit, Arial, sans-serif'
    ].join(';');

    const titleEl = document.createElement('div');
    titleEl.textContent = 'TTM Helper';
    titleEl.style.cssText = 'font-weight:700;font-size:12px;letter-spacing:0.2px;margin-bottom:8px;';

    hudStatusEl = document.createElement('div');
    hudPageEl = document.createElement('div');
    hudLogEl = document.createElement('div');

    [hudStatusEl, hudPageEl, hudLogEl].forEach(el => {
      el.style.cssText = 'margin-top:4px;color:#c7c9de;word-break:break-word;';
    });
    hudStatusEl.style.marginTop = '0';

    hudRoot.appendChild(titleEl);
    hudRoot.appendChild(hudStatusEl);
    hudRoot.appendChild(hudPageEl);
    hudRoot.appendChild(hudLogEl);

    (document.body || document.documentElement).appendChild(hudRoot);
    return hudRoot;
  }

  function updateHud() {
    const hud = ensureHud();
    if (!hud || !hudStatusEl || !hudPageEl || !hudLogEl) return;

    hud.style.display = 'block';
    hudStatusEl.innerHTML = `Status: <strong style="color:${settings.isActive ? '#10b981' : '#ef4444'}">${settings.isActive ? 'Active' : 'Inactive'}</strong>`;
    hudPageEl.textContent = `Page: ${getHudPageLabel()}`;
    hudLogEl.innerHTML = hudZoneLogs.length > 0
      ? `Zone log:<br>${hudZoneLogs.map(item => `- ${item}`).join('<br>')}`
      : 'Zone log: None';
  }

  function getHudPageLabel() {
    if (isSeatPage()) return 'Seat Selection';
    if (isPaymentPage()) return 'Payment';
    if (isZoneSelectionPage()) return 'Zone Selection';
    if (isVerifyConditionPage()) return 'Verification';
    if (isEnrollPage()) return 'Enroll';
    if (isQueueUrl(window.location.href)) return 'Queue';
    return 'Event / Other';
  }

  function setHudZoneLog(zoneName, status = 'clicked') {
    if (zoneName) {
      hudZoneLogs.unshift(`${zoneName} (${status})`);
      hudZoneLogs = hudZoneLogs.slice(0, 5);
    }
    updateHud();
  }

  // ==================== NAVIGATION ====================
  function runNavigationLogic() {
    if (!settings.isActive || !settings.autoNavigate || !settings.targetUrl) return;

    try {
      const currentUrl = window.location.href;
      const targetUrl = settings.targetUrl.trim();
      if (!targetUrl) return;
      if (isQueueUrl(currentUrl)) return;

      const cleanUrl = (urlStr) => {
        try {
          const url = new URL(urlStr);
          return (url.hostname + url.pathname + url.search).replace(/\/+$/, '');
        } catch (e) {
          return urlStr.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/+$/, '');
        }
      };

      if (cleanUrl(currentUrl) !== cleanUrl(targetUrl)) {
        const onBookingSubdomain = currentUrl.includes('booking.thaiticketmajor.com');
        if (!onBookingSubdomain) {
          debugLog('Navigating to target URL', targetUrl);
          window.location.href = targetUrl;
        } else {
          // On booking subdomain: only navigate away if we're on the wrong event's zones page.
          const targetQuery = getTargetEventQuery();
          if (targetQuery && currentUrl.includes('zones.php')) {
            try {
              const curQuery = new URL(currentUrl).searchParams.get('query');
              if (curQuery && curQuery !== targetQuery) {
                debugLog('On wrong event zones page, navigating to target URL', { curQuery, targetQuery, targetUrl });
                window.location.href = targetUrl;
              }
            } catch (e) { /* ignore */ }
          }
        }
      }
    } catch (err) {
      console.error('[TTM Helper] Navigation error:', err);
    }
  }

  // ==================== QUEUE / GATEKEEPER ====================
  function isQueueUrl(urlStr) {
    try {
      const url = new URL(urlStr);
      return (
        url.hostname === 'wait.thaiticketmajor.com' ||
        url.hostname === 'gatekeeper.thaiticketmajor.com'
      );
    } catch (err) {
      return urlStr.includes('wait.thaiticketmajor.com') || urlStr.includes('gatekeeper.thaiticketmajor.com');
    }
  }

  function handleQueuePage() {
    if (!isQueueUrl(window.location.href)) return false;

    const tryConfirmRedirectDialog = () => {
      const modal = document.getElementById('divConfirmRedirectModal');
      if (!modal) return false;

      const modalStyle = getComputedStyle(modal);
      const isShowing = modal.style.display !== 'none' &&
        !modal.hidden &&
        modalStyle.display !== 'none' &&
        modalStyle.visibility !== 'hidden';
      if (!isShowing) return false;

      const btn = document.getElementById('buttonConfirmRedirect');
      if (!btn) return false;

      debugLog('Queue confirm redirect dialog detected. Auto-clicking Yes');
      btn.click();
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      runInPageContext(`
        const btn = document.getElementById('buttonConfirmRedirect');
        if (btn) btn.click();
      `);
      return true;
    };

    const tryQueueRedirect = () => {
      tryConfirmRedirectDialog();

      const queueTargetUrl = getQueueReadyTargetUrl();
      if (!queueTargetUrl || Date.now() - lastQueueRedirectAt < 1500) return;

      lastQueueRedirectAt = Date.now();
      debugLog('Queue is ready. Redirecting', queueTargetUrl);
      window.location.href = queueTargetUrl;
    };

    tryQueueRedirect();

    const confirmObserver = new MutationObserver(() => {
      if (!settings.isActive) { confirmObserver.disconnect(); return; }
      tryConfirmRedirectDialog();
    });
    confirmObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden']
    });

    if (!queueRetryTimer) {
      queueRetryTimer = setInterval(() => {
        if (!settings.isActive || !isQueueUrl(window.location.href)) {
          clearInterval(queueRetryTimer);
          queueRetryTimer = null;
          confirmObserver.disconnect();
          return;
        }
        tryQueueRedirect();
      }, 1000);
    }

    return true;
  }

  function getQueueReadyTargetUrl() {
    const pageText = document.documentElement ? document.documentElement.textContent : '';
    const pageHtml = document.documentElement ? document.documentElement.innerHTML : '';
    const source = `${pageText}\n${pageHtml}`;

    const isReady = /"isClientReadyToRedirect"\s*:\s*true/i.test(source) ||
      /"isClientRedayToRedirect"\s*:\s*true/i.test(source);
    if (!isReady) return '';

    const targetMatch = source.match(/"targetUrl"\s*:\s*"([^"]+)"/i);
    if (!targetMatch || !targetMatch[1]) return '';

    return targetMatch[1]
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .trim();
  }

  // ==================== AUTOMATION CYCLE ====================
  function runAutomationCycle() {
    if (!settings.isActive) return;
    updateHud();

    const url = window.location.href;
    if (handleQueuePage()) return;
    if (handlePendingZoneAttemptTimeout()) return;

    if (url.includes('booking.thaiticketmajor.com')) {
      // On booking subdomain
      if (isVerifyPage()) {
        handleVerifyPage();
      } else if (isVerifyConditionPage()) {
        handleVerifyCondition();
      } else if (isEnrollPage()) {
        handleEnrollPage();
      } else if (url.includes('seat') || url.includes('fixed.php')) {
        handleSeatSelection();
      } else if (isPaymentPage()) {
        handlePaymentPage();
      } else if (url.includes('zones.php') || document.querySelector('.map-zone') || document.getElementById('rdId')) {
        autoDetectAndStoreZones();
        handleBookingRoundAndZone();
      }
    } else {
      if (!hasActiveBookingAttempt()) clearSkippedZones();
      // On main event details page
      if (settings.autoClick) {
        if (isTooFrequentVerificationPage()) {
          debugLog('Automation paused on verification/rate-limit page');
          stopEventPageClicker();
          return;
        }
        runEventPageClicker();
      }
    }
  }

  // ==================== PASSPORT VERIFY PAGE (verify.php) ====================
  function isVerifyPage() {
    return (
      window.location.href.includes('verify.php') &&
      Boolean(document.querySelector('.verify-method-btn[data-method="passport"]'))
    );
  }

  let verifyPageHandled = false;
  let verifyPageHandledUrl = '';

  function handleVerifyPage() {
    if (!settings.isActive || !settings.passportNumber) return;
    if (verifyPageHandled && verifyPageHandledUrl === window.location.href) return;

    const tryVerifyPage = () => {
      const passportBtn = document.querySelector('.verify-method-btn[data-method="passport"]');
      if (!passportBtn) return false;

      if (!passportBtn.classList.contains('active')) {
        debugLog('Verify page: clicking Passport method button');
        passportBtn.click();
        passportBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        setTimeout(tryVerifyPage, 300);
        return true;
      }

      if (settings.passportCountry) {
        const countryHidden = document.getElementById('passport_country');
        const countryInput = document.getElementById('passport_country_input');
        if (countryHidden && !countryHidden.value) {
          const targetName = settings.passportCountry.trim().toLowerCase();
          const option = [...document.querySelectorAll('#passport_country_dropdown .verify-country-option')]
            .find(el => el.getAttribute('data-name')?.toLowerCase() === targetName ||
                        el.textContent.trim().toLowerCase() === targetName);
          if (option) {
            countryHidden.value = option.getAttribute('data-code') || '';
            fillInput(countryInput, option.getAttribute('data-name') || option.textContent.trim());
            option.click();
            debugLog('Verify page: selected passport country', settings.passportCountry);
          }
        }
      }

      const passportInput = document.getElementById('txt_verifycode');
      if (!passportInput) return false;
      if (passportInput.value !== settings.passportNumber) {
        fillInput(passportInput, settings.passportNumber);
        debugLog('Verify page: filled passport number');
      }

      const submitBtn = document.getElementById('btnconfirm');
      if (!submitBtn || submitBtn.disabled) return false;

      verifyPageHandled = true;
      verifyPageHandledUrl = window.location.href;
      debugLog('Verify page: submitting form');
      submitBtn.click();
      submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    };

    if (!tryVerifyPage()) {
      const observer = new MutationObserver(() => {
        if (tryVerifyPage()) observer.disconnect();
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }
  }

  // ==================== PHASE 1.5: VERIFY CONDITIONS ====================
  function isVerifyConditionPage() {
    return (
      window.location.href.includes('verify_condition.php') ||
      Boolean(document.getElementById('rdagree') && document.getElementById('btn_verify'))
    );
  }

  function handleVerifyCondition() {
    if (verifyRetryTimer) return;

    const tryVerify = () => {
      const agreeCheckbox = document.getElementById('rdagree');
      const buyButton = document.getElementById('btn_verify');

      if (!agreeCheckbox || !buyButton) return false;
      if (buyButton.hasAttribute('disabled') || buyButton.classList.contains('disabled')) return false;

      if (!agreeCheckbox.checked) {
        dispatchClickSequence(agreeCheckbox);
        if (!agreeCheckbox.checked) agreeCheckbox.checked = true;
        agreeCheckbox.dispatchEvent(new Event('input', { bubbles: true }));
        agreeCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        debugLog('Accepted terms and conditions');
      }

      if (Date.now() - lastVerifyClickAt > 1000) {
        lastVerifyClickAt = Date.now();
        debugLog('Scheduling verify Buy Ticket click', { delayMs: STEP_DELAY_MS.verify });
        scheduleDelayedClick('verify', STEP_DELAY_MS.verify, () => clickVerifyButton(buyButton));
        return true;
      }

      return false;
    };

    if (currentObserver) {
      currentObserver.disconnect();
      currentObserver = null;
    }

    currentObserver = new MutationObserver(() => {
      tryVerify();
    });
    currentObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'disabled']
    });

    tryVerify();
    verifyRetryTimer = setInterval(() => {
      if (!settings.isActive || !isVerifyConditionPage()) {
        clearInterval(verifyRetryTimer);
        verifyRetryTimer = null;
        if (currentObserver) {
          currentObserver.disconnect();
          currentObserver = null;
        }
        return;
      }
      tryVerify();
    }, 800);
  }

  function clickVerifyButton(buyButton) {
    if (!buyButton || !document.contains(buyButton)) return;

    buyButton.scrollIntoView({ block: 'center', inline: 'center' });
    dispatchPointerClickSequence(buyButton);
    if (typeof buyButton.click === 'function') buyButton.click();
    runInPageContext(`
      const btn = document.getElementById('btn_verify');
      if (btn) {
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach((type) => {
          btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        });
        btn.click();
      }
    `);
  }

  function runInPageContext(code) {
    const script = document.createElement('script');
    script.textContent = `(() => { ${code} })();`;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
  }

  // ==================== PHASE 2.5: ENROLL PAGE (ENTER DETAILS) ====================
  function isEnrollPage() {
    return window.location.href.includes('enroll.php') && Boolean(document.getElementById('btn_regnow'));
  }

  function fillInput(el, value) {
    if (!el) return;
    el.focus();
    // Use native setter so jQuery/vanilla validation listeners fire correctly
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function handleEnrollPage() {
    if (!settings.isActive || !settings.autoClick) return;
    if (!settings.fullname) return;
    if (enrollSubmitPending) return;

    const tryFillAndSubmit = () => {
      const saveBtn = document.getElementById('btn_regnow');
      if (!saveBtn || saveBtn.disabled || saveBtn.classList.contains('disabled')) return false;

      const isSplitName = document.getElementById('isSplitName')?.value === '1';
      if (isSplitName) {
        const parts = settings.fullname.trim().split(/\s+/);
        fillInput(document.getElementById('txt_firstname_0'), parts[0] || '');
        fillInput(document.getElementById('txt_lastname_0'), parts.slice(1).join(' ') || '');
      } else {
        fillInput(document.getElementById('txt_fullname_0'), settings.fullname.trim());
      }

      enrollSubmitPending = true;
      scheduleDelayedClick('enroll-save', STEP_DELAY_MS.enroll, () => {
        enrollSubmitPending = false;
        if (!isEnrollPage()) return;
        const btn = document.getElementById('btn_regnow');
        if (!btn) return;
        btn.scrollIntoView({ block: 'center', inline: 'center' });
        btn.click();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        debugLog('Enroll form submitted', { fullname: settings.fullname });
      });
      return true;
    };

    if (!tryFillAndSubmit()) {
      const observer = new MutationObserver(() => {
        if (tryFillAndSubmit()) observer.disconnect();
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
  }

  // ==================== PHASE 1: EVENT PAGE (SELECT PERFORMANCE) ====================
  let eventObserver = null;
  function stopEventPageClicker() {
    if (eventObserver) {
      eventObserver.disconnect();
      eventObserver = null;
    }
    if (eventRetryTimer) {
      clearInterval(eventRetryTimer);
      eventRetryTimer = null;
    }
  }

  function runEventPageClicker() {
    if (eventObserver) eventObserver.disconnect();
    debugLog('Event page clicker started', {
      readyState: document.readyState,
      targetDate: settings.targetDate,
      targetTime: settings.targetTime
    });
    scheduleDelayedClick('event-initial', STEP_DELAY_MS.event, clickMatchingRounds);

    eventObserver = new MutationObserver(() => {
      if (!settings.isActive || !settings.autoClick) {
        stopEventPageClicker();
        return;
      }
      scheduleDelayedClick('event-observer', STEP_DELAY_MS.event, clickMatchingRounds);
    });
    eventObserver.observe(document.documentElement, { childList: true, subtree: true });

    if (eventRetryTimer) clearInterval(eventRetryTimer);
    eventRetryTimer = setInterval(() => {
      if (!settings.isActive || !settings.autoClick || window.location.hostname !== 'www.thaiticketmajor.com') {
        clearInterval(eventRetryTimer);
        eventRetryTimer = null;
        return;
      }
      scheduleDelayedClick('event-interval', STEP_DELAY_MS.event, clickMatchingRounds);
    }, 1500);
  }

  function clickMatchingRounds() {
    if (!settings.isActive || !settings.autoClick) return;
    if (isTooFrequentVerificationPage()) {
      debugLog('Automation paused on verification/rate-limit page');
      stopEventPageClicker();
      return false;
    }

    try {
      if (clickPerformanceRoundOnDetailPage()) return true;

      const elements = document.querySelectorAll(DEFAULT_CLICK_SELECTOR);
      let visibleCandidates = 0;
      for (const el of elements) {
        if (clickedElements.has(el) || !isVisible(el) ||
            el.hasAttribute('disabled') || el.classList.contains('disabled')) {
          continue;
        }
        visibleCandidates += 1;

        if (settings.targetDate) {
          const dateText = getContainerDateText(el);
          if (!matchNormalizedDate(dateText, settings.targetDate)) continue;
        }

        if (settings.targetTime) {
          const elText = el.textContent.toLowerCase();
          const timeClean = settings.targetTime.trim().toLowerCase();
          const parentText = el.parentElement ? el.parentElement.textContent.toLowerCase() : '';
          if (!elText.includes(timeClean) && !parentText.includes(timeClean)) continue;
        }

        clickedElements.add(el);
        if (!acquireEventActionLock('event-button', el)) return true;
        debugLog('Scheduling event button click', {
          delayMs: STEP_DELAY_MS.event,
          element: getElementDebugInfo(el)
        });
        scheduleDelayedClick('event-button', STEP_DELAY_MS.event, () => {
          debugLog('Clicking event button', getElementDebugInfo(el));
          activateEventElement(el);
        });
        stopEventPageClicker();
        return true;
      }

      logEventNoMatch(visibleCandidates);
      clickSelectPerformanceButtonIfUseful();
      return false;
    } catch (err) {
      console.error('[TTM Helper] Event page click error:', err);
      debugLog('Event page click error', err.message || String(err));
      return false;
    }
  }

  function clickPerformanceRoundOnDetailPage() {
    const roundButtons = document.querySelectorAll(
      '.box-list-round a, .box-list-round button, ' +
      '.showtime a, .showtime button, ' +
      '.seating-plan a, .seating-plan button, ' +
      '.seatplan a, .seatplan button, ' +
      '.show-date a, .show-date button, ' +
      '.event-detail a, .event-detail button, ' +
      'table a, table button, ' +
      '.btn-red[href*="booking"], a[href*="booking/3m"], button[onclick*="booking"], ' +
      'a[href*="booking"], button'
    );

    let visibleCandidates = 0;
    for (const el of roundButtons) {
      if (clickedElements.has(el) || !isVisible(el) ||
          el.hasAttribute('disabled') || el.classList.contains('disabled')) {
        continue;
      }
      visibleCandidates += 1;

      const container = el.closest('tr, li, .row, .round, .box, .item, .content, .card, .showdate, .show-date, .seating-plan, .seatplan') || el.parentElement || el;
      const contextText = container.textContent || el.textContent || '';
      const text = (el.textContent || '').trim();

      if (!isAllowedRoundActionCandidate(el, contextText)) continue;

      if (settings.targetDate && !matchNormalizedDate(contextText, settings.targetDate)) continue;
      if (settings.targetTime && !contextText.toLowerCase().includes(settings.targetTime.trim().toLowerCase())) continue;

      if (!settings.targetDate && !settings.targetTime && !isLikelyRoundButton(el)) continue;

      clickedElements.add(el);
      if (!acquireEventActionLock('performance-round', el)) return true;
      debugLog('Scheduling performance round click', {
        delayMs: STEP_DELAY_MS.event,
        element: getElementDebugInfo(el),
        text,
        contextText: contextText.trim().slice(0, 240)
      });
      scheduleDelayedClick('performance-round', STEP_DELAY_MS.event, () => {
        debugLog('Clicking performance round', {
          element: getElementDebugInfo(el),
          text,
          contextText: contextText.trim().slice(0, 240)
        });
        activateEventElement(el);
      });
      stopEventPageClicker();
      return true;
    }

    logEventNoMatch(visibleCandidates);
    return false;
  }

  function isLikelyRoundButton(el) {
    const text = (el.textContent || '').trim();
    return /\b\d{1,2}:\d{2}\b/.test(text) || /book|buy|select/i.test(text);
  }

  function isAllowedRoundActionCandidate(el, contextText) {
    const text = (el.textContent || '').trim();
    const href = el.getAttribute('href') || '';
    const onclick = el.getAttribute('onclick') || '';
    const className = typeof el.className === 'string' ? el.className : '';
    const hasTimeText = /\b\d{1,2}:\d{2}\b/.test(text);
    const hasActionText = /book|buy|select|performance/i.test(text);
    const hasBookingTarget = /\/booking\/|booking\.thaiticketmajor\.com|booking/i.test(href) || /booking|buy|round|performance/i.test(onclick);
    const hasActionClass = /btn|button|round|showtime|performance/i.test(className);

    if (el.tagName === 'BUTTON') {
      return hasTimeText || hasActionText || hasBookingTarget || hasActionClass;
    }

    if (el.tagName === 'A') {
      if (hasBookingTarget) return true;
      if ((hasTimeText || hasActionText) && hasActionClass) return true;
      return false;
    }

    return false;
  }

  function clickSelectPerformanceButtonIfUseful() {
    const btn = [...document.querySelectorAll('a, button')]
      .find(el => isVisible(el) && !clickedElements.has(el) && /select\s+performance/i.test(el.textContent || ''));
    if (!btn) return false;

    clickedElements.add(btn);
    if (!acquireEventActionLock('select-performance', btn, 3000)) return true;
    debugLog('Scheduling Select Performance button click', {
      delayMs: STEP_DELAY_MS.selectPerformance,
      element: getElementDebugInfo(btn)
    });
    scheduleDelayedClick('select-performance', STEP_DELAY_MS.selectPerformance, () => {
      debugLog('Clicking Select Performance button', getElementDebugInfo(btn));
      activateEventElement(btn);
    });
    return true;
  }

  function acquireEventActionLock(action, el, lockMs = EVENT_ACTION_LOCK_MS) {
    const now = Date.now();
    const fingerprint = [
      action,
      window.location.pathname,
      settings.targetDate || '',
      settings.targetTime || '',
      getElementDebugInfo(el)?.text || '',
      getElementDebugInfo(el)?.href || ''
    ].join('|');

    try {
      const lock = JSON.parse(localStorage.getItem(EVENT_ACTION_LOCK_KEY) || '{}');
      if (lock.expiresAt && lock.expiresAt > now && lock.fingerprint === fingerprint) {
        debugLog('Skipped duplicate event action', {
          action,
          expiresInMs: lock.expiresAt - now,
          element: getElementDebugInfo(el)
        });
        return false;
      }

      localStorage.setItem(EVENT_ACTION_LOCK_KEY, JSON.stringify({
        fingerprint,
        action,
        at: now,
        expiresAt: now + lockMs
      }));
    } catch (err) {
      debugLog('Event action lock unavailable', err.message || String(err));
    }

    return true;
  }

  function activateEventElement(el) {
    const href = el.getAttribute('href');
    if (el.tagName === 'A' && href && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')) {
      const nextUrl = new URL(href, window.location.href).href;
      if (!isAllowedEventNavigationUrl(nextUrl)) {
        debugLog('Blocked non-booking event navigation', {
          nextUrl,
          element: getElementDebugInfo(el)
        });
        return;
      }
      debugLog('Navigating in current tab for event action', nextUrl);
      window.location.href = nextUrl;
      return;
    }

    if (el.tagName === 'A' && el.getAttribute('target')) {
      el.removeAttribute('target');
    }

    el.click();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  function isAllowedEventNavigationUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return (
        parsed.hostname === 'booking.thaiticketmajor.com' ||
        parsed.pathname.includes('/booking/') ||
        parsed.pathname.includes('/concert/')
      );
    } catch (err) {
      return false;
    }
  }

  function appendEventDebugLog(entry) {
    sessionStore.get([EVENT_DEBUG_LOG_KEY], (result) => {
      const log = Array.isArray(result[EVENT_DEBUG_LOG_KEY]) ? result[EVENT_DEBUG_LOG_KEY] : [];
      log.push(entry);
      if (log.length > MAX_EVENT_DEBUG_ENTRIES) log.splice(0, log.length - MAX_EVENT_DEBUG_ENTRIES);
      sessionStore.set({ [EVENT_DEBUG_LOG_KEY]: log });
    });
  }

  function logEventNoMatch(visibleCandidates) {
    if (Date.now() - lastEventNoMatchLogAt < 2500) return;
    lastEventNoMatchLogAt = Date.now();

    const candidates = [...document.querySelectorAll('a, button')]
      .filter(el => isVisible(el))
      .slice(0, 20)
      .map(el => ({
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 60),
        href: (el.getAttribute('href') || '').slice(0, 80),
        class: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
        onclick: (el.getAttribute('onclick') || '').slice(0, 60)
      }));

    const entry = {
      at: new Date().toISOString(),
      url: window.location.href,
      readyState: document.readyState,
      visibleCandidates,
      targetDate: settings.targetDate,
      targetTime: settings.targetTime,
      elements: candidates
    };
    appendEventDebugLog(entry);
    debugLog('No matching event round/button found yet', entry);
  }

  function isTooFrequentVerificationPage() {
    const text = (document.body?.innerText || '').toLowerCase();
    return text.includes('verification required') &&
      (text.includes('too frequent') || text.includes('verification code'));
  }

  // ==================== PHASE 2: BOOKING PAGE (ROUND DROPDOWN + ZONE MAP) ====================
  function autoDetectAndStoreZones() {
    const zones = detectZonesFromPage();
    if (zones.length === 0) return;

    chrome.storage.local.get(['scannedZones'], (result) => {
      const currentZones = Array.isArray(result.scannedZones) ? result.scannedZones : [];
      const currentKey = currentZones.map(zone => zone.toLowerCase()).sort().join('|');
      const nextKey = zones.map(zone => zone.toLowerCase()).sort().join('|');
      if (currentKey === nextKey) return;

      debugLog('Auto-detected zones', zones);
      chrome.storage.local.set({ scannedZones: zones });
    });
  }

  function detectZonesFromPage() {
    const zoneMap = new Map();

    const addZone = (zoneName) => {
      const zone = getCanonicalZoneName(zoneName);
      if (!isLikelyZoneName(zone)) return;

      const key = zone.toLowerCase();
      if (!zoneMap.has(key)) zoneMap.set(key, zone);
    };

    const addZoneFromHref = (href) => {
      const matches = (href || '').match(/#([^#\s]+)/g) || [];
      if (matches.length === 0) return;
      addZone(matches[matches.length - 1].replace(/^#/, ''));
    };

    getCachedMapAreas().forEach(el => {
      addZoneFromHref(el.getAttribute('href'));
      addZone(el.getAttribute('data-zone'));
      addZone(el.getAttribute('data-zone-id'));
      addZone(el.getAttribute('data-zone-label'));
    });

    getCachedAvailabilityRows().forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) return;

      const seatsAvailable = parseInt((cells[1].textContent || '').replace(/[^\d]/g, ''), 10);
      if (Number.isNaN(seatsAvailable) || seatsAvailable <= 0) return;

      const onclick = row.getAttribute('onclick') || '';
      const onclickMatch = onclick.match(/gonextstep\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/i);
      addZone(onclickMatch?.[1] || cells[0].querySelector('a[id]')?.id || cells[0].textContent);
    });

    return [...zoneMap.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  function getCanonicalZoneName(zoneName) {
    const rawZone = String(zoneName || '').replace(/^#/, '').trim();
    if (!rawZone) return '';

    const normalizedRaw = rawZone.toUpperCase();
    const ignoredTokens = new Set(['ZONE', 'SEAT', 'ROW', 'AREA', 'PRICE', 'TOTAL']);
    if (normalizedRaw === 'VIP') return 'VIP';
    if (/^[A-Z]{1,4}\d{1,3}$/.test(normalizedRaw)) return normalizedRaw;
    if (/^[A-Z]{1,2}$/.test(normalizedRaw)) return normalizedRaw;

    const tokens = normalizedRaw.match(/[A-Z]{1,4}\d{0,3}/g) || [];
    const preferredToken = tokens.find(token => token === 'VIP' || /\d/.test(token));
    if (preferredToken && !ignoredTokens.has(preferredToken)) return preferredToken;

    const fallbackToken = tokens.find(token => /^[A-Z]{1,2}$/.test(token) && !ignoredTokens.has(token));
    if (fallbackToken) return fallbackToken;

    return '';
  }

  function isLikelyZoneName(zoneName) {
    const zone = getCanonicalZoneName(zoneName);
    return zone === 'VIP' || /^[A-Z]{1,4}\d{1,3}$/.test(zone) || /^[A-Z]{1,2}$/.test(zone);
  }

  function handleBookingRoundAndZone() {
    // 2a. Auto-select round dropdown
    if (autoSelectRoundDropdown()) return;

    // 2b. Refresh Seats Available, then auto-click priority zone or fallback zone.
    refreshAvailabilityThenSelectZone();
  }

  function refreshAvailabilityThenSelectZone() {
    if (zoneClickPending || availabilityRefreshPending) return;
    availabilityRefreshPending = true;

    debugLog('Refreshing Seats Available before selecting zone');
    openAndReloadAvailability();

    const refreshStartedAt = Date.now();
    setTimeout(() => selectZoneAfterAvailabilityRefresh(refreshStartedAt), 0);
  }

  function selectZoneAfterAvailabilityRefresh(refreshStartedAt) {
    if (zoneClickPending) {
      availabilityRefreshPending = false;
      return;
    }

    if (hasAvailabilityTable()) {
      availabilityRefreshPending = false;
      logZoneAvailabilitySnapshot();
      autoClickZoneWithFallback();
      return;
    }

    const elapsedMs = Date.now() - refreshStartedAt;
    if (elapsedMs < MAX_AVAILABILITY_WAIT_MS) {
      debugLog('Seats Available table not ready yet. Retrying availability wait', {
        elapsedMs,
        maxWaitMs: MAX_AVAILABILITY_WAIT_MS
      });
      setTimeout(() => selectZoneAfterAvailabilityRefresh(refreshStartedAt), AVAILABILITY_WAIT_POLL_MS);
      return;
    }

    availabilityRefreshPending = false;
    logZoneAvailabilitySnapshot();
    autoClickZoneWithFallback({ allowMapFallback: true });
  }

  function openAndReloadAvailability() {
    invalidateZoneDomCache();
    // Only open the popup if the availability table is not already showing.
    // Clicking a toggle-style popup button when it is already open would close
    // it and make getCachedAvailabilityRows() work on stale hidden rows.
    if (!hasAvailabilityTable()) {
      const popupButton = document.getElementById('popup-avail');
      if (popupButton && isVisible(popupButton)) {
        dispatchClickSequence(popupButton);
      }
    }

    runInPageContext(`
      try {
        if (typeof window.reloadAvailable === 'function') {
          window.reloadAvailable();
        } else {
          const reloadLink = document.querySelector('a[href*="reloadAvailable"]');
          if (reloadLink) reloadLink.click();
        }
      } catch (err) {}
    `);
  }

  function autoSelectRoundDropdown() {
    const rdSelect = document.getElementById('rdId');
    if (!rdSelect || rdSelect.tagName.toLowerCase() !== 'select') return false;

    for (let i = 0; i < rdSelect.options.length; i++) {
      const opt = rdSelect.options[i];
      const optText = opt.text;
      if (!opt.value || /select\s*round/i.test(optText)) continue;

      let dateOk = !settings.targetDate || matchNormalizedDate(optText, settings.targetDate);
      let timeOk = !settings.targetTime || optText.toLowerCase().includes(settings.targetTime.trim().toLowerCase());

      if (dateOk && timeOk) {
        if (rdSelect.value !== opt.value) {
          debugLog('Auto-selecting round', optText);
          scheduleDelayedClick('round-select', STEP_DELAY_MS.round, () => {
            rdSelect.value = opt.value;
            rdSelect.dispatchEvent(new Event('change'));
            if (typeof window.round_change === 'function') window.round_change();
          });
          return true;
        }
        return false;
      }
    }

    return false;
  }

  function autoClickZoneWithFallback(options = {}) {
    const allowMapFallback = Boolean(options.allowMapFallback);

    if (zoneClickPending) {
      debugLog('Zone click already pending. Skipping zone scan');
      return;
    }

    if (!hasAvailabilityTable() && !allowMapFallback) {
      debugLog('Seats Available table not ready yet. Waiting before zone selection');
      observeZoneArea(() => {
        invalidateZoneDomCache();
        if (!hasAvailabilityTable() || zoneClickPending) return;
        currentObserver.disconnect();
        currentObserver = null;
        logZoneAvailabilitySnapshot();
        autoClickZoneWithFallback();
      }, { allowMapFallback });
      return;
    }

    if (!hasAvailabilityTable() && allowMapFallback) {
      debugLog('Seats Available table unavailable after refresh. Falling back to map zones');
    }

    const zonePriorities = settings.zoneSelector
      .split(',')
      .map(z => z.trim())
      .filter(Boolean);
    const excludedZones = getExcludedZoneSet();

    debugLog('Zone priority list', {
      zonePriorities,
      excludedZones: [...excludedZones]
    });
    logZoneAvailabilitySnapshot();

    const tryZones = () => {
      const skippedZones = getSkippedZones();
      const pendingAttempt = getPendingZoneAttempt();
      appendZoneClickLog('scan-state', 'zone-scan-state', {
        nextAction: 'try-zone-priorities',
        zonePriorities,
        skippedZones,
        excludedZones: [...excludedZones],
        pendingAttempt,
        lastAttemptedZone: getLastAttemptedZone(),
        allowMapFallback,
        hasAvailabilityTable: hasAvailabilityTable(),
        zoneClickPending,
        availabilityRefreshPending
      });

      for (const zoneName of zonePriorities) {
        const normalizedZone = normalizeZoneName(zoneName);
        if (excludedZones.has(normalizedZone)) {
          debugLog('Zone is excluded by user. Skipping', zoneName);
          continue;
        }

        if (skippedZones.includes(normalizedZone)) {
          debugLog('Zone was already tried without seats. Skipping', zoneName);
          continue;
        }

        // Safety net: if skippedZones storage failed, the pending attempt is a backup indicator
        // that this zone was already clicked and navigated to (but found no seats).
        if (pendingAttempt && pendingAttempt.zone === normalizedZone) {
          debugLog('Zone has stale pending attempt on zone page. Marking as skipped.', zoneName);
          markZoneSkipped(zoneName);
          clearPendingZoneAttempt();
          appendZoneClickLog(zoneName, 'pending-attempt-zone-page-skip', { nextAction: 'try-next-priority' });
          continue;
        }

        if (hasAvailabilityTable()) {
          const availablePriorityZone = getAvailableZoneFromAvailabilityTable(zoneName);
          if (availablePriorityZone) {
            clickZoneElement(availablePriorityZone.el, availablePriorityZone.name);
            debugLog('Zone selected', zoneName);
            return true;
          }

          appendZoneClickLog(zoneName, 'priority-not-available', { nextAction: 'try-next-priority' });
          debugLog('Priority zone is not available after refresh. Trying next', zoneName);
          continue;
        }

        if (allowMapFallback) {
          const clickResult = tryClickZone(zoneName);
          if (clickResult === 'clicked') {
            debugLog('Priority zone selected from map fallback', zoneName);
            return true;
          }

          debugLog('Priority zone not selectable from map fallback. Trying next', {
            zoneName,
            clickResult
          });
          appendZoneClickLog(zoneName, 'priority-map-fallback-miss', {
            nextAction: 'try-next-priority',
            clickResult
          });
        }
      }

      const fallbackZone = findFirstAvailableZone(
        [...zonePriorities, ...skippedZones, ...excludedZones],
        allowMapFallback
      );
      if (fallbackZone) {
        appendZoneClickLog(fallbackZone.name, 'fallback-zone-selected', { nextAction: 'click-fallback-zone' });
        clickZoneElement(fallbackZone.el, fallbackZone.name);
        debugLog('Priority zones unavailable. Fallback zone selected', fallbackZone.name);
        return true;
      }

      return false;
    };

    if (currentObserver) {
      currentObserver.disconnect();
      currentObserver = null;
    }

    if (!tryZones()) {
      observeZoneArea(() => {
        invalidateZoneDomCache();
        if (tryZones()) {
          currentObserver.disconnect();
          currentObserver = null;
        }
      }, { allowMapFallback: true });
    }
  }

  function getAvailableZoneFromAvailabilityTable(zoneName) {
    const normalizedTarget = normalizeZoneName(zoneName);
    if (!normalizedTarget) return null;
    return getAvailableZonesFromAvailabilityTable([...getSkippedZones(), ...getExcludedZoneSet()])
      .find(item => normalizeZoneName(item.name) === normalizedTarget) || null;
  }

  /**
   * Try to click a specific zone by name.
   * @returns {'clicked'|'sold-out'|'available-not-clicked'|'not-found'}
   */
  function tryClickZone(zoneName) {
    const zoneClean = normalizeZoneName(zoneName);

    // 1. Prefer the Seats Available table when it exists because it carries availability state.
    const availabilityRows = getCachedAvailabilityRows();
    for (let el of availabilityRows) {
      const candidateName = getZoneNameFromElement(el);
      if (normalizeZoneName(candidateName) === zoneClean) {
        if (isZoneSoldOut(el, zoneName)) return 'sold-out';
        if (zoneClickPending) return 'available-not-clicked';

        clickZoneElement(el, zoneName);
        return 'clicked';
      }
    }

    // 2. Search <area> elements (image map zones)
    const areas = getCachedMapAreas();
    for (let el of areas) {
      const candidateName = getZoneNameFromElement(el);
      if (normalizeZoneName(candidateName) === zoneClean) {
        // Check if the area (or its parent) indicates sold-out
        if (isZoneSoldOut(el, zoneName)) return 'sold-out';
        if (zoneClickPending) return 'available-not-clicked';

        clickZoneElement(el, zoneName);
        return 'clicked';
      }
    }

    // 3. Search zone buttons/links with data-zone or text matching
    const candidates = getCachedMapZoneCandidates();
    for (let el of candidates) {
      const candidateName = getZoneNameFromElement(el);
      if (normalizeZoneName(candidateName) === zoneClean) {
        if (isZoneSoldOut(el, zoneName)) return 'sold-out';
        if (!isVisible(el)) return 'available-not-clicked';
        if (zoneClickPending) return 'available-not-clicked';

        clickZoneElement(el, zoneName);
        return 'clicked';
      }
    }

    return 'not-found';
  }

  function findFirstAvailableZone(excludedZones, allowMapFallback = false) {
    const excluded = excludedZones.map(normalizeZoneName);
    const availabilityZones = getAvailableZonesFromAvailabilityTable(excluded);
    if (availabilityZones.length > 0) return availabilityZones[0];
    if (hasAvailabilityTable() || !allowMapFallback) return null;

    const candidates = [
      ...getCachedMapAreas(),
      ...getCachedMapZoneCandidates()
    ];
    const seen = new Set();

    for (const el of candidates) {
      const zoneName = getZoneNameFromElement(el);
      const normalized = normalizeZoneName(zoneName);

      if (!normalized || !isLikelyZoneName(zoneName) || excluded.includes(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);

      if (isZoneSoldOut(el, zoneName)) continue;
      if (el.tagName.toLowerCase() !== 'area' && !isVisible(el)) continue;
      if (clickedElements.has(el)) continue;

      return { el, name: zoneName };
    }

    return null;
  }

  function getAvailableZonesFromAvailabilityTable(excludedZones) {
    const excluded = excludedZones.map(normalizeZoneName);
    const availableZones = [];
    const seen = new Set();

    for (const el of getCachedAvailabilityRows()) {
      const zoneName = getZoneNameFromElement(el);
      const normalized = normalizeZoneName(zoneName);
      if (!normalized || !isLikelyZoneName(zoneName) || excluded.includes(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);

      const seatsAvailable = getZoneAvailableSeatCount(el);
      if (seatsAvailable <= 0) continue;
      if (clickedElements.has(el)) continue;

      availableZones.push({ el, name: zoneName, seatsAvailable });
    }

    return availableZones;
  }

  function hasAvailabilityTable() {
    return getCachedAvailabilityRows().length > 0;
  }

  function getZoneAvailableSeatCount(el) {
    const row = el.closest('tr') || el;
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) return -1;

    const seatsText = cells[1].textContent || '';
    const seatsAvailable = parseInt(seatsText.replace(/[^\d]/g, ''), 10);
    return Number.isNaN(seatsAvailable) ? -1 : seatsAvailable;
  }

  function logZoneAvailabilitySnapshot() {
    if (!hasAvailabilityTable()) {
      debugLog('Zone availability table not present. Falling back to map zones');
      return;
    }

    const skippedZones = getSkippedZones();
    const rows = getCachedAvailabilityRows()
      .map(row => ({
        zone: getZoneNameFromElement(row),
        seatsAvailable: getZoneAvailableSeatCount(row)
      }))
      .filter(item => isLikelyZoneName(item.zone));

    const available = rows.filter(item => item.seatsAvailable > 0);
    const availableAfterSkipped = available.filter(item => !skippedZones.includes(normalizeZoneName(item.zone)));

    debugLog('Zone availability snapshot', {
      availableCount: available.length,
      availableAfterSkippedCount: availableAfterSkipped.length,
      skippedZones,
      availableZones: availableAfterSkipped.slice(0, 20)
    });
  }

  function findLiveZoneElement(zoneName) {
    const zoneClean = normalizeZoneName(zoneName);
    const allCandidates = [
      ...document.querySelectorAll('#avail_data table tbody tr, #popup-event-zone table tbody tr'),
      ...document.querySelectorAll('.map-zone area[href], .select-zone area[href], map area[href], area'),
    ];
    for (const candidate of allCandidates) {
      if (normalizeZoneName(getZoneNameFromElement(candidate)) === zoneClean) return candidate;
    }
    return null;
  }

  function clickZoneElement(el, zoneName) {
    if (zoneClickPending) return;
    zoneClickPending = true;
    persistLastAttemptedZone(zoneName);
    persistPendingZoneAttempt(zoneName);
    markZoneSkipped(zoneName);
    invalidateZoneDomCache();
    appendZoneClickLog(zoneName, 'clicked', { nextAction: 'verify-zone-click-result' });
    appendZoneClickLog(zoneName, 'marked-skipped-on-attempt', { nextAction: 'prevent-zone-retry-loop' });
    setHudZoneLog(zoneName, 'clicked');
    debugLog('Scheduling zone click', { zoneName, delayMs: STEP_DELAY_MS.zone });
    scheduleDelayedClick(`zone-${normalizeZoneName(zoneName)}`, STEP_DELAY_MS.zone, () => {
      debugLog('Clicking zone', zoneName);
      // Re-query the element before clicking in case the availability AJAX
      // refreshed the DOM between when the element was captured and now,
      // which would have detached `el` making the click ineffective.
      const liveEl = document.contains(el) ? el : findLiveZoneElement(zoneName) || el;
      liveEl.click();
      liveEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      appendZoneClickLog(zoneName, 'post-click-dispatched');
      setTimeout(() => verifyZoneClickResult(zoneName), ZONE_CLICK_VERIFY_MS);
    });
  }

  function verifyZoneClickResult(zoneName, verifyStartedAt = Date.now()) {
    if (!settings.isActive) {
      zoneClickPending = false;
      appendZoneClickLog(zoneName, 'post-click-inactive');
      return;
    }

    if (hasSeatPageEvidence()) {
      zoneClickPending = false;
      clearPendingZoneAttempt();
      appendZoneClickLog(zoneName, 'post-click-seat-page');
      return;
    }

    const isSeatTransitionUrl = window.location.href.includes('seat') || window.location.href.includes('fixed.php');
    const elapsedMs = Date.now() - verifyStartedAt;
    if (isSeatTransitionUrl && elapsedMs < ZONE_SEAT_MAP_WAIT_MS) {
      appendZoneClickLog(zoneName, 'post-click-wait-seat-map', {
        nextAction: 'wait-seat-map',
        elapsedMs
      });
      setTimeout(() => verifyZoneClickResult(zoneName, verifyStartedAt), AVAILABILITY_WAIT_POLL_MS);
      return;
    }

    if (!isZoneSelectionPage()) {
      zoneClickPending = false;
      appendZoneClickLog(zoneName, 'post-click-other-page');
      return;
    }

    zoneClickPending = false;
    markZoneSkipped(zoneName);
    clearPendingZoneAttempt();
    appendZoneClickLog(zoneName, 'post-click-still-zone-page', {
      nextAction: 'skip-and-try-next'
    });
    appendZoneClickLog(zoneName, 'retry-next');
    setHudZoneLog(zoneName, 'retry-next');
    debugLog('Zone click did not leave zone page. Skipping zone and trying next', zoneName);
    autoClickZoneWithFallback({ allowMapFallback: true });
  }

  function downloadZoneLogsFile() {
    try {
      hydrateZoneLogsFromStorage();
      const lines = [
        'TTM Helper Zone Log',
        `generated_at=${new Date().toISOString()}`,
        `page=${window.location.href}`,
        `entries=${zoneClickLogs.length}`,
        ''
      ];

      if (zoneClickLogs.length === 0) {
        return { ok: false, error: 'empty-log', logCount: 0 };
      }

      zoneClickLogs.forEach((entry, index) => {
        lines.push(
          `${index + 1}. at=${entry.at} | zone=${entry.zone} | status=${entry.status} | since_prev_ms=${entry.sincePrevMs === null ? 'first-click' : entry.sincePrevMs} | script_instance=${entry.scriptInstanceId || ''} | page_type=${entry.pageType || ''} | ready_state=${entry.readyState || ''} | next_action=${entry.nextAction || ''} | click_result=${entry.clickResult || ''} | url=${entry.url || ''} | details=${formatZoneLogDetails(entry)}`
        );
      });

      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = objectUrl;
      link.download = `ttm-helper-zone-log-${timestamp}.log`;
      link.style.display = 'none';
      (document.body || document.documentElement).appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

      return { ok: true, entries: lines.length, logCount: zoneClickLogs.length };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  async function downloadZoneLogsWhenReady() {
    const delayMs = getZoneLogExportDelayMs();
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      handlePendingZoneAttemptTimeout();
    }

    return downloadZoneLogsFile();
  }

  function getZoneLogExportDelayMs() {
    const pendingAttempt = getPendingZoneAttempt();
    if (!pendingAttempt || !isSeatTransitionPage() || hasSeatPageEvidence()) return 0;

    const elapsedMs = Date.now() - pendingAttempt.startedAt;
    const targetMs = SEAT_MAP_LOAD_TIMEOUT_MS + AVAILABILITY_WAIT_POLL_MS;
    return Math.max(targetMs - elapsedMs, 0);
  }

  function formatZoneLogDetails(entry) {
    const hiddenKeys = new Set([
      'at',
      'zone',
      'status',
      'sincePrevMs',
      'scriptInstanceId',
      'url',
      'pageType',
      'readyState',
      'nextAction',
      'clickResult'
    ]);
    const details = {};
    Object.keys(entry || {}).forEach(key => {
      if (!hiddenKeys.has(key)) details[key] = entry[key];
    });
    return Object.keys(details).length > 0 ? JSON.stringify(details) : '';
  }

  function hydrateZoneLogsFromStorage() {
    // Zone logs are now loaded from chrome.storage.local in the initial get
    // callback (alongside settings). Nothing to do here unless that async load
    // has not yet completed — in which case we start with an empty log and
    // merge with storage once the callback fires.
  }

  function persistZoneLogsToStorage() {
    // Zone logs are persisted via persistZoneLogsToChromeStorage() only.
    // localStorage/sessionStorage writes were removed because TTM's page JS
    // clears them on navigation, causing log history to be lost.
  }

  function clearZoneLogsStorage() {
    try {
      sessionStorage.removeItem(ZONE_CLICK_LOGS_KEY);
      localStorage.removeItem(ZONE_CLICK_LOGS_KEY);
      sessionStorage.removeItem(LAST_ZONE_CLICK_AT_KEY);
      localStorage.removeItem(LAST_ZONE_CLICK_AT_KEY);
    } catch (err) {
      // Ignore storage cleanup failures.
    }
    chrome.storage.local.remove([ZONE_CLICK_LOGS_KEY, LAST_ZONE_CLICK_AT_KEY]);
  }

  function persistZoneLogsToChromeStorage() {
    chrome.storage.local.set({
      [ZONE_CLICK_LOGS_KEY]: zoneClickLogs.slice(-500),
      [LAST_ZONE_CLICK_AT_KEY]: lastZoneClickAt || 0
    });
  }

  let paymentPageHandled = false;

  function handlePaymentPage() {
    if (paymentPageHandled) return;
    paymentPageHandled = true;

    // Defer to let TTM's jQuery finish binding handlers after DOM ready.
    setTimeout(applyPaymentPageActions, 800);
  }

  function applyPaymentPageActions() {
    // Uncheck Ticket Protect — has inline onclick="getTicketProtected(this)", native click works.
    const ticketProtectCheckbox = findTicketProtectCheckbox();
    if (ticketProtectCheckbox && ticketProtectCheckbox.checked) {
      ticketProtectCheckbox.click();
      debugLog('Payment: unchecked Ticket Protect', { id: ticketProtectCheckbox.id });
    }

    // Click "Pick up the ticket(s) by yourself" if not already the active selection.
    // TTM's jQuery handler checks data-auto on the parent tab — remove the guard first.
    const pickupBtn = document.getElementById('btn_pickup');
    if (pickupBtn) {
      const li = pickupBtn.closest('li');
      if (!li || !li.classList.contains('active')) {
        const tabDelivery = document.getElementById('tab-delivery');
        if (tabDelivery) tabDelivery.setAttribute('data-auto', 'true');
        pickupBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        debugLog('Payment: clicked btn_pickup');
      }
    }
  }

  function findTicketProtectCheckbox() {
    // Known IDs used by TTM: ticket-protect-mobile, ticket-protect-desktop, etc.
    const byId = document.querySelector(
      'input[type="checkbox"][id*="ticket-protect"], input[type="checkbox"][id*="ticket_protect"]'
    );
    if (byId) return byId;

    // Known name: check-protect
    const byName = document.querySelector('input[type="checkbox"][name="check-protect"]');
    if (byName) return byName;

    // Fallback: find via label text containing "Ticket Protect".
    for (const label of document.querySelectorAll('label')) {
      if (/ticket\s*protect/i.test(label.textContent)) {
        const forId = label.getAttribute('for');
        if (forId) {
          const el = document.getElementById(forId);
          if (el && el.type === 'checkbox') return el;
        }
        const el = label.querySelector('input[type="checkbox"]');
        if (el) return el;
      }
    }
    return null;
  }

  function isPaymentPage() {
    // Detect by known IDs first.
    if (document.getElementById('btn_pickup')) return true;
    if (document.getElementById('tab-delivery')) return true;
    if (document.getElementById('btn_thaipost')) return true;

    // Fallback: detect by "Pick up" + "by post" text blocks coexisting on page.
    const bodyText = document.body?.textContent || '';
    if (/pick\s*up.*ticket/i.test(bodyText) && /delivery.*ticket.*post/i.test(bodyText)) return true;

    return false;
  }

  function isZoneSelectionPage() {
    const url = window.location.href;
    if (isPaymentPage()) return false;
    return url.includes('zones.php') ||
      Boolean(document.querySelector('.map-zone, .select-zone, map area')) ||
      Boolean(document.getElementById('rdId')) ||
      hasAvailabilityTable();
  }

  function invalidateZoneDomCache() {
    cachedAvailabilityRows = null;
    cachedMapAreas = null;
    cachedMapZoneCandidates = null;
  }

  function getCachedAvailabilityRows() {
    if (cachedAvailabilityRows) return cachedAvailabilityRows;
    cachedAvailabilityRows = [
      ...document.querySelectorAll('#avail_data table tbody tr, #popup-event-zone table tbody tr')
    ];
    return cachedAvailabilityRows;
  }

  function getCachedMapAreas() {
    if (cachedMapAreas) return cachedMapAreas;
    cachedMapAreas = [
      ...document.querySelectorAll('.map-zone area[href], .select-zone area[href], map area[href], area')
    ];
    return cachedMapAreas;
  }

  function getCachedMapZoneCandidates() {
    if (cachedMapZoneCandidates) return cachedMapZoneCandidates;
    const candidateSelector = [
      'a[href*="#"]',
      'a[onclick*="selectzone"]',
      'button[data-zone]',
      '.zone-item',
      '[data-zone]',
      '[data-zone-id]',
      '[data-zone-label]',
      '[alt]',
      '[title]'
    ].join(', ');
    const roots = [
      ...document.querySelectorAll('.map-zone, .select-zone, map, .zone-wrapper, .zone-container')
    ];

    const candidates = [];
    const seen = new WeakSet();
    const addCandidatesFromRoot = (root) => {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      if (root.matches?.(candidateSelector) && !seen.has(root)) {
        seen.add(root);
        candidates.push(root);
      }
      root.querySelectorAll(candidateSelector).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        candidates.push(el);
      });
    };

    roots.forEach(addCandidatesFromRoot);

    // If TTM renders without a known wrapper, keep a narrow document-level fallback.
    if (candidates.length === 0) {
      document.querySelectorAll('a[href*="#"], a[onclick*="selectzone"], button[data-zone], [data-zone], [data-zone-id], [data-zone-label]')
        .forEach(el => {
          if (seen.has(el)) return;
          seen.add(el);
          candidates.push(el);
        });
    }

    cachedMapZoneCandidates = candidates;
    return cachedMapZoneCandidates;
  }

  function getZoneObservationRoot(allowMapFallback = false) {
    const availabilityRoot = document.querySelector('#avail_data, #popup-event-zone');
    if (availabilityRoot) return availabilityRoot;
    if (allowMapFallback) {
      return document.querySelector('.map-zone, .select-zone, map') || document.body || document.documentElement;
    }
    return document.querySelector('.booking-content, .zone-wrapper, .zone-container') || document.body || document.documentElement;
  }

  function observeZoneArea(callback, options = {}) {
    const allowMapFallback = Boolean(options.allowMapFallback);
    if (currentObserver) currentObserver.disconnect();
    currentObserver = new MutationObserver(callback);
    currentObserver.observe(getZoneObservationRoot(allowMapFallback), { childList: true, subtree: true });
  }

  function getZoneNameFromElement(el) {
    if (!el) return '';

    const onclick = el.getAttribute('onclick') || '';
    const gonextMatch = onclick.match(/gonextstep\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/i);
    if (gonextMatch && gonextMatch[1]) {
      return gonextMatch[1].trim();
    }

    const href = el.getAttribute('href') || '';
    const hrefMatch = href.match(/#([^#\s]+)$/);
    if (hrefMatch && hrefMatch[1] && !hrefMatch[1].includes('.php')) {
      return hrefMatch[1].trim();
    }

    return (
      el.getAttribute('data-zone') ||
      el.getAttribute('data-zone-id') ||
      el.getAttribute('data-zone-label') ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.textContent ||
      ''
    ).trim();
  }

  function normalizeZoneName(zoneName) {
    return getCanonicalZoneName(zoneName).toLowerCase();
  }

  /**
   * Check if a zone element indicates sold-out status.
   */
  function isZoneSoldOut(el, zoneName) {
    const row = el.closest('tr');
    if (row && row.querySelectorAll('td').length >= 2) {
      const seatsAvailable = getZoneAvailableSeatCount(row);
      if (seatsAvailable >= 0) return seatsAvailable <= 0;
    }

    // Check the element and nearby siblings/parent for "sold out", "หมด", "not available"
    const searchText = (el.closest('.zone-item, .zone-container, td, div') || el.parentElement || el)
      .textContent.toLowerCase();
    
    const soldOutKeywords = ['sold out', 'sold-out', 'soldout', 'หมด', 'ไม่มี', 'not available', 'unavailable'];
    for (const keyword of soldOutKeywords) {
      if (searchText.includes(keyword)) return true;
    }

    // Check for greyed-out or disabled visual state
    const style = window.getComputedStyle(el);
    if (parseFloat(style.opacity) < 0.3) return true;
    if (el.hasAttribute('disabled') || el.classList.contains('disabled') || el.classList.contains('sold-out')) return true;

    return false;
  }

  // ==================== PHASE 3: SEAT SELECTION ====================
  function handleSeatSelection() {
    if (seatClickPending) {
      debugLog('Seat click already pending. Skipping seat scan');
      return;
    }

    const currentZone = getCurrentZoneName();
    if (isZoneExcluded(currentZone)) {
      markZoneSkipped(currentZone);
      debugLog('Current zone is excluded by user. Returning to zone selection', currentZone);
      navigateBackToZoneSelection();
      return;
    }

    const seatPriorities = settings.seatSelector
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const excludedSeatRules = getExcludedSeatRules();

    debugLog('Seat row priority list', {
      seatPriorities,
      excludedExactSeats: [...excludedSeatRules.exactSeats],
      excludedRows: [...excludedSeatRules.rows]
    });

    const trySeats = () => {
      for (const seatPriority of seatPriorities) {
        if (isSeatRuleExcluded(seatPriority, excludedSeatRules)) {
          debugLog('Seat priority excluded by user. Skipping', seatPriority);
          continue;
        }

        const result = tryClickSeatPriority(seatPriority);
        if (result === 'clicked') {
          debugLog('Seat priority candidate selected', seatPriority);
          return true;
        } else if (result === 'occupied') {
          debugLog('Seat priority has no available seat. Skipping', seatPriority);
        }
      }

      const fallbackSeat = findFirstAvailableSeat([], excludedSeatRules);
      if (fallbackSeat) {
        clickSeatElement(fallbackSeat.el, fallbackSeat.name);
        debugLog('Fallback seat click candidate selected', fallbackSeat.name);
        return true;
      }

      return false;
    };

    scheduleBackToZoneIfNoSeats();

    // Try immediately, then observe until exactly one seat is selected.
    if (trySeats()) return;

    if (seatObserver) seatObserver.disconnect();
    seatObserver = new MutationObserver(() => {
      if (trySeats()) {
        seatObserver.disconnect();
        seatObserver = null;
      }
    });
    seatObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function scheduleBackToZoneIfNoSeats() {
    if (seatUnavailableTimer) return;

    seatUnavailableTimer = setTimeout(() => {
      seatUnavailableTimer = null;
      if (!settings.isActive || !isSeatPage()) return;
      if (seatClickPending || hasSelectedSeat()) return;
      if (!isSeatMapLoaded()) {
        if (isSeatTransitionPage()) {
          const currentZone = getCurrentZoneName();
          if (currentZone) {
            markZoneSkipped(currentZone);
            clearPendingZoneAttempt();
            appendZoneClickLog(currentZone, 'seat-map-timeout-skip-zone', {
              nextAction: 'return-to-zone-selection'
            });
            setHudZoneLog(currentZone, 'seat-map-timeout');
            debugLog('Seat map did not render after zone click. Returning to zone selection', currentZone);
          } else {
            clearPendingZoneAttempt();
            appendZoneClickLog('unknown', 'seat-map-timeout-skip-zone', {
              nextAction: 'return-to-zone-selection'
            });
            debugLog('Seat map did not render after zone click. Returning to zone selection');
          }

          navigateBackToZoneSelection();
        }
        return;
      }
      if (hasUntriedAvailableSeat()) return;

      const currentZone = getCurrentZoneName();
      const pendingAttemptZone = !currentZone ? (getPendingZoneAttempt()?.zone || '') : '';
      const zoneToSkip = currentZone || pendingAttemptZone;
      if (zoneToSkip) {
        markZoneSkipped(zoneToSkip);
        appendZoneClickLog(zoneToSkip, 'no-seats-skip-zone', { nextAction: 'return-to-zone-selection' });
        setHudZoneLog(zoneToSkip, 'no-seats');
        debugLog('No selectable seats in zone. Returning to zone selection', zoneToSkip);
      } else {
        appendZoneClickLog('unknown', 'no-seats-skip-zone', { nextAction: 'return-to-zone-selection' });
        debugLog('No selectable seats found. Returning to zone selection');
      }
      clearPendingZoneAttempt();

      navigateBackToZoneSelection();
    }, SEAT_MAP_LOAD_TIMEOUT_MS);
  }

  function isSeatPage() {
    const url = window.location.href;
    return url.includes('seat') || url.includes('fixed.php') || Boolean(document.getElementById('tableseats'));
  }

  function isSeatTransitionPage() {
    const url = window.location.href;
    return url.includes('seat') || url.includes('fixed.php');
  }

  function hasSeatPageEvidence() {
    return isSeatMapLoaded();
  }

  function isSeatMapLoaded() {
    if (window.location.href.includes('fixed.php') || document.querySelector('.booking-seat')) {
      return Boolean(document.querySelector('#tableseats'));
    }
    return Boolean(document.querySelector('#tableseats')) || Boolean(document.querySelector('.seat-map, .booking-seat'));
  }

  function hasAvailableSeat() {
    return Boolean(document.querySelector('#tableseats .seatuncheck[data-seat], #tableseats td:not(.not-available)[title] .seatuncheck'));
  }

  function hasUntriedAvailableSeat() {
    return Boolean(findFirstAvailableSeat([], getExcludedSeatRules()));
  }

  function hasSelectedSeat() {
    const seatList = document.getElementById('seatlist');
    if (seatList?.value?.trim()) return true;
    return Boolean(document.querySelector(
      '#tableseats .seatcheck, #tableseats .seatchecked, #tableseats .seatselect, #tableseats .seatselected, ' +
      '#tableseats [class*="selected"], #tableseats [class*="checked"]'
    ));
  }

  function getCurrentZoneName() {
    const candidates = [
      document.querySelector('input[name="zoneDesc"]')?.value,
      document.querySelector('input[name="zone"]')?.value
    ];

    const zoneRow = [...document.querySelectorAll('.booking-summary .row')].find(row => (
      row.textContent.toLowerCase().includes('zone')
    ));
    const zoneResult = zoneRow ? zoneRow.querySelector('.result') : null;
    if (zoneResult?.textContent?.trim()) {
      candidates.push(zoneResult.textContent.trim());
    }

    for (const candidate of candidates) {
      const canonicalZone = getCanonicalZoneName(candidate);
      if (canonicalZone) return canonicalZone;
    }

    try {
      const url = new URL(window.location.href);
      const zoneFromUrl = getCanonicalZoneName(url.searchParams.get('zone'));
      if (zoneFromUrl) return zoneFromUrl;
    } catch (err) {
      // Fall back to stored zone below.
    }

    return getLastAttemptedZone();
  }

  function navigateBackToZoneSelection() {
    if (_isNavigatingBack) {
      debugLog('navigateBackToZoneSelection: already navigating, ignoring duplicate call');
      return;
    }
    _isNavigatingBack = true;

    // Priority 1: build URL from current page state or targetUrl setting (most reliable — avoids wrong-event links on page)
    const zoneSelectionUrl = buildZoneSelectionUrl();
    if (zoneSelectionUrl) {
      window.location.href = zoneSelectionUrl;
      return;
    }

    // Priority 2: find a zones.php link on the page that matches the target event query
    const targetQuery = getTargetEventQuery();
    if (targetQuery) {
      const matchingLink = [...document.querySelectorAll('a[href*="zones.php"]')]
        .find(a => {
          try { return new URL(a.href).searchParams.get('query') === targetQuery; } catch (e) { return false; }
        });
      if (matchingLink) {
        window.location.href = matchingLink.href;
        return;
      }
    }

    window.history.back();
  }

  // Returns the event query ID from the current page URL, payment form, or target URL setting.
  function buildZoneSelectionUrl() {
    try {
      const currentUrl = new URL(window.location.href);
      const currentQuery = currentUrl.searchParams.get('query');
      const currentRdId = currentUrl.searchParams.get('rdId');
      if (currentQuery) {
        const rdIdSuffix = currentRdId ? `&rdId=${encodeURIComponent(currentRdId)}` : '';
        return `/booking/3m/zones.php?query=${encodeURIComponent(currentQuery)}${rdIdSuffix}`;
      }

      const paymentForm = document.getElementById('frmPayment');
      const actionUrl = paymentForm ? new URL(paymentForm.getAttribute('action'), window.location.href) : null;
      const query = actionUrl ? actionUrl.searchParams.get('query') : '';
      const rdId = document.querySelector('input[name="rdId"]')?.value || actionUrl?.searchParams.get('rdId') || '';
      if (query) {
        const rdIdSuffix = rdId ? `&rdId=${encodeURIComponent(rdId)}` : '';
        return `/booking/3m/zones.php?query=${encodeURIComponent(query)}${rdIdSuffix}`;
      }

      // Fallback: extract query from the user-configured target URL
      const targetQuery = getTargetEventQuery();
      if (targetQuery) {
        return `/booking/3m/zones.php?query=${encodeURIComponent(targetQuery)}`;
      }
    } catch (err) {
      // Fall through.
    }

    return '';
  }

  // Extracts the event query ID from settings.targetUrl (e.g. "query=464" → "464").
  function getTargetEventQuery() {
    try {
      if (!settings.targetUrl) return '';
      const url = new URL(settings.targetUrl, 'https://booking.thaiticketmajor.com');
      return url.searchParams.get('query') || '';
    } catch (e) {
      return '';
    }
  }

  function getSkippedZones() {
    const now = Date.now();
    return _skippedZones
      .filter(e => (now - e.skippedAt) < SKIPPED_ZONE_TTL_MS)
      .map(e => e.zone);
  }

  function markZoneSkipped(zoneName) {
    const normalized = normalizeZoneName(zoneName);
    if (!normalized) return;
    const now = Date.now();
    _skippedZones = _skippedZones.filter(e => (now - e.skippedAt) < SKIPPED_ZONE_TTL_MS && e.zone !== normalized);
    _skippedZones.push({ zone: normalized, skippedAt: now });
    sessionStore.set({ [SKIPPED_ZONES_KEY]: [..._skippedZones] });
    debugLog('Marked zone as skipped', _skippedZones.map(e => e.zone));
  }

  function clearSkippedZones() {
    _skippedZones = [];
    sessionStore.remove([SKIPPED_ZONES_KEY]);
    clearLastAttemptedZone();
    clearPendingZoneAttempt();
  }

  function hasActiveBookingAttempt() {
    return Boolean(getSkippedZones().length > 0 || _lastAttemptedZone || _pendingZoneAttempt);
  }

  function persistLastAttemptedZone(zoneName) {
    const normalizedZone = normalizeZoneName(zoneName);
    if (!normalizedZone) return;
    _lastAttemptedZone = normalizedZone.toUpperCase();
    chrome.storage.local.set({ [LAST_ATTEMPTED_ZONE_KEY]: _lastAttemptedZone });
  }

  function getLastAttemptedZone() {
    return _lastAttemptedZone;
  }

  function clearLastAttemptedZone() {
    _lastAttemptedZone = '';
    chrome.storage.local.remove([LAST_ATTEMPTED_ZONE_KEY]);
  }

  function persistPendingZoneAttempt(zoneName) {
    const normalizedZone = normalizeZoneName(zoneName);
    if (!normalizedZone) return;
    _pendingZoneAttempt = { zone: normalizedZone, startedAt: Date.now() };
    chrome.storage.local.set({ [PENDING_ZONE_ATTEMPT_KEY]: _pendingZoneAttempt });
    setTimeout(() => handlePendingZoneAttemptTimeout(), SEAT_MAP_LOAD_TIMEOUT_MS + AVAILABILITY_WAIT_POLL_MS);
  }

  function getPendingZoneAttempt() {
    return _pendingZoneAttempt;
  }

  function clearPendingZoneAttempt() {
    _pendingZoneAttempt = null;
    chrome.storage.local.remove([PENDING_ZONE_ATTEMPT_KEY]);
  }

  function handlePendingZoneAttemptTimeout() {
    const pendingAttempt = getPendingZoneAttempt();
    if (!pendingAttempt) return false;

    if (hasSeatPageEvidence()) {
      clearPendingZoneAttempt();
      return false;
    }

    if (!isSeatTransitionPage()) return false;

    const elapsedMs = Date.now() - pendingAttempt.startedAt;
    if (elapsedMs < SEAT_MAP_LOAD_TIMEOUT_MS) return false;

    const zoneName = getCurrentZoneName() || pendingAttempt.zone.toUpperCase();
    zoneClickPending = false;
    if (zoneName) {
      markZoneSkipped(zoneName);
      appendZoneClickLog(zoneName, 'pending-zone-timeout-skip-zone', {
        nextAction: 'return-to-zone-selection',
        elapsedMs
      });
      setHudZoneLog(zoneName, 'pending-zone-timeout');
      debugLog('Pending zone attempt timed out without seat map. Returning to zone selection', zoneName);
    }
    clearPendingZoneAttempt();
    navigateBackToZoneSelection();
    return true;
  }

  function getExcludedZoneSet() {
    return new Set(
      String(settings.excludedZones || '')
        .split(',')
        .map(normalizeZoneName)
        .filter(Boolean)
    );
  }

  function isZoneExcluded(zoneName) {
    const normalizedZone = normalizeZoneName(zoneName);
    return Boolean(normalizedZone) && getExcludedZoneSet().has(normalizedZone);
  }

  function getExcludedSeatRules() {
    const exactSeats = new Set();
    const rows = new Set();

    String(settings.excludedSeats || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .forEach(value => {
        if (isLikelySeatRowName(value) && !isLikelySeatName(value)) {
          rows.add(normalizeSeatRowName(value));
          return;
        }

        const seatName = normalizeSeatName(value);
        if (seatName) exactSeats.add(seatName);
      });

    return { exactSeats, rows };
  }

  function isSeatExcluded(seatName, excludedSeatRules = getExcludedSeatRules()) {
    const normalizedSeat = normalizeSeatName(seatName);
    if (!normalizedSeat) return false;
    if (excludedSeatRules.exactSeats.has(normalizedSeat)) return true;

    const seatRow = normalizeSeatRowName(getSeatRowName(seatName));
    return Boolean(seatRow) && excludedSeatRules.rows.has(seatRow);
  }

  function isSeatRuleExcluded(seatRule, excludedSeatRules = getExcludedSeatRules()) {
    if (isLikelySeatRowName(seatRule) && !isLikelySeatName(seatRule)) {
      return excludedSeatRules.rows.has(normalizeSeatRowName(seatRule));
    }

    return isSeatExcluded(seatRule, excludedSeatRules);
  }

  /**
   * Try to click a specific seat priority. Letter-only values are treated as row names.
   * @returns {'clicked'|'occupied'|'not-found'}
   */
  function tryClickSeatPriority(seatPriority) {
    if (isLikelySeatRowName(seatPriority)) {
      return tryClickSeatInRow(seatPriority);
    }

    return tryClickExactSeat(seatPriority);
  }

  function tryClickSeatInRow(rowName) {
    const rowClean = normalizeSeatRowName(rowName);
    let rowFound = false;

    const candidates = getSeatCandidates();
    const excludedSeatRules = getExcludedSeatRules();

    for (let el of candidates) {
      const seatName = getSeatNameFromElement(el);
      if (normalizeSeatRowName(getSeatRowName(seatName)) !== rowClean) continue;
      rowFound = true;

      if (isSeatExcluded(seatName, excludedSeatRules)) continue;
      if (isSeatOccupied(el) || clickedElements.has(el)) continue;

      clickSeatElement(el, seatName || rowName);
      return 'clicked';
    }

    return rowFound ? 'occupied' : 'not-found';
  }

  function tryClickExactSeat(seatName) {
    const seatClean = normalizeSeatName(seatName);
    const excludedSeatRules = getExcludedSeatRules();
    if (isSeatExcluded(seatName, excludedSeatRules)) return 'occupied';

    const candidates = getSeatCandidates();

    for (let el of candidates) {
      const elSeat = normalizeSeatName(getSeatNameFromElement(el));

      if (elSeat !== seatClean) continue;
      if (isSeatExcluded(getSeatNameFromElement(el), excludedSeatRules)) return 'occupied';
      if (isSeatOccupied(el)) return 'occupied';
      if (clickedElements.has(el)) return 'clicked';

      clickSeatElement(el, getSeatNameFromElement(el) || seatName);
      return 'clicked';
    }

    return 'not-found';
  }

  function findFirstAvailableSeat(excludedSeats, excludedSeatRules = getExcludedSeatRules()) {
    const excluded = excludedSeats.map(normalizeSeatName);
    const seen = new Set();

    for (const el of getSeatCandidates()) {
      const seatName = getSeatNameFromElement(el);
      const normalized = normalizeSeatName(seatName);

      if (!isLikelySeatName(seatName) || excluded.includes(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);

      if (isSeatExcluded(seatName, excludedSeatRules)) continue;
      if (isSeatOccupied(el) || clickedElements.has(el)) continue;
      return { el, name: seatName };
    }

    return null;
  }

  function getSeatCandidates() {
    if (document.getElementById('tableseats')) {
      return document.querySelectorAll(
        '#tableseats .seatuncheck[data-seat], #tableseats td:not(.not-available)[title] .seatuncheck, ' +
        '#tableseats td:not(.not-available)[title]'
      );
    }

    if (window.location.href.includes('fixed.php') || document.querySelector('.booking-seat')) {
      return [];
    }

    return document.querySelectorAll(
      'area[onclick*="seat"], area[href*="seat"], area[title], area[alt], ' +
      'a[onclick*="seat"], button[onclick*="seat"], div[onclick*="seat"], span[onclick*="seat"], ' +
      'a[onclick*="chair"], button[onclick*="chair"], div[onclick*="chair"], span[onclick*="chair"], ' +
      'div[data-seat], span[data-seat], rect[data-seat], circle[data-seat], ' +
      '[data-seat-id], [data-seat-label], [data-seat-name], ' +
      '.seat, [class*="seat"], [id^="seat"], [class*="chair"], [id^="chair"]'
    );
  }

  function getSeatNameFromElement(el) {
    const seatCell = el.closest('#tableseats td[title]');
    const directValue = (
      el.getAttribute('data-seat') ||
      el.getAttribute('data-seat-id') ||
      el.getAttribute('data-seat-label') ||
      el.getAttribute('data-seat-name') ||
      seatCell?.getAttribute('title') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      el.getAttribute('href') ||
      el.getAttribute('onclick') ||
      el.id ||
      el.textContent ||
      ''
    ).trim();

    return extractSeatName(directValue);
  }

  function extractSeatName(value) {
    const text = (value || '').trim();
    if (isLikelySeatName(text)) return text;

    const quotedSeatMatch = text.match(/['"]([A-Za-z]{1,4}[-_\s]?\d{1,4})['"]/);
    if (quotedSeatMatch && quotedSeatMatch[1]) return quotedSeatMatch[1].trim();

    const prefixedSeatMatch = text.match(/(?:seat|chair|place)[-_\s]*([A-Za-z]{1,4}[-_\s]?\d{1,4})/i);
    if (prefixedSeatMatch && prefixedSeatMatch[1]) return prefixedSeatMatch[1].trim();

    const genericSeatMatch = text.match(/\b([A-Za-z]{1,4}[-_\s]?\d{1,4})\b/);
    return genericSeatMatch ? genericSeatMatch[1].trim() : text;
  }

  function getSeatRowName(seatName) {
    const text = (seatName || '').trim();
    const match = text.match(/^([A-Za-z]{1,4})[-_\s]?\d{1,4}$/);
    return match ? match[1] : '';
  }

  function clickSeatElement(el, seatName) {
    if (seatClickPending) return;
    const clickableEl = el.matches('.seatuncheck, [data-seat]') ? el : (el.querySelector('.seatuncheck, [data-seat]') || el);
    const beforeSeatList = getSeatListValue();

    seatClickPending = true;
    clickedElements.add(el);
    clickedElements.add(clickableEl);
    debugLog('Scheduling seat click', { seatName, delayMs: STEP_DELAY_MS.seat });
    scheduleDelayedClick(`seat-${normalizeSeatName(seatName)}`, STEP_DELAY_MS.seat, () => {
      debugLog('Clicking seat', seatName);
      dispatchClickSequence(clickableEl);
      setTimeout(() => verifySeatClickResult(clickableEl, seatName, beforeSeatList), 0);
    });
  }

  function verifySeatClickResult(clickedEl, seatName, beforeSeatList) {
    if (!settings.isActive || !isSeatPage()) {
      seatClickPending = false;
      return;
    }

    const afterSeatList = getSeatListValue();
    if (isSeatSelected(clickedEl, seatName, beforeSeatList, afterSeatList)) {
      debugLog('Seat selected confirmed', {
        seatName,
        seatlist: afterSeatList
      });
      seatClickPending = false;
      if (seatObserver) {
        seatObserver.disconnect();
        seatObserver = null;
      }
      scheduleBookNowClick();
      return;
    }

    debugLog('Seat click did not select seat. Trying next seat', {
      seatName,
      beforeSeatList,
      afterSeatList
    });
    seatClickPending = false;

    if (hasUntriedAvailableSeat()) {
      handleSeatSelection();
      return;
    }

    const currentZone = getCurrentZoneName();
    if (currentZone) {
      markZoneSkipped(currentZone);
      debugLog('All available seat candidates failed. Returning to zone selection', currentZone);
    } else {
      debugLog('All available seat candidates failed. Returning to zone selection');
    }
    navigateBackToZoneSelection();
  }

  function scheduleBookNowClick(attempt = 0) {
    if (bookNowClickPending) return;

    const bookNowButton = findBookNowButton();
    if (!bookNowButton) {
      if (attempt < 8) {
        debugLog('Book Now button not ready. Retrying', { attempt: attempt + 1 });
        setTimeout(() => scheduleBookNowClick(attempt + 1), 0);
      } else {
        debugLog('Book Now button not found after seat selection');
      }
      return;
    }

    bookNowClickPending = true;
    debugLog('Scheduling Book Now click', {
      delayMs: STEP_DELAY_MS.bookNow,
      element: getElementDebugInfo(bookNowButton)
    });

    scheduleDelayedClick('book-now', STEP_DELAY_MS.bookNow, () => {
      if (!settings.isActive || !isSeatPage()) {
        bookNowClickPending = false;
        return;
      }

      debugLog('Clicking Book Now button', getElementDebugInfo(bookNowButton));
      dispatchPointerClickSequence(bookNowButton);
    });
  }

  function findBookNowButton() {
    const candidates = [
      document.getElementById('booknow'),
      document.querySelector('a#booknow.btn-main-action'),
      document.querySelector('.btn-main-action#booknow'),
      document.querySelector('.booking-sidebar .btn-main-action'),
      document.querySelector('.btn-main-action')
    ].filter(Boolean);

    return candidates.find(el => isVisible(el)) || null;
  }

  function getSeatListValue() {
    return (document.getElementById('seatlist')?.value || '').trim();
  }

  function isSeatSelected(clickedEl, seatName, beforeSeatList, afterSeatList) {
    if (afterSeatList && afterSeatList !== beforeSeatList) return true;

    const normalizedSeat = normalizeSeatName(seatName);
    if (afterSeatList && normalizeSeatName(afterSeatList).includes(normalizedSeat)) return true;

    const seatCell = clickedEl.closest('#tableseats td[title]');
    const selectedTarget = seatCell || clickedEl;
    const selectedClasses = [
      typeof selectedTarget.className === 'string' ? selectedTarget.className.toLowerCase() : '',
      typeof clickedEl.className === 'string' ? clickedEl.className.toLowerCase() : ''
    ].join(' ');

    return /\b(seatcheck|seatchecked|seatselect|seatselected|selected|checked)\b/.test(selectedClasses);
  }

  function scheduleDelayedClick(key, delayMs, action) {
    const storageKey = `ttmHelperDelay:${key}`;
    const now = Date.now();
    try {
      const activeUntil = Number(sessionStorage.getItem(storageKey) || 0);
      if (activeUntil > now) {
        debugLog('Skipped delayed action already scheduled', {
          key,
          remainingMs: activeUntil - now
        });
        return false;
      }
      sessionStorage.setItem(storageKey, String(now + Math.max(delayMs, 0) + 500));
    } catch (err) {
      // Continue without scheduling lock if sessionStorage is unavailable.
    }

    setTimeout(() => {
      try {
        action();
      } finally {
        try {
          sessionStorage.removeItem(storageKey);
        } catch (err) {
          // Ignore storage cleanup errors.
        }
      }
    }, Math.max(delayMs, 0));
    return true;
  }

  function dispatchClickSequence(el) {
    ['mouseover', 'mousedown', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
  }

  function dispatchPointerClickSequence(el) {
    ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
      const EventCtor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new EventCtor(type, { bubbles: true, cancelable: true, view: window }));
    });
  }

  function normalizeSeatName(seatName) {
    const clean = (seatName || '').trim().toLowerCase();
    const match = clean.match(/^([a-z]{1,4})[-_\s]?0*(\d{1,4})$/);
    if (match) return `${match[1]}${Number(match[2])}`;
    return clean.replace(/[^a-z0-9]/g, '');
  }

  function isLikelySeatName(seatName) {
    const clean = normalizeSeatName(seatName);
    return /^[a-z]{1,4}\d{1,4}$/.test(clean);
  }

  function normalizeSeatRowName(rowName) {
    return (rowName || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  }

  function isLikelySeatRowName(rowName) {
    const clean = normalizeSeatRowName(rowName);
    return /^[a-z]{1,4}$/.test(clean);
  }

  /**
   * Check if a seat element indicates it's already occupied.
   */
  function isSeatOccupied(el) {
    const occupied = [
      'occupied', 'sold', 'unavailable', 'reserved', 'disabled', 'selected-other',
      'booked', 'lock', 'locked', 'unselect', 'not-available', 'notavailable'
    ];
    const seatCell = el.closest('td');
    if (seatCell?.classList.contains('not-available')) return true;

    const classes = [
      typeof el.className === 'string' ? el.className.toLowerCase() : '',
      seatCell && typeof seatCell.className === 'string' ? seatCell.className.toLowerCase() : ''
    ].join(' ');
    for (const kw of occupied) {
      if (classes.includes(kw)) return true;
    }
    if (el.hasAttribute('disabled') || el.classList.contains('disabled')) return true;
    
    const style = window.getComputedStyle(el);
    if (parseFloat(style.opacity) < 0.3) return true;

    return false;
  }

  // ==================== HELPERS ====================
  function matchNormalizedDate(htmlText, inputTarget) {
    const cleanHtml = htmlText.toLowerCase().replace(/\s+/g, ' ');
    const cleanInput = inputTarget.trim().toLowerCase();

    if (cleanHtml.includes(cleanInput)) return true;

    const dateRegex = /^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/;
    const match = cleanInput.match(dateRegex);
    if (match) {
      const day = parseInt(match[1], 10).toString();
      const monthNum = parseInt(match[2], 10);
      const months = [
        ['jan', 'january'],
        ['feb', 'february'],
        ['mar', 'march'],
        ['apr', 'april'],
        ['may'],
        ['jun', 'june'],
        ['jul', 'july'],
        ['aug', 'august'],
        ['sep', 'sept', 'september'],
        ['oct', 'october'],
        ['nov', 'november'],
        ['dec', 'december']
      ];
      if (monthNum >= 1 && monthNum <= 12) {
        const monthNames = months[monthNum - 1];
        const dayRegex = new RegExp('\\b' + day + '\\b');
        if (dayRegex.test(cleanHtml) && monthNames.some(monthName => cleanHtml.includes(monthName))) return true;

        const paddedDay = day.padStart(2, '0');
        const paddedMonth = monthNum.toString().padStart(2, '0');
        const numericDatePatterns = [
          `${day}/${monthNum}`,
          `${paddedDay}/${monthNum}`,
          `${day}/${paddedMonth}`,
          `${paddedDay}/${paddedMonth}`,
          `${day}-${monthNum}`,
          `${paddedDay}-${monthNum}`,
          `${day}-${paddedMonth}`,
          `${paddedDay}-${paddedMonth}`
        ];
        if (numericDatePatterns.some(pattern => cleanHtml.includes(pattern))) return true;
      }
    }

    return false;
  }

  function getContainerDateText(el) {
    const row = el.closest('.row, .event-detail-item');
    if (!row) return '';
    const dateEl = row.querySelector('.date, .col-label, .date-box');
    return dateEl ? dateEl.textContent : row.textContent;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      el.offsetWidth > 0 &&
      el.offsetHeight > 0
    );
  }

  // ==================== BOOTSTRAP ====================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAutomationCycle);
  } else {
    runAutomationCycle();
  }

  function runAutomationCycleSoon() {
    setTimeout(runAutomationCycle, 0);
  }

  window.addEventListener('hashchange', runAutomationCycleSoon);
  window.addEventListener('popstate', runAutomationCycleSoon);
})();
