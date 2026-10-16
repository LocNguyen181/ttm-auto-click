(function () {
  // Seat-map-only helper: the user handles navigation, queue, verification and
  // zone selection manually. The extension only acts once a seat map is on
  // screen, and it never navigates or reloads the page.
  const SCRIPT_INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let settings = {
    isActive: false,
    seatSelector: '',  // comma-separated row/seat priority list e.g. "AA, A, B12"
    excludedSeats: ''  // comma-separated seat names or rows to never select
  };

  const ZONE_CLICK_LOGS_KEY = 'ttmHelperZoneClickLogs';
  const LAST_ZONE_CLICK_AT_KEY = 'ttmHelperLastZoneClickAt';
  const MAX_LOG_ENTRIES = 500;
  const NO_SEAT_NOTICE_MS = 1500;
  const BOOK_NOW_MAX_ATTEMPTS = 20;
  const BOOK_NOW_RETRY_MS = 50;
  const ENABLE_CONSOLE_LOGS = true;

  let clickedElements = new WeakSet();
  let activeSeatTable = null;   // the #tableseats element currently being handled
  let seatObserver = null;      // watches activeSeatTable until a seat is selected
  let pageObserver = null;      // watches the document for a seat map to appear
  let pageCheckQueued = false;
  let noSeatNoticeTimer = null;
  let seatClickPending = false;
  let seatSelected = false;
  let bookNowClickPending = false;

  let logs = [];
  let lastLogAt = 0;
  let hudRoot = null;
  let hudStatusEl = null;
  let hudPageEl = null;
  let hudLogEl = null;
  let hudMessages = [];

  function debugLog(message, data) {
    if (ENABLE_CONSOLE_LOGS) {
      console.log('[TTM Helper]', message, data || '');
    }
  }

  function appendLog(status, details = {}) {
    const now = Date.now();
    logs.push({
      at: new Date(now).toISOString(),
      zone: getCurrentZoneName() || 'unknown',
      status,
      sincePrevMs: lastLogAt > 0 ? now - lastLogAt : null,
      scriptInstanceId: SCRIPT_INSTANCE_ID,
      url: window.location.href,
      pageType: getHudPageLabel(),
      readyState: document.readyState,
      ...details
    });
    lastLogAt = now;
    if (logs.length > MAX_LOG_ENTRIES) logs = logs.slice(-MAX_LOG_ENTRIES);
    chrome.storage.local.set({
      [ZONE_CLICK_LOGS_KEY]: logs,
      [LAST_ZONE_CLICK_AT_KEY]: lastLogAt
    });
  }

  // ==================== SETTINGS ====================
  chrome.storage.local.get(
    ['isActive', 'seatSelector', 'excludedSeats', ZONE_CLICK_LOGS_KEY, LAST_ZONE_CLICK_AT_KEY],
    (result) => {
      if (Array.isArray(result[ZONE_CLICK_LOGS_KEY])) logs = result[ZONE_CLICK_LOGS_KEY];
      lastLogAt = Number(result[LAST_ZONE_CLICK_AT_KEY]) || 0;
      updateSettings({
        isActive: result.isActive,
        seatSelector: result.seatSelector,
        excludedSeats: result.excludedSeats
      });
    }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const newSettings = {};
    ['isActive', 'seatSelector', 'excludedSeats'].forEach(key => {
      if (key in changes) newSettings[key] = changes[key].newValue;
    });
    if (Object.keys(newSettings).length > 0) updateSettings(newSettings);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'downloadLogs') return;
    sendResponse(downloadLogsFile());
  });

  function updateSettings(newSettings) {
    for (const key in newSettings) {
      if (newSettings[key] === undefined) delete newSettings[key];
    }
    const wasActive = settings.isActive;
    settings = { ...settings, ...newSettings };
    debugLog('Settings updated', settings);

    if (!settings.isActive) {
      stopWatching();
      updateHud();
      return;
    }

    // Re-activating (or changing priorities) on an already-open seat map
    // should run a fresh selection pass on that same map.
    if (!wasActive || !seatSelected) resetSeatMapState();
    startWatching();
    checkForSeatMap();
  }

  // ==================== SEAT MAP DETECTION ====================
  // The user picks a zone manually; TTM then renders the seat map in place.
  // Watch the document so each newly rendered seat map is picked up without
  // the extension ever triggering a navigation.
  function startWatching() {
    if (pageObserver) return;
    pageObserver = new MutationObserver((mutations) => {
      if (pageCheckQueued) return;
      if (hudRoot && mutations.every(m => hudRoot.contains(m.target))) return;
      pageCheckQueued = true;
      setTimeout(() => {
        pageCheckQueued = false;
        checkForSeatMap();
      }, 0);
    });
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopWatching() {
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
    resetSeatMapState();
  }

  function resetSeatMapState() {
    if (seatObserver) {
      seatObserver.disconnect();
      seatObserver = null;
    }
    clearTimeout(noSeatNoticeTimer);
    noSeatNoticeTimer = null;
    activeSeatTable = null;
    clickedElements = new WeakSet();
    seatClickPending = false;
    seatSelected = false;
    bookNowClickPending = false;
  }

  function checkForSeatMap() {
    updateHud();
    if (!settings.isActive) return;

    const seatTable = document.getElementById('tableseats');
    if (!seatTable) {
      if (activeSeatTable) {
        appendLog('seat-map-closed');
        resetSeatMapState();
      }
      return;
    }

    if (seatTable === activeSeatTable) return;

    // A new seat map (first one, or the user switched zone).
    resetSeatMapState();
    activeSeatTable = seatTable;
    appendLog('seat-map-detected', { nextAction: 'select-seat' });
    setHudMessage(`Seat map: ${getCurrentZoneName() || 'zone'}`);
    handleSeatSelection();
  }

  // ==================== SEAT SELECTION ====================
  function handleSeatSelection() {
    if (!settings.isActive || seatClickPending || seatSelected) return;
    if (!activeSeatTable || !document.contains(activeSeatTable)) return;

    if (hasSelectedSeat()) {
      seatSelected = true;
      appendLog('seat-already-selected', { seatlist: getSeatListValue(), nextAction: 'click-book-now' });
      scheduleBookNowClick();
      return;
    }

    if (trySeats()) return;

    // Seats may still be rendering — keep watching this seat map only.
    if (!seatObserver) {
      seatObserver = new MutationObserver(() => {
        if (seatClickPending || seatSelected) return;
        trySeats();
      });
      seatObserver.observe(activeSeatTable, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
      });
    }

    if (!noSeatNoticeTimer) {
      noSeatNoticeTimer = setTimeout(() => {
        noSeatNoticeTimer = null;
        if (seatClickPending || seatSelected || !activeSeatTable) return;
        appendLog('no-matching-seat', { nextAction: 'wait-for-user' });
        setHudMessage('No matching seat. Pick another zone.');
        debugLog('No selectable seat on this seat map. Waiting for user to choose another zone');
      }, NO_SEAT_NOTICE_MS);
    }
  }

  function trySeats() {
    const excludedSeatRules = getExcludedSeatRules();
    const seatPriorities = String(settings.seatSelector || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    for (const seatPriority of seatPriorities) {
      if (isSeatRuleExcluded(seatPriority, excludedSeatRules)) continue;
      const candidate = isLikelySeatRowName(seatPriority)
        ? findSeatInRow(seatPriority, excludedSeatRules)
        : findExactSeat(seatPriority, excludedSeatRules);
      if (candidate) {
        clickSeatElement(candidate.el, candidate.name);
        return true;
      }
    }

    const fallbackSeat = findFirstAvailableSeat(excludedSeatRules);
    if (fallbackSeat) {
      clickSeatElement(fallbackSeat.el, fallbackSeat.name);
      return true;
    }

    return false;
  }

  function findSeatInRow(rowName, excludedSeatRules) {
    const rowClean = normalizeSeatRowName(rowName);
    for (const el of getSeatCandidates()) {
      const seatName = getSeatNameFromElement(el);
      if (normalizeSeatRowName(getSeatRowName(seatName)) !== rowClean) continue;
      if (isSeatExcluded(seatName, excludedSeatRules)) continue;
      if (isSeatOccupied(el) || clickedElements.has(el)) continue;
      return { el, name: seatName || rowName };
    }
    return null;
  }

  function findExactSeat(seatName, excludedSeatRules) {
    const seatClean = normalizeSeatName(seatName);
    for (const el of getSeatCandidates()) {
      const elSeatName = getSeatNameFromElement(el);
      if (normalizeSeatName(elSeatName) !== seatClean) continue;
      if (isSeatExcluded(elSeatName, excludedSeatRules)) return null;
      if (isSeatOccupied(el) || clickedElements.has(el)) return null;
      return { el, name: elSeatName || seatName };
    }
    return null;
  }

  function findFirstAvailableSeat(excludedSeatRules) {
    for (const el of getSeatCandidates()) {
      const seatName = getSeatNameFromElement(el);
      if (!isLikelySeatName(seatName)) continue;
      if (isSeatExcluded(seatName, excludedSeatRules)) continue;
      if (isSeatOccupied(el) || clickedElements.has(el)) continue;
      return { el, name: seatName };
    }
    return null;
  }

  function getSeatCandidates() {
    return document.querySelectorAll(
      '#tableseats .seatuncheck[data-seat], #tableseats td:not(.not-available)[title] .seatuncheck, ' +
      '#tableseats td:not(.not-available)[title]'
    );
  }

  function clickSeatElement(el, seatName) {
    if (seatClickPending) return;
    const clickableEl = el.matches('.seatuncheck, [data-seat]') ? el : (el.querySelector('.seatuncheck, [data-seat]') || el);
    const beforeSeatList = getSeatListValue();

    seatClickPending = true;
    clickedElements.add(el);
    clickedElements.add(clickableEl);
    debugLog('Clicking seat', seatName);
    appendLog('seat-clicked', { seat: seatName, nextAction: 'verify-seat' });
    dispatchClickSequence(clickableEl);
    setTimeout(() => verifySeatClickResult(clickableEl, seatName, beforeSeatList), 0);
  }

  function verifySeatClickResult(clickedEl, seatName, beforeSeatList) {
    seatClickPending = false;
    if (!settings.isActive || !activeSeatTable || !document.contains(activeSeatTable)) return;

    const afterSeatList = getSeatListValue();
    if (isSeatSelected(clickedEl, seatName, beforeSeatList, afterSeatList)) {
      seatSelected = true;
      clearTimeout(noSeatNoticeTimer);
      noSeatNoticeTimer = null;
      if (seatObserver) {
        seatObserver.disconnect();
        seatObserver = null;
      }
      debugLog('Seat selected confirmed', { seatName, seatlist: afterSeatList });
      appendLog('seat-selected', { seat: seatName, seatlist: afterSeatList, nextAction: 'click-book-now' });
      setHudMessage(`Seat ${seatName} selected`);
      scheduleBookNowClick();
      return;
    }

    debugLog('Seat click did not select seat. Trying next seat', { seatName, beforeSeatList, afterSeatList });
    appendLog('seat-click-failed', { seat: seatName, nextAction: 'try-next-seat' });
    handleSeatSelection();
  }

  function scheduleBookNowClick(attempt = 0) {
    if (bookNowClickPending || !settings.isActive) return;

    const bookNowButton = findBookNowButton();
    if (!bookNowButton) {
      if (attempt < BOOK_NOW_MAX_ATTEMPTS) {
        setTimeout(() => scheduleBookNowClick(attempt + 1), BOOK_NOW_RETRY_MS);
      } else {
        appendLog('book-now-not-found', { nextAction: 'wait-for-user' });
        setHudMessage('Book Now button not found');
        autoStop('seat-selected-book-now-not-found');
      }
      return;
    }

    bookNowClickPending = true;
    debugLog('Clicking Book Now button');
    appendLog('book-now-clicked');
    setHudMessage('Book Now clicked');
    dispatchPointerClickSequence(bookNowButton);
    autoStop('seat-selected-book-now-clicked');
  }

  // Once a seat is held the job is done: switch the tool off so it does not
  // pick another seat on the next seat map the user opens.
  function autoStop(reason) {
    if (!settings.isActive) return;
    settings = { ...settings, isActive: false };
    debugLog('Auto-stopped after seat selection', reason);
    appendLog('auto-stopped', { reason, nextAction: 'none' });
    setHudMessage('Seat done. Tool stopped');
    stopWatching();
    chrome.storage.local.set({ isActive: false });
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

  function hasSelectedSeat() {
    if (getSeatListValue()) return true;
    return Boolean(document.querySelector(
      '#tableseats .seatcheck, #tableseats .seatchecked, #tableseats .seatselect, #tableseats .seatselected, ' +
      '#tableseats [class*="selected"], #tableseats [class*="checked"]'
    ));
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

  // ==================== SEAT RULES ====================
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

  function isSeatExcluded(seatName, excludedSeatRules) {
    const normalizedSeat = normalizeSeatName(seatName);
    if (!normalizedSeat) return false;
    if (excludedSeatRules.exactSeats.has(normalizedSeat)) return true;

    const seatRow = normalizeSeatRowName(getSeatRowName(seatName));
    return Boolean(seatRow) && excludedSeatRules.rows.has(seatRow);
  }

  function isSeatRuleExcluded(seatRule, excludedSeatRules) {
    if (isLikelySeatRowName(seatRule) && !isLikelySeatName(seatRule)) {
      return excludedSeatRules.rows.has(normalizeSeatRowName(seatRule));
    }

    return isSeatExcluded(seatRule, excludedSeatRules);
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

  function getCurrentZoneName() {
    const candidates = [
      document.querySelector('input[name="zoneDesc"]')?.value,
      document.querySelector('input[name="zone"]')?.value
    ];

    const zoneRow = [...document.querySelectorAll('.booking-summary .row')].find(row => (
      row.textContent.toLowerCase().includes('zone')
    ));
    const zoneResult = zoneRow ? zoneRow.querySelector('.result') : null;
    if (zoneResult?.textContent?.trim()) candidates.push(zoneResult.textContent.trim());

    try {
      candidates.push(new URL(window.location.href).searchParams.get('zone'));
    } catch (err) {
      // Ignore malformed URLs.
    }

    for (const candidate of candidates) {
      const zone = String(candidate || '').trim();
      if (zone) return zone;
    }
    return '';
  }

  // ==================== HUD ====================
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

    // Only touch the DOM when content changes, otherwise the page observer
    // would see our own HUD writes and re-trigger checkForSeatMap forever.
    setHtmlIfChanged(hudStatusEl, `Status: <strong style="color:${settings.isActive ? '#10b981' : '#ef4444'}">${settings.isActive ? 'Active' : 'Inactive'}</strong>`);
    setTextIfChanged(hudPageEl, `Page: ${getHudPageLabel()}`);
    setTextIfChanged(hudLogEl, hudMessages.length > 0
      ? `Log: ${hudMessages.join(' · ')}`
      : 'Log: Waiting for seat map');
  }

  function setHtmlIfChanged(el, html) {
    if (el.dataset.html === html) return;
    el.dataset.html = html;
    el.innerHTML = html;
  }

  function setTextIfChanged(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function getHudPageLabel() {
    return document.getElementById('tableseats') ? 'Seat Map' : 'Waiting (manual)';
  }

  function setHudMessage(message) {
    hudMessages.unshift(message);
    hudMessages = hudMessages.slice(0, 3);
    updateHud();
  }

  // ==================== LOG EXPORT ====================
  function downloadLogsFile() {
    try {
      if (logs.length === 0) {
        return { ok: false, error: 'empty-log', logCount: 0 };
      }

      const lines = [
        'TTM Helper Seat Log',
        `generated_at=${new Date().toISOString()}`,
        `page=${window.location.href}`,
        `entries=${logs.length}`,
        ''
      ];

      logs.forEach((entry, index) => {
        lines.push(
          `${index + 1}. at=${entry.at} | zone=${entry.zone} | status=${entry.status} | since_prev_ms=${entry.sincePrevMs === null ? 'first-click' : entry.sincePrevMs} | script_instance=${entry.scriptInstanceId || ''} | page_type=${entry.pageType || ''} | ready_state=${entry.readyState || ''} | next_action=${entry.nextAction || ''} | url=${entry.url || ''} | details=${formatLogDetails(entry)}`
        );
      });

      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = objectUrl;
      link.download = `ttm-helper-seat-log-${timestamp}.log`;
      link.style.display = 'none';
      (document.body || document.documentElement).appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

      return { ok: true, entries: lines.length, logCount: logs.length };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  function formatLogDetails(entry) {
    const hiddenKeys = new Set([
      'at', 'zone', 'status', 'sincePrevMs', 'scriptInstanceId',
      'url', 'pageType', 'readyState', 'nextAction'
    ]);
    const details = {};
    Object.keys(entry || {}).forEach(key => {
      if (!hiddenKeys.has(key)) details[key] = entry[key];
    });
    return Object.keys(details).length > 0 ? JSON.stringify(details) : '';
  }

  // ==================== HELPERS ====================
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
    document.addEventListener('DOMContentLoaded', checkForSeatMap);
  } else {
    checkForSeatMap();
  }
})();
