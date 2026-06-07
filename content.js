(function () {
  const DEFAULT_CLICK_SELECTOR = '.btn-buynow, .btn-item a.btn, a.btn-buynow, a.btn-red[href*="booking"], a[href*="/booking/"]';
  const SCRIPT_INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
    autoClick: true
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
  const LAST_ATTEMPTED_ZONE_KEY = 'ttmHelperLastAttemptedZone';
  const PENDING_ZONE_ATTEMPT_KEY = 'ttmHelperPendingZoneAttempt';
  const ZONE_CLICK_LOGS_KEY = 'ttmHelperZoneClickLogs';
  const LAST_ZONE_CLICK_AT_KEY = 'ttmHelperLastZoneClickAt';
  const EVENT_ACTION_LOCK_KEY = 'ttmHelperEventActionLock';
  const EVENT_ACTION_LOCK_MS = 12000;
  const MAX_AVAILABILITY_WAIT_MS = 2500;
  const AVAILABILITY_WAIT_POLL_MS = 100;
  const ZONE_CLICK_VERIFY_MS = 250;
  const ZONE_SEAT_MAP_WAIT_MS = 2500;
  const SEAT_MAP_LOAD_TIMEOUT_MS = 3000;
  const ENABLE_CONSOLE_LOGS = false;
  const STEP_DELAY_MS = {
    event: 0,
    selectPerformance: 0,
    verify: 0,
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

  // Load settings
  chrome.storage.local.get(
    [
      'isActive', 'targetUrl', 'targetDate', 'targetTime',
      'zoneSelector', 'seatSelector', 'excludedZones', 'excludedSeats',
      'autoNavigate', 'autoClick'
    ],
    (result) => {
      updateSettings(result);
    }
  );

  // Monitor storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      const newSettings = {};
      for (let key in changes) {
        newSettings[key] = changes[key].newValue;
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

  function updateSettings(newSettings) {
    for (let key in newSettings) {
      if (newSettings[key] === undefined) delete newSettings[key];
    }
    settings = { ...settings, ...newSettings };
    debugLog('Settings updated', getSettingsDebugInfo());
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
    if (isZoneSelectionPage()) return 'Zone Selection';
    if (isVerifyConditionPage()) return 'Verification';
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
        if (!currentUrl.includes('booking.thaiticketmajor.com')) {
          debugLog('Navigating to target URL', targetUrl);
          window.location.href = targetUrl;
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

    const tryQueueRedirect = () => {
      const queueTargetUrl = getQueueReadyTargetUrl();
      if (!queueTargetUrl || Date.now() - lastQueueRedirectAt < 1500) return;

      lastQueueRedirectAt = Date.now();
      debugLog('Queue is ready. Redirecting', queueTargetUrl);
      window.location.href = queueTargetUrl;
    };

    tryQueueRedirect();

    if (!queueRetryTimer) {
      queueRetryTimer = setInterval(() => {
        if (!settings.isActive || !isQueueUrl(window.location.href)) {
          clearInterval(queueRetryTimer);
          queueRetryTimer = null;
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
      if (isVerifyConditionPage()) {
        handleVerifyCondition();
      } else if (url.includes('seat') || url.includes('fixed.php')) {
        handleSeatSelection();
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

  function logEventNoMatch(visibleCandidates) {
    if (Date.now() - lastEventNoMatchLogAt < 2500) return;
    lastEventNoMatchLogAt = Date.now();
    debugLog('No matching event round/button found yet', {
      readyState: document.readyState,
      visibleCandidates,
      targetDate: settings.targetDate,
      targetTime: settings.targetTime,
      pageTextSample: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500)
    });
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
    const popupButton = document.getElementById('popup-avail');
    if (popupButton && isVisible(popupButton)) {
      dispatchClickSequence(popupButton);
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
      appendZoneClickLog('scan-state', 'zone-scan-state', {
        nextAction: 'try-zone-priorities',
        zonePriorities,
        skippedZones,
        excludedZones: [...excludedZones],
        pendingAttempt: getPendingZoneAttempt(),
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
      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
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
    try {
      const rawLogs = sessionStorage.getItem(ZONE_CLICK_LOGS_KEY) || localStorage.getItem(ZONE_CLICK_LOGS_KEY) || '[]';
      const parsedLogs = JSON.parse(rawLogs);
      zoneClickLogs = Array.isArray(parsedLogs) ? parsedLogs : [];

      const rawLastAt = sessionStorage.getItem(LAST_ZONE_CLICK_AT_KEY) || localStorage.getItem(LAST_ZONE_CLICK_AT_KEY) || '0';
      lastZoneClickAt = Number(rawLastAt) || 0;
    } catch (err) {
      zoneClickLogs = [];
      lastZoneClickAt = 0;
    }
  }

  function persistZoneLogsToStorage() {
    try {
      const logsJson = JSON.stringify(zoneClickLogs.slice(-500));
      sessionStorage.setItem(ZONE_CLICK_LOGS_KEY, logsJson);
      localStorage.setItem(ZONE_CLICK_LOGS_KEY, logsJson);

      const lastAtValue = String(lastZoneClickAt || 0);
      sessionStorage.setItem(LAST_ZONE_CLICK_AT_KEY, lastAtValue);
      localStorage.setItem(LAST_ZONE_CLICK_AT_KEY, lastAtValue);
    } catch (err) {
      // Ignore storage write failures.
    }
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

  function isZoneSelectionPage() {
    const url = window.location.href;
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
      if (currentZone) {
        markZoneSkipped(currentZone);
        debugLog('No selectable seats in zone. Returning to zone selection', currentZone);
      } else {
        debugLog('No selectable seats found. Returning to zone selection');
      }

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
    const zoneLink = document.querySelector('a[href*="zones.php"]');
    if (zoneLink && zoneLink.href) {
      window.location.href = zoneLink.href;
      return;
    }

    const zoneSelectionUrl = buildZoneSelectionUrl();
    if (zoneSelectionUrl) {
      window.location.href = zoneSelectionUrl;
      return;
    }

    window.history.back();
  }

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
    } catch (err) {
      // Fall through to browser history when page metadata is not available.
    }

    return '';
  }

  function getSkippedZones() {
    try {
      const rawZones = localStorage.getItem(SKIPPED_ZONES_KEY) || sessionStorage.getItem(SKIPPED_ZONES_KEY) || '[]';
      const zones = JSON.parse(rawZones);
      return Array.isArray(zones) ? zones.map(normalizeZoneName).filter(Boolean) : [];
    } catch (err) {
      return [];
    }
  }

  function markZoneSkipped(zoneName) {
    const normalized = normalizeZoneName(zoneName);
    if (!normalized) return;

    const zones = getSkippedZones();
    if (!zones.includes(normalized)) zones.push(normalized);
    localStorage.setItem(SKIPPED_ZONES_KEY, JSON.stringify(zones));
    sessionStorage.setItem(SKIPPED_ZONES_KEY, JSON.stringify(zones));
    debugLog('Marked zone as skipped', zones);
  }

  function clearSkippedZones() {
    localStorage.removeItem(SKIPPED_ZONES_KEY);
    sessionStorage.removeItem(SKIPPED_ZONES_KEY);
    clearLastAttemptedZone();
  }

  function hasActiveBookingAttempt() {
    return Boolean(getSkippedZones().length > 0 || getLastAttemptedZone() || getPendingZoneAttempt());
  }

  function persistLastAttemptedZone(zoneName) {
    const normalizedZone = normalizeZoneName(zoneName);
    if (!normalizedZone) return;

    try {
      localStorage.setItem(LAST_ATTEMPTED_ZONE_KEY, normalizedZone);
      sessionStorage.setItem(LAST_ATTEMPTED_ZONE_KEY, normalizedZone);
    } catch (err) {
      // Ignore storage write failures.
    }
  }

  function getLastAttemptedZone() {
    try {
      return normalizeZoneName(
        localStorage.getItem(LAST_ATTEMPTED_ZONE_KEY) ||
        sessionStorage.getItem(LAST_ATTEMPTED_ZONE_KEY) ||
        ''
      ).toUpperCase();
    } catch (err) {
      return '';
    }
  }

  function clearLastAttemptedZone() {
    try {
      localStorage.removeItem(LAST_ATTEMPTED_ZONE_KEY);
      sessionStorage.removeItem(LAST_ATTEMPTED_ZONE_KEY);
    } catch (err) {
      // Ignore storage cleanup failures.
    }
  }

  function persistPendingZoneAttempt(zoneName) {
    const normalizedZone = normalizeZoneName(zoneName);
    if (!normalizedZone) return;

    const payload = JSON.stringify({
      zone: normalizedZone,
      startedAt: Date.now()
    });
    try {
      localStorage.setItem(PENDING_ZONE_ATTEMPT_KEY, payload);
      sessionStorage.setItem(PENDING_ZONE_ATTEMPT_KEY, payload);
    } catch (err) {
      // Ignore storage write failures.
    }

    setTimeout(() => handlePendingZoneAttemptTimeout(), SEAT_MAP_LOAD_TIMEOUT_MS + AVAILABILITY_WAIT_POLL_MS);
  }

  function getPendingZoneAttempt() {
    try {
      const raw = sessionStorage.getItem(PENDING_ZONE_ATTEMPT_KEY) || localStorage.getItem(PENDING_ZONE_ATTEMPT_KEY) || '';
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const zone = normalizeZoneName(parsed.zone || '');
      const startedAt = Number(parsed.startedAt) || 0;
      if (!zone || !startedAt) return null;
      return { zone, startedAt };
    } catch (err) {
      return null;
    }
  }

  function clearPendingZoneAttempt() {
    try {
      localStorage.removeItem(PENDING_ZONE_ATTEMPT_KEY);
      sessionStorage.removeItem(PENDING_ZONE_ATTEMPT_KEY);
    } catch (err) {
      // Ignore storage cleanup failures.
    }
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
