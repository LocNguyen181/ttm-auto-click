const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

test('popup exposes a manual Download Logs button', () => {
  assert.match(
    popupHtml,
    /id="downloadLogsBtn"/,
    'popup should include a manual log download button'
  );
  assert.match(
    popupHtml,
    />Download Logs</,
    'download button should have a clear label'
  );
});

test('manual Download Logs button exports logs without toggling automation', () => {
  assert.match(
    popupJs,
    /const downloadLogsBtn = document\.getElementById\('downloadLogsBtn'\);/,
    'popup script should read the manual log button'
  );
  assert.match(
    popupJs,
    /downloadLogsBtn\.addEventListener\('click', downloadLogsFromActiveTab\);/,
    'manual log button should ask the active tab to download live logs'
  );
  assert.match(
    popupJs,
    /chrome\.tabs\.sendMessage\(tab\.id, \{ type: 'downloadLogs' \}/,
    'popup should request a live log export from the content script'
  );
  assert.match(
    popupJs,
    /downloadStoredZoneLogs\(\);/,
    'popup should fall back to stored logs if the active tab cannot respond'
  );
  assert.match(
    popupJs,
    /response\.logCount === 0/,
    'popup should fall back to stored logs if the live tab has no entries'
  );
});
