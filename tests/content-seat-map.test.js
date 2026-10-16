const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const contentJs = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

test('content script never navigates or reloads the page', () => {
  assert.doesNotMatch(contentJs, /window\.location\.href\s*=/, 'must not assign window.location.href');
  assert.doesNotMatch(contentJs, /location\.(reload|replace|assign)\s*\(/, 'must not reload/replace/assign location');
  assert.doesNotMatch(contentJs, /history\.(back|go|forward)\s*\(/, 'must not move through browser history');
});

test('content script does not automate steps before the seat map', () => {
  for (const name of ['runNavigationLogic', 'handleQueuePage', 'handleVerifyPage', 'handleEnrollPage',
    'runEventPageClicker', 'handleBookingRoundAndZone', 'navigateBackToZoneSelection', 'handlePaymentPage']) {
    assert.doesNotMatch(contentJs, new RegExp(`function ${name}\b`), `${name} should be removed`);
  }
});

test('seat selection only starts once #tableseats is present', () => {
  const start = contentJs.indexOf('function checkForSeatMap');
  const end = contentJs.indexOf('\n  // ==================== SEAT SELECTION', start);
  assert.notEqual(start, -1, 'checkForSeatMap should exist');
  const block = contentJs.slice(start, end);
  assert.match(block, /document\.getElementById\('tableseats'\)/);
  assert.ok(block.indexOf("getElementById('tableseats')") < block.indexOf('handleSeatSelection()'),
    'seat map must be detected before seat selection runs');
});

test('a newly rendered seat map (user switched zone) gets a fresh selection pass', () => {
  assert.match(contentJs, /if \(seatTable === activeSeatTable\) return;/);
  assert.match(contentJs, /new MutationObserver\(\(mutations\) =>/, 'document observer should pick up seat maps rendered in place');
});

test('no available seat waits for the user instead of returning to zone selection', () => {
  const start = contentJs.indexOf('function handleSeatSelection');
  const end = contentJs.indexOf('\n  function trySeats', start);
  const block = contentJs.slice(start, end);
  assert.match(block, /no-matching-seat/);
  assert.match(block, /wait-for-user/);
});

test('HUD writes do not retrigger the page observer', () => {
  assert.match(contentJs, /hudRoot\.contains\(m\.target\)/);
  assert.match(contentJs, /function setTextIfChanged/);
});

test('content log download reports empty logs instead of exporting a blank file', () => {
  assert.match(contentJs, /return \{ ok: false, error: 'empty-log', logCount: 0 \};/);
  assert.match(contentJs, /script_instance=\$\{entry\.scriptInstanceId/);
});

test('tool switches itself off once a seat is selected and Book Now is handled', () => {
  const start = contentJs.indexOf('function scheduleBookNowClick');
  const end = contentJs.indexOf('\n  function findBookNowButton', start);
  const block = contentJs.slice(start, end);
  assert.ok(block.indexOf('dispatchPointerClickSequence(bookNowButton)') < block.indexOf("autoStop('seat-selected-book-now-clicked')"),
    'Book Now must be clicked before the tool stops');
  assert.match(block, /autoStop\('seat-selected-book-now-not-found'\)/);
  assert.match(block, /function autoStop[\s\S]*chrome\.storage\.local\.set\(\{ isActive: false \}\)/);
});
