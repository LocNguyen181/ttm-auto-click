const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const contentJs = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

test('zone map fallback does not scan broad SVG/div candidates across the whole document', () => {
  const match = contentJs.match(/function getCachedMapZoneCandidates\(\) \{[\s\S]*?document\.querySelectorAll\(\s*([\s\S]*?)\s*\)[\s\S]*?return cachedMapZoneCandidates;/);

  assert.ok(match, 'getCachedMapZoneCandidates should exist');
  const selectorBlock = match[1];

  assert.doesNotMatch(selectorBlock, /(^|[^.\w-])div([^.\w-]|$)/, 'fallback selector should not scan all div elements');
  assert.doesNotMatch(selectorBlock, /(^|[^.\w-])rect([^.\w-]|$)/, 'fallback selector should not scan all rect elements');
  assert.doesNotMatch(selectorBlock, /(^|[^.\w-])path([^.\w-]|$)/, 'fallback selector should not scan all path elements');
});

test('zone selection falls back quickly when availability table is missing', () => {
  const waitMatch = contentJs.match(/const MAX_AVAILABILITY_WAIT_MS = (\d+);/);

  assert.ok(waitMatch, 'MAX_AVAILABILITY_WAIT_MS should be defined');
  assert.ok(Number(waitMatch[1]) <= 3000, 'availability wait should be short enough to keep zone auto-click responsive');
});

test('zone click verification requires real seat-map evidence instead of fixed.php URL alone', () => {
  const verifyStart = contentJs.indexOf('function verifyZoneClickResult');
  const nextFunctionStart = contentJs.indexOf('\n  function downloadZoneLogsFile', verifyStart);

  assert.notEqual(verifyStart, -1, 'verifyZoneClickResult should exist');
  assert.notEqual(nextFunctionStart, -1, 'verifyZoneClickResult block should be followed by downloadZoneLogsFile');
  const verifyBlock = contentJs.slice(verifyStart, nextFunctionStart);
  assert.match(
    verifyBlock,
    /hasSeatPageEvidence\(\)/,
    'zone click verification should confirm the seat map actually rendered'
  );
  assert.doesNotMatch(
    verifyBlock,
    /if \(\s*isSeatPage\(\)\s*\)/,
    'fixed.php URL alone should not make zone click verification succeed'
  );
});

test('fixed.php without a rendered seat map eventually skips the attempted zone', () => {
  const timeoutConstant = contentJs.match(/const SEAT_MAP_LOAD_TIMEOUT_MS = (\d+);/);
  const scheduleStart = contentJs.indexOf('function scheduleBackToZoneIfNoSeats');
  const nextFunctionStart = contentJs.indexOf('\n  function isSeatPage', scheduleStart);

  assert.ok(timeoutConstant, 'SEAT_MAP_LOAD_TIMEOUT_MS should be defined');
  assert.ok(Number(timeoutConstant[1]) <= 3500, 'seat-map load timeout should be short enough to avoid fixed.php loops');
  assert.notEqual(scheduleStart, -1, 'scheduleBackToZoneIfNoSeats should exist');
  assert.notEqual(nextFunctionStart, -1, 'scheduleBackToZoneIfNoSeats block should be followed by isSeatPage');

  const scheduleBlock = contentJs.slice(scheduleStart, nextFunctionStart);
  assert.match(
    scheduleBlock,
    /isSeatTransitionPage\(\)/,
    'fixed.php transition pages should be handled separately from rendered seat maps'
  );
  assert.match(
    scheduleBlock,
    /seat-map-timeout-skip-zone/,
    'seat-map timeout should be logged before returning to zone selection'
  );
  assert.doesNotMatch(
    scheduleBlock,
    /if \(!isSeatMapLoaded\(\)\) return;/,
    'missing seat map on fixed.php should not silently stop the skip timer'
  );
});

test('hash-only fixed.php navigation re-runs automation routing', () => {
  assert.match(
    contentJs,
    /addEventListener\('hashchange',\s*runAutomationCycleSoon\)/,
    'hash changes such as #fixed.php#A1 should re-run automation routing'
  );
});

test('zone attempts are persisted until seat map success or skip', () => {
  assert.match(
    contentJs,
    /const PENDING_ZONE_ATTEMPT_KEY = 'ttmHelperPendingZoneAttempt';/,
    'pending zone attempt should have a storage key'
  );
  assert.match(
    contentJs,
    /persistPendingZoneAttempt\(zoneName\)/,
    'clicking a zone should persist the pending attempt'
  );
  assert.match(
    contentJs,
    /handlePendingZoneAttemptTimeout\(\)/,
    'automation should check pending zone timeouts'
  );
  assert.match(
    contentJs,
    /clearPendingZoneAttempt\(\)/,
    'successful seat map detection or skip should clear pending zone attempts'
  );
});

test('clicked zones are immediately excluded from future retries in the same booking attempt', () => {
  const clickStart = contentJs.indexOf('function clickZoneElement');
  const nextFunctionStart = contentJs.indexOf('\n  function verifyZoneClickResult', clickStart);

  assert.notEqual(clickStart, -1, 'clickZoneElement should exist');
  assert.notEqual(nextFunctionStart, -1, 'clickZoneElement block should be followed by verifyZoneClickResult');

  const clickBlock = contentJs.slice(clickStart, nextFunctionStart);
  assert.match(
    clickBlock,
    /markZoneSkipped\(zoneName\)/,
    'attempted zones should be skipped immediately so failed transitions cannot click the same priority zone again'
  );
});

test('leaving booking temporarily does not clear skipped zones during an active booking attempt', () => {
  assert.match(
    contentJs,
    /if \(!hasActiveBookingAttempt\(\)\) clearSkippedZones\(\);/,
    'main-site automation should preserve skipped zones while a booking attempt is active'
  );
});

test('zone navigation prefers a reconstructed zones.php URL before browser history fallback', () => {
  const navStart = contentJs.indexOf('function navigateBackToZoneSelection');
  const nextFunctionStart = contentJs.indexOf('\n  function getSkippedZones', navStart);

  assert.notEqual(navStart, -1, 'navigateBackToZoneSelection should exist');
  assert.notEqual(nextFunctionStart, -1, 'navigateBackToZoneSelection block should be followed by getSkippedZones');

  const navBlock = contentJs.slice(navStart, nextFunctionStart);
  assert.match(
    navBlock,
    /buildZoneSelectionUrl\(\)/,
    'navigation should reconstruct zones.php when possible'
  );
  assert.match(
    navBlock,
    /window\.history\.back\(\)/,
    'history fallback can remain as the last resort'
  );
  assert.ok(
    navBlock.indexOf('buildZoneSelectionUrl()') < navBlock.indexOf('window.history.back()'),
    'reconstructed zones.php URL should be attempted before history.back()'
  );
});

test('zone scan logs decision state for diagnosing repeated priority clicks', () => {
  assert.match(
    contentJs,
    /const SCRIPT_INSTANCE_ID = /,
    'content script should stamp logs with a script instance id'
  );
  assert.match(
    contentJs,
    /appendZoneClickLog\('scan-state', 'zone-scan-state'/,
    'zone selection should log scan state before trying priorities'
  );
  assert.match(contentJs, /skippedZones/, 'zone scan state should include skipped zones');
  assert.match(contentJs, /pendingAttempt/, 'zone scan state should include pending attempts');
  assert.match(contentJs, /lastAttemptedZone/, 'zone scan state should include last attempted zone');
  assert.match(contentJs, /script_instance=\$\{entry\.scriptInstanceId/, 'downloaded logs should include script instance id');
  assert.match(contentJs, /details=\$\{formatZoneLogDetails\(entry\)\}/, 'downloaded logs should include extra diagnostic details');
});

test('content zone log download does not clear diagnostic logs after export', () => {
  const downloadStart = contentJs.indexOf('function downloadZoneLogsFile');
  const nextFunctionStart = contentJs.indexOf('\n  function formatZoneLogDetails', downloadStart);

  assert.notEqual(downloadStart, -1, 'downloadZoneLogsFile should exist');
  assert.notEqual(nextFunctionStart, -1, 'downloadZoneLogsFile block should be followed by formatZoneLogDetails');

  const downloadBlock = contentJs.slice(downloadStart, nextFunctionStart);
  assert.doesNotMatch(
    downloadBlock,
    /clearZoneLogsStorage\(\)/,
    'downloading logs should not clear diagnostic history automatically'
  );
});

test('content zone log download reports empty logs instead of exporting a blank file', () => {
  const downloadStart = contentJs.indexOf('function downloadZoneLogsFile');
  const nextFunctionStart = contentJs.indexOf('\n  function formatZoneLogDetails', downloadStart);

  assert.notEqual(downloadStart, -1, 'downloadZoneLogsFile should exist');
  assert.notEqual(nextFunctionStart, -1, 'downloadZoneLogsFile block should be followed by formatZoneLogDetails');

  const downloadBlock = contentJs.slice(downloadStart, nextFunctionStart);
  assert.match(
    downloadBlock,
    /if \(zoneClickLogs\.length === 0\) \{\s*return \{ ok: false, error: 'empty-log', logCount: 0 \};\s*\}/,
    'content export should let popup fallback when live tab logs are empty'
  );
  assert.match(
    downloadBlock,
    /return \{ ok: true, entries: lines\.length, logCount: zoneClickLogs\.length \};/,
    'content export should report how many log entries were exported'
  );
});

test('content zone log download waits for pending zone timeout before exporting', () => {
  assert.match(
    contentJs,
    /downloadZoneLogsWhenReady\(\)\.then\(sendResponse\);/,
    'download log message should wait for pending zone attempts before responding'
  );
  assert.match(
    contentJs,
    /return true;/,
    'download log message listener should keep sendResponse alive for async export'
  );
  assert.match(
    contentJs,
    /function getZoneLogExportDelayMs\(\)/,
    'content script should calculate whether live log export needs to wait'
  );
  assert.match(
    contentJs,
    /SEAT_MAP_LOAD_TIMEOUT_MS \+ AVAILABILITY_WAIT_POLL_MS/,
    'smart export should wait past the seat-map timeout boundary'
  );
});
