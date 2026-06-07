document.addEventListener('DOMContentLoaded', () => {
  const ZONE_CLICK_LOGS_KEY = 'ttmHelperZoneClickLogs';
  const LAST_ZONE_CLICK_AT_KEY = 'ttmHelperLastZoneClickAt';
  const targetUrlInput = document.getElementById('targetUrl');
  const targetDateInput = document.getElementById('targetDate');
  const targetTimeInput = document.getElementById('targetTime');
  const zoneChoicesContainer = document.getElementById('zoneChoices');
  const zonePriorityInput = document.getElementById('zonePriorityInput');
  const seatSelectorInput = document.getElementById('seatSelector');
  const excludedZonesInput = document.getElementById('excludedZones');
  const excludedSeatsInput = document.getElementById('excludedSeats');
  
  const autoNavigateCheckbox = document.getElementById('autoNavigate');
  const autoClickCheckbox = document.getElementById('autoClick');
  const activeToggle = document.getElementById('activeToggle');
  const statusText = document.getElementById('statusText');
  const downloadLogsBtn = document.getElementById('downloadLogsBtn');

  const scanZonesBtn = document.getElementById('scanZonesBtn');
  const scannedZonesContainer = document.getElementById('scannedZonesContainer');

  let isActive = false;
  let scannedZones = [];
  let selectedZones = [];

  function normalizeZoneName(value) {
    return (value || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/^#/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isValidZoneName(value) {
    const zone = normalizeZoneName(value).toUpperCase();
    return zone === 'VIP' || /^[A-Z]{1,4}\d{0,3}$/.test(zone);
  }

  function filterZoneList(zones) {
    const normalizedZones = (Array.isArray(zones) ? zones : [])
      .map(normalizeZoneName)
      .filter(isValidZoneName);

    return normalizedZones.filter((zone, index, list) => (
      list.findIndex(item => item.toLowerCase() === zone.toLowerCase()) === index
    ));
  }

  // Load saved configurations
  chrome.storage.local.get(
    [
      'isActive', 
      'targetUrl', 
      'targetDate',
      'targetTime',
      'zoneSelector',
      'scannedZones',
      'seatSelector',
      'excludedZones',
      'excludedSeats',
      'autoNavigate', 
      'autoClick'
    ],
    (result) => {
      isActive = result.isActive || false;
      targetUrlInput.value = result.targetUrl || '';
      targetDateInput.value = result.targetDate || '';
      targetTimeInput.value = result.targetTime || '';
      scannedZones = filterZoneList(result.scannedZones);
      selectedZones = filterZoneList((result.zoneSelector || '').split(','))
        .map(zone => zone.toUpperCase() === 'VIP' ? 'VIP' : zone.toUpperCase());
      renderZoneTags();
      seatSelectorInput.value = result.seatSelector || '';
      excludedZonesInput.value = result.excludedZones || '';
      excludedSeatsInput.value = result.excludedSeats || '';
      
      autoNavigateCheckbox.checked = result.autoNavigate !== false;
      autoClickCheckbox.checked = result.autoClick !== false;

      updateUI();
      saveSettings();
      scanPageZones(true);
    }
  );

  function updateUI() {
    activeToggle.checked = isActive;
    if (isActive) {
      statusText.textContent = 'Active';
    } else {
      statusText.textContent = 'Inactive';
    }
  }

  function saveSettings() {
    chrome.storage.local.set({
      targetUrl: targetUrlInput.value.trim(),
      targetDate: targetDateInput.value.trim(),
      targetTime: targetTimeInput.value.trim(),
      zoneSelector: selectedZones.join(', '),
      scannedZones,
      seatSelector: seatSelectorInput.value.trim(),
      excludedZones: excludedZonesInput.value.trim(),
      excludedSeats: excludedSeatsInput.value.trim(),
      autoNavigate: autoNavigateCheckbox.checked,
      autoClick: autoClickCheckbox.checked,
    });
  }

  // Bind input events for auto-saving
  const inputsToSave = [
    targetUrlInput, 
    targetDateInput, 
    targetTimeInput, 
    seatSelectorInput,
    excludedZonesInput,
    excludedSeatsInput
  ];
  inputsToSave.forEach(input => input.addEventListener('input', saveSettings));

  autoNavigateCheckbox.addEventListener('change', saveSettings);
  autoClickCheckbox.addEventListener('change', saveSettings);

  function setActive(nextIsActive) {
    const wasActive = isActive;
    isActive = nextIsActive;
    chrome.storage.local.set({ isActive }, () => {
      updateUI();
      saveSettings();
      if (isActive && autoNavigateCheckbox.checked && targetUrlInput.value.trim()) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            chrome.tabs.update(tabs[0].id, { url: targetUrlInput.value.trim() });
          }
        });
      } else if (wasActive && !isActive) {
        downloadStoredZoneLogs();
      }
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
        'TTM Helper Zone Log',
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
        lines.push('No zone click logs recorded in this session.');
      }

      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = objectUrl;
      link.download = `ttm-helper-zone-log-${timestamp}.log`;
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

  activeToggle.addEventListener('change', () => setActive(activeToggle.checked));
  downloadLogsBtn.addEventListener('click', downloadLogsFromActiveTab);

  // Scan Zones from active tab
  scanZonesBtn.addEventListener('click', () => scanPageZones(false));
  zonePriorityInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
      if (zonePriorityInput.value.trim()) {
        event.preventDefault();
        addZoneTagsFromText(zonePriorityInput.value);
      }
    } else if (event.key === 'Backspace' && !zonePriorityInput.value && selectedZones.length > 0) {
      selectedZones.pop();
      renderZoneTags();
      saveSettings();
    }
  });
  zonePriorityInput.addEventListener('blur', () => addZoneTagsFromText(zonePriorityInput.value));
  zonePriorityInput.addEventListener('paste', (event) => {
    event.preventDefault();
    addZoneTagsFromText(event.clipboardData.getData('text'));
  });

  function scanPageZones(isAutoScan) {
    if (!isAutoScan) {
      scanZonesBtn.textContent = 'Scanning...';
      scanZonesBtn.classList.add('loading');
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        scanZonesBtn.textContent = 'Scan Page Zones';
        scanZonesBtn.classList.remove('loading');
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id, allFrames: true },
        func: () => {
          const zoneMap = new Map();
          const availabilityZoneMap = new Map();

          const normalizeZone = (value) => {
            return (value || '')
              .replace(/&nbsp;/gi, ' ')
              .replace(/^#/, '')
              .replace(/\s+/g, ' ')
              .trim();
          };

          const looksLikeZone = (value) => {
            const zone = normalizeZone(value).toUpperCase();
            return zone === 'VIP' || /^[A-Z]{1,4}\d{1,3}$/.test(zone);
          };

          const addZone = (value) => {
            const zone = normalizeZone(value);
            if (!looksLikeZone(zone)) return;
            const key = zone.toLowerCase();
            if (!zoneMap.has(key)) zoneMap.set(key, zone);
          };

          const addAvailableZone = (zone, seatsAvailable) => {
            const seatCount = parseInt(String(seatsAvailable || '').replace(/[^\d]/g, ''), 10);
            if (Number.isNaN(seatCount) || seatCount <= 0) return;
            const normalizedZone = normalizeZone(zone);
            addZone(normalizedZone);
            if (looksLikeZone(normalizedZone)) {
              availabilityZoneMap.set(normalizedZone.toLowerCase(), normalizedZone);
            }
          };

          const addZoneFromHref = (href) => {
            const matches = (href || '').match(/#([^#\s]+)/g) || [];
            if (matches.length === 0) return;
            addZone(matches[matches.length - 1].replace(/^#/, ''));
          };

          const scanAvailabilityTable = () => {
            document.querySelectorAll('#avail_data table tbody tr, #popup-event-zone table tbody tr').forEach(row => {
              const cells = row.querySelectorAll('td');
              if (cells.length < 2) return;

              const zoneCell = cells[0];
              const seatsCell = cells[1];
              const zoneFromLink = zoneCell.querySelector('a[id]')?.id;
              const zoneFromText = zoneCell.textContent;
              const onclick = row.getAttribute('onclick') || '';
              const onclickMatch = onclick.match(/gonextstep\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/i);
              const zone = onclickMatch?.[1] || zoneFromLink || zoneFromText;

              addAvailableZone(zone, seatsCell.textContent);
            });
          };

          // 1. Scan image-map zones. TTM often uses <area href="#A1"> or JS handlers.
          document.querySelectorAll('.map-zone area[href], .select-zone area[href], map area[href]').forEach(el => {
            addZoneFromHref(el.getAttribute('href'));
            addZone(el.getAttribute('data-zone'));
            addZone(el.getAttribute('data-zone-id'));
            addZone(el.getAttribute('data-zone-label'));
          });

          // 2. Scan explicit zone attributes only inside zone/map containers.
          document.querySelectorAll(
            '.map-zone [data-zone], .map-zone [data-zone-id], .map-zone [data-zone-label], ' +
            '.select-zone [data-zone], .select-zone [data-zone-id], .select-zone [data-zone-label], ' +
            '#avail_data table tbody tr, #popup-event-zone table tbody tr'
          ).forEach(el => {
            addZone(el.getAttribute('data-zone'));
            addZone(el.getAttribute('data-zone-id'));
            addZone(el.getAttribute('data-zone-label'));
          });

          // 3. Use availability table only if it is already present. Do not open Seats Available.
          scanAvailabilityTable();

          const sourceMap = availabilityZoneMap.size > 0 ? availabilityZoneMap : zoneMap;
          return [...sourceMap.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        }
      }, (results) => {
        scanZonesBtn.textContent = 'Scan Page Zones';
        scanZonesBtn.classList.remove('loading');

        if (chrome.runtime.lastError) {
          scannedZonesContainer.style.display = 'block';
          scannedZonesContainer.innerHTML = `<span class="help-text">${chrome.runtime.lastError.message}</span>`;
          return;
        }

        const zones = filterZoneList((results || [])
          .flatMap(frameResult => Array.isArray(frameResult.result) ? frameResult.result : [])
        )
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        if (zones.length > 0) {
          scannedZones = zones;
          renderZoneTags();
          if (!isAutoScan || scannedZonesContainer.style.display !== 'none') {
            renderScannedZonesStatus(zones);
          }
          saveSettings();
        } else if (!isAutoScan) {
          scannedZonesContainer.style.display = 'block';
          scannedZonesContainer.innerHTML = '<span class="help-text">No zones found. Make sure you are on a booking page with a zone map.</span>';
        }
      });
    });
  }

  function renderZoneTags() {
    [...zoneChoicesContainer.querySelectorAll('.zone-choice')].forEach(el => el.remove());

    selectedZones.forEach((zone, index) => {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'zone-choice selected';
      tag.dataset.zone = zone;
      const isMatched = scannedZones.length === 0 || scannedZones.some(scannedZone => scannedZone.toLowerCase() === zone.toLowerCase());
      if (!isMatched) tag.classList.add('unmatched');
      tag.title = isMatched ? 'Click to remove' : 'Not found in scanned zones. Click to remove';
      tag.textContent = `${index + 1}. ${zone} ×`;
      tag.addEventListener('click', () => removeZoneTag(zone));
      zoneChoicesContainer.insertBefore(tag, zonePriorityInput);
    });

    zonePriorityInput.disabled = false;
    zonePriorityInput.placeholder = 'Type zone and press Enter';
  }

  function addZoneTagsFromText(text) {
    const zones = filterZoneList(String(text || '').split(/[\s,]+/));
    if (zones.length === 0) {
      zonePriorityInput.value = '';
      return;
    }

    zones.forEach(zone => {
      if (selectedZones.some(item => item.toLowerCase() === zone.toLowerCase())) return;
      selectedZones.push(zone.toUpperCase() === 'VIP' ? 'VIP' : zone.toUpperCase());
    });

    zonePriorityInput.value = '';
    renderZoneTags();
    if (scannedZones.length > 0) renderScannedZonesStatus(scannedZones);
    saveSettings();
  }

  function removeZoneTag(zone) {
    selectedZones = selectedZones.filter(item => item.toLowerCase() !== zone.toLowerCase());
    renderZoneTags();
    if (scannedZones.length > 0) renderScannedZonesStatus(scannedZones);
    saveSettings();
    zonePriorityInput.focus();
  }

  function renderScannedZonesStatus(zones) {
    scannedZonesContainer.innerHTML = '';
    scannedZonesContainer.style.display = 'flex';

    if (zones.length === 0) {
      scannedZonesContainer.innerHTML = '<span class="help-text">No zones detected.</span>';
      return;
    }

    const selectedZoneKeys = selectedZones.map(zone => zone.toLowerCase());
    zones.forEach(zone => {
      const badge = document.createElement('span');
      badge.className = 'zone-badge';
      badge.textContent = zone;
      badge.dataset.zone = zone;

      if (selectedZoneKeys.includes(zone.toLowerCase())) {
        badge.classList.add('selected');
      }

      scannedZonesContainer.appendChild(badge);
    });
  }
});
