(function () {
  const DEFAULT_CLICK_SELECTOR = '.btn-buynow, .btn-item a.btn, a.btn-buynow, a.btn-red[href*="booking"], a[href*="/booking/"]';

  let settings = {
    isActive: false,
    targetUrl: '',
    targetDate: '',
    targetTime: '',
    zoneSelector: '',  // comma-separated priority list e.g. "A1, V3, B1"
    seatSelector: '',  // comma-separated row priority list e.g. "AA, A, B"
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
  const SKIPPED_ZONES_KEY = 'ttmHelperSkippedZones';
  const EVENT_ACTION_LOCK_KEY = 'ttmHelperEventActionLock';
  const EVENT_ACTION_LOCK_MS = 12000;
  const MAX_AVAILABILITY_WAIT_MS = 18000;
  const ENABLE_CONSOLE_LOGS = false;
  const STEP_DELAY_MS = {
    event: 1800,
    selectPerformance: 1000,
    verify: 700,
    round: 1200,
    availability: 1600,
    zone: 900,
    seat: 700,
    bookNow: 900
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
      'zoneSelector', 'seatSelector',
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

  function updateSettings(newSettings) {
    for (let key in newSettings) {
      if (newSettings[key] === undefined) delete newSettings[key];
    }
    settings = { ...settings, ...newSettings };
    debugLog('Settings updated', getSettingsDebugInfo());

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
      autoNavigate: settings.autoNavigate,
      autoClick: settings.autoClick
    };
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

    const url = window.location.href;
    if (handleQueuePage()) return;

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
      clearSkippedZones();
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
      const zone = (zoneName || '').replace(/^#/, '').trim();
      if (!isLikelyZoneName(zone)) return;

      const key = zone.toLowerCase();
      if (!zoneMap.has(key)) zoneMap.set(key, zone);
    };

    const addZoneFromHref = (href) => {
      const matches = (href || '').match(/#([^#\s]+)/g) || [];
      if (matches.length === 0) return;
      addZone(matches[matches.length - 1].replace(/^#/, ''));
    };

    document.querySelectorAll('.map-zone area[href], .select-zone area[href], map area[href]').forEach(el => {
      addZoneFromHref(el.getAttribute('href'));
      addZone(el.getAttribute('data-zone'));
      addZone(el.getAttribute('data-zone-id'));
      addZone(el.getAttribute('data-zone-label'));
    });

    document.querySelectorAll('#avail_data table tbody tr, #popup-event-zone table tbody tr').forEach(row => {
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

  function isLikelyZoneName(zoneName) {
    const zone = (zoneName || '').trim().toUpperCase();
    return zone === 'VIP' || /^[A-Z]{1,4}\d{0,3}$/.test(zone);
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
    setTimeout(() => selectZoneAfterAvailabilityRefresh(refreshStartedAt), STEP_DELAY_MS.availability);
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
      setTimeout(() => selectZoneAfterAvailabilityRefresh(refreshStartedAt), 1000);
      return;
    }

    availabilityRefreshPending = false;
    logZoneAvailabilitySnapshot();
    autoClickZoneWithFallback({ allowMapFallback: true });
  }

  function openAndReloadAvailability() {
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
      if (currentObserver) currentObserver.disconnect();
      currentObserver = new MutationObserver(() => {
        if (!hasAvailabilityTable() || zoneClickPending) return;
        currentObserver.disconnect();
        currentObserver = null;
        logZoneAvailabilitySnapshot();
        autoClickZoneWithFallback();
      });
      currentObserver.observe(document.documentElement, { childList: true, subtree: true });
      return;
    }

    if (!hasAvailabilityTable() && allowMapFallback) {
      debugLog('Seats Available table unavailable after refresh. Falling back to map zones');
    }

    const zonePriorities = settings.zoneSelector
      .split(',')
      .map(z => z.trim())
      .filter(Boolean)
      .slice(0, 4);

    debugLog('Zone priority list', zonePriorities);
    logZoneAvailabilitySnapshot();

    const tryZones = () => {
      const skippedZones = getSkippedZones();

      for (const zoneName of zonePriorities) {
        if (skippedZones.includes(normalizeZoneName(zoneName))) {
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
        }
      }

      const fallbackZone = findFirstAvailableZone([...zonePriorities, ...skippedZones], allowMapFallback);
      if (fallbackZone) {
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
      currentObserver = new MutationObserver(() => {
        if (tryZones()) {
          currentObserver.disconnect();
          currentObserver = null;
        }
      });
      currentObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function getAvailableZoneFromAvailabilityTable(zoneName) {
    const normalizedTarget = normalizeZoneName(zoneName);
    if (!normalizedTarget) return null;
    return getAvailableZonesFromAvailabilityTable(getSkippedZones())
      .find(item => normalizeZoneName(item.name) === normalizedTarget) || null;
  }

  /**
   * Try to click a specific zone by name.
   * @returns {'clicked'|'sold-out'|'available-not-clicked'|'not-found'}
   */
  function tryClickZone(zoneName) {
    const zoneClean = normalizeZoneName(zoneName);

    // 1. Prefer the Seats Available table when it exists because it carries availability state.
    const availabilityRows = document.querySelectorAll('#avail_data table tbody tr, #popup-event-zone table tbody tr');
    for (let el of availabilityRows) {
      const candidateName = getZoneNameFromElement(el);
      if (normalizeZoneName(candidateName) === zoneClean) {
        if (isZoneSoldOut(el, zoneName)) return 'sold-out';
        if (clickedElements.has(el)) return 'clicked';

        clickZoneElement(el, zoneName);
        return 'clicked';
      }
    }

    // 2. Search <area> elements (image map zones)
    const areas = document.querySelectorAll('area');
    for (let el of areas) {
      const candidateName = getZoneNameFromElement(el);
      if (normalizeZoneName(candidateName) === zoneClean) {
        // Check if the area (or its parent) indicates sold-out
        if (isZoneSoldOut(el, zoneName)) return 'sold-out';
        if (clickedElements.has(el)) return 'clicked';

        clickZoneElement(el, zoneName);
        return 'clicked';
      }
    }

    // 3. Search zone buttons/links with data-zone or text matching
    const candidates = document.querySelectorAll('a, button, div, rect, path, [data-zone]');
    for (let el of candidates) {
      const candidateName = getZoneNameFromElement(el);
      if (normalizeZoneName(candidateName) === zoneClean) {
        if (isZoneSoldOut(el, zoneName)) return 'sold-out';
        if (!isVisible(el)) return 'available-not-clicked';
        if (clickedElements.has(el)) return 'clicked';

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
      ...document.querySelectorAll('area'),
      ...document.querySelectorAll('a[href*="#"], a[onclick*="selectzone"], button[data-zone], .zone-item, [data-zone]')
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

    for (const el of document.querySelectorAll('#avail_data table tbody tr, #popup-event-zone table tbody tr')) {
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
    return Boolean(document.querySelector('#avail_data table tbody tr, #popup-event-zone table tbody tr'));
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
    const rows = [...document.querySelectorAll('#avail_data table tbody tr, #popup-event-zone table tbody tr')]
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
    clickedElements.add(el);
    debugLog('Scheduling zone click', { zoneName, delayMs: STEP_DELAY_MS.zone });
    scheduleDelayedClick(`zone-${normalizeZoneName(zoneName)}`, STEP_DELAY_MS.zone, () => {
      debugLog('Clicking zone', zoneName);
      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });
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
    return (zoneName || '').trim().toLowerCase();
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

    const seatPriorities = settings.seatSelector
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    debugLog('Seat row priority list', seatPriorities);

    const trySeats = () => {
      for (const seatPriority of seatPriorities) {
        const result = tryClickSeatPriority(seatPriority);
        if (result === 'clicked') {
          debugLog('Seat priority candidate selected', seatPriority);
          return true;
        } else if (result === 'occupied') {
          debugLog('Seat priority has no available seat. Skipping', seatPriority);
        }
      }

      const fallbackSeat = findFirstAvailableSeat([]);
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
      if (!isSeatMapLoaded()) return;
      if (hasUntriedAvailableSeat()) return;

      const currentZone = getCurrentZoneName();
      if (currentZone) {
        markZoneSkipped(currentZone);
        debugLog('No selectable seats in zone. Returning to zone selection', currentZone);
      } else {
        debugLog('No selectable seats found. Returning to zone selection');
      }

      navigateBackToZoneSelection();
    }, 3500);
  }

  function isSeatPage() {
    const url = window.location.href;
    return url.includes('seat') || url.includes('fixed.php') || Boolean(document.getElementById('tableseats'));
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
    return Boolean(findFirstAvailableSeat([]));
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
    const zoneInput = document.querySelector('input[name="zone"], input[name="zoneDesc"]');
    if (zoneInput && zoneInput.value) return zoneInput.value.trim();

    const zoneRow = [...document.querySelectorAll('.booking-summary .row')].find(row => (
      row.textContent.toLowerCase().includes('zone')
    ));
    const zoneResult = zoneRow ? zoneRow.querySelector('.result') : null;
    if (zoneResult && zoneResult.textContent.trim()) return zoneResult.textContent.trim();

    try {
      const url = new URL(window.location.href);
      return (url.searchParams.get('zone') || '').trim();
    } catch (err) {
      return '';
    }
  }

  function navigateBackToZoneSelection() {
    const zoneLink = document.querySelector('a[href*="zones.php"]');
    if (zoneLink && zoneLink.href) {
      window.location.href = zoneLink.href;
      return;
    }

    try {
      const paymentForm = document.getElementById('frmPayment');
      const actionUrl = paymentForm ? new URL(paymentForm.getAttribute('action'), window.location.href) : null;
      const query = actionUrl ? actionUrl.searchParams.get('query') : '';
      const rdId = document.querySelector('input[name="rdId"]')?.value || '';
      if (query && rdId) {
        window.location.href = `/booking/3m/zones.php?query=${encodeURIComponent(query)}&rdId=${encodeURIComponent(rdId)}`;
        return;
      }
    } catch (err) {
      // Fall through to browser history when page metadata is not available.
    }

    window.history.back();
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

    for (let el of candidates) {
      const seatName = getSeatNameFromElement(el);
      if (normalizeSeatRowName(getSeatRowName(seatName)) !== rowClean) continue;
      rowFound = true;

      if (isSeatOccupied(el) || clickedElements.has(el)) continue;

      clickSeatElement(el, seatName || rowName);
      return 'clicked';
    }

    return rowFound ? 'occupied' : 'not-found';
  }

  function tryClickExactSeat(seatName) {
    const seatClean = normalizeSeatName(seatName);

    const candidates = getSeatCandidates();

    for (let el of candidates) {
      const elSeat = normalizeSeatName(getSeatNameFromElement(el));

      if (elSeat !== seatClean) continue;
      if (isSeatOccupied(el)) return 'occupied';
      if (clickedElements.has(el)) return 'clicked';

      clickSeatElement(el, getSeatNameFromElement(el) || seatName);
      return 'clicked';
    }

    return 'not-found';
  }

  function findFirstAvailableSeat(excludedSeats) {
    const excluded = excludedSeats.map(normalizeSeatName);
    const seen = new Set();

    for (const el of getSeatCandidates()) {
      const seatName = getSeatNameFromElement(el);
      const normalized = normalizeSeatName(seatName);

      if (!isLikelySeatName(seatName) || excluded.includes(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);

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
      setTimeout(() => verifySeatClickResult(clickableEl, seatName, beforeSeatList), 1200);
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
        setTimeout(() => scheduleBookNowClick(attempt + 1), 500);
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
      sessionStorage.setItem(storageKey, String(now + delayMs + 500));
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
    }, delayMs);
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
})();
