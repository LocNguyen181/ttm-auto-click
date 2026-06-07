const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const popupJs = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

test('popup zone log export preserves script instance and diagnostic details', () => {
  assert.match(
    popupJs,
    /script_instance=\$\{entry\.scriptInstanceId/,
    'popup log export should include script instance id'
  );
  assert.match(
    popupJs,
    /details=\$\{formatZoneLogDetails\(entry\)\}/,
    'popup log export should include diagnostic detail fields'
  );
  assert.match(
    popupJs,
    /function formatZoneLogDetails\(entry\)/,
    'popup should format extra zone log fields'
  );
});

test('popup zone log export does not clear logs after download', () => {
  const downloadStart = popupJs.indexOf('function downloadStoredZoneLogs');
  const nextFunctionStart = popupJs.indexOf('\n  function formatZoneLogDetails', downloadStart);

  assert.notEqual(downloadStart, -1, 'downloadStoredZoneLogs should exist');
  assert.notEqual(nextFunctionStart, -1, 'downloadStoredZoneLogs block should be followed by formatZoneLogDetails');

  const downloadBlock = popupJs.slice(downloadStart, nextFunctionStart);
  assert.doesNotMatch(
    downloadBlock,
    /chrome\.storage\.local\.remove/,
    'exporting logs should not delete them before the next scan can be captured'
  );
});
