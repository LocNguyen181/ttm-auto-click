const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const backgroundJs = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

test('background navigation logs only persist while the tool is active', () => {
  const writerStart = backgroundJs.indexOf('function appendNavEntry');
  const nextFunctionStart = backgroundJs.indexOf('\n\nconst TTM_URL_FILTER', writerStart);
  assert.notEqual(writerStart, -1, 'appendNavEntry should exist');
  assert.notEqual(nextFunctionStart, -1, 'appendNavEntry block should be bounded');

  const writerBlock = backgroundJs.slice(writerStart, nextFunctionStart);
  assert.match(writerBlock, /chrome\.storage\.local\.get\(\['isActive', NAV_LOG_KEY\]/);
  assert.match(writerBlock, /if \(result\.isActive !== true\) return;/);
  assert.match(writerBlock, /chrome\.storage\.local\.set\(\{ \[NAV_LOG_KEY\]: log \}\)/);
  assert.doesNotMatch(writerBlock, /chrome\.storage\.local\.remove/);
});
