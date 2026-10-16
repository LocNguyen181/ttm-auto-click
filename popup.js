document.addEventListener('DOMContentLoaded', () => {
  const ZONE_CLICK_LOGS_KEY = 'ttmHelperZoneClickLogs';
  const NAV_LOG_KEY = 'ttmHelperNavLog';
  const seatSelectorInput = document.getElementById('seatSelector');
  const excludedSeatsInput = document.getElementById('excludedSeats');
  const activeToggle = document.getElementById('activeToggle');
  const statusText = document.getElementById('statusText');
  const downloadLogsBtn = document.getElementById('downloadLogsBtn');
  const downloadNavLogBtn = document.getElementById('downloadNavLogBtn');

  let isActive = false;

  // Load saved configurations
  chrome.storage.local.get(['isActive', 'seatSelector', 'excludedSeats'], (result) => {
    isActive = result.isActive || false;
    seatSelectorInput.value = result.seatSelector || '';
    excludedSeatsInput.value = result.excludedSeats || '';
    updateUI();
  });

  // The content script switches itself off after a seat is selected.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('isActive' in changes)) return;
    isActive = changes.isActive.newValue === true;
    updateUI();
  });

  function updateUI() {
    activeToggle.checked = isActive;
    statusText.textContent = isActive ? 'Active' : 'Inactive';
  }

  function saveSettings(callback) {
    chrome.storage.local.set({
      seatSelector: seatSelectorInput.value.trim(),
      excludedSeats: excludedSeatsInput.value.trim()
    }, callback);
  }

  // Bind input events for auto-saving
  [seatSelectorInput, excludedSeatsInput].forEach(input => input.addEventListener('input', () => saveSettings()));

  // Activating never navigates: the user drives the site, the bot only acts on the seat map.
  function setActive(nextIsActive) {
    isActive = nextIsActive;
    saveSettings(() => {
      chrome.storage.local.set({ isActive }, updateUI);
    });
  }

  function downloadLogsFromActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        downloadStoredZoneLogs();
        return;
      }

      chrome.tabs.sendMessage(tab.id, { type: 'downloadLogs' }, (response) => {
        if (chrome.runtime.lastError || !response?.ok || response.logCount === 0) {
          downloadStoredZoneLogs();
        }
      });
    });
  }

  function downloadStoredZoneLogs() {
    chrome.storage.local.get([ZONE_CLICK_LOGS_KEY], (result) => {
      const entries = Array.isArray(result[ZONE_CLICK_LOGS_KEY]) ? result[ZONE_CLICK_LOGS_KEY] : [];
      const lines = [
        'TTM Helper Seat Log',
        `generated_at=${new Date().toISOString()}`,
        `entries=${entries.length}`,
        ''
      ];

      entries.forEach((entry, index) => {
        lines.push(
          `${index + 1}. at=${entry.at || ''} | zone=${entry.zone || 'unknown'} | status=${entry.status || 'unknown'} | since_prev_ms=${entry.sincePrevMs == null ? 'first-click' : entry.sincePrevMs} | script_instance=${entry.scriptInstanceId || ''} | page_type=${entry.pageType || ''} | ready_state=${entry.readyState || ''} | next_action=${entry.nextAction || ''} | click_result=${entry.clickResult || ''} | url=${entry.url || ''} | details=${formatZoneLogDetails(entry)}`
        );
      });

      if (entries.length === 0) {
        lines.push('No seat logs recorded in this session.');
      }

      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = objectUrl;
      link.download = `ttm-helper-seat-log-${timestamp}.log`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

    });
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

  function downloadNavLog() {
    chrome.storage.local.get([NAV_LOG_KEY], (result) => {
      const entries = Array.isArray(result[NAV_LOG_KEY]) ? result[NAV_LOG_KEY] : [];
      const lines = [
        'TTM Helper Navigation Log',
        `generated_at=${new Date().toISOString()}`,
        `entries=${entries.length}`,
        ''
      ];

      if (entries.length === 0) {
        lines.push('No navigation events recorded. Make sure the extension was reloaded after the last update.');
      } else {
        entries.forEach((entry, index) => {
          const parts = [
            `${index + 1}.`,
            `at=${entry.at || ''}`,
            `type=${entry.type || ''}`,
            `tabId=${entry.tabId ?? ''}`,
            `transition=${entry.transitionType || ''}`,
            `qualifiers=${entry.qualifiers || ''}`,
            `error=${entry.error || ''}`,
            `url=${entry.url || ''}`
          ];
          lines.push(parts.filter(p => !p.endsWith('=')).join(' | '));
        });
      }

      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = objectUrl;
      link.download = `ttm-helper-nav-log-${timestamp}.log`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    });
  }

  activeToggle.addEventListener('change', () => setActive(activeToggle.checked));
  downloadLogsBtn.addEventListener('click', downloadLogsFromActiveTab);
  downloadNavLogBtn.addEventListener('click', downloadNavLog);
});
