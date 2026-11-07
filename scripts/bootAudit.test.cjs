'use strict';

// The boot audit must accept valid CommonJS files, including files whose
// strings or test names contain the word "import", and still report real errors.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkFile } = require('../lib/boot-audit.cjs');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('valid CommonJS test file with the word "import" in a name is accepted', (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'a.test.cjs'),
    "'use strict';\nconst test = require('node:test');\ntest('first import creates credentials', () => {});\n");
  assert.equal(checkFile(root, 'a.test.cjs'), null);
});

test('the repo session policy test file passes the audit', () => {
  const root = path.resolve(__dirname, '..');
  assert.equal(checkFile(root, 'scripts/sessionPolicy.test.cjs'), null);
});

test('a real syntax error in a CommonJS file is still reported', (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'broken.cjs'), 'const x = ;\n');
  assert.match(String(checkFile(root, 'broken.cjs')), /SyntaxError/);
});
