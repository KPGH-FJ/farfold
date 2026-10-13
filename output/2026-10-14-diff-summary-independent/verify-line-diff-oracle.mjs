// Independent, output-only challenge. Does not invoke Vitest, App, Agent or IO helpers.
// Execute only after coordinating with the frontend owner and root.
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root = '/Users/tw/Desktop/farfold';
const sourcePath = `${root}/src/runtime/line_diff.ts`;
const require = createRequire(`${root}/package.json`);
const ts = require('typescript');
const bytes = fs.readFileSync(sourcePath);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceSha256 = sha(bytes);
const transpiled = ts.transpileModule(bytes.toString('utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText;
const api = {};
vm.runInNewContext(transpiled, { exports: api }, { filename: sourcePath, timeout: 1000 });
const plain = value => JSON.parse(JSON.stringify(value));
const checks = [];
function check(name, body) {
  body();
  checks.push({ name, passed: true });
}

// Expected tokens and end markers are authored here, not taken from the parser.
const manual = [
  { name: 'mixed-terminators-lone-cr', text: 'a\r\nb\nc\rd', rows: [
    { text: 'a', ending: 'CRLF' }, { text: 'b', ending: 'LF' },
    { text: 'c\rd', ending: 'none' },
  ] },
  { name: 'empty-crlf-then-empty-lf', text: '\r\n\n', rows: [
    { text: '', ending: 'CRLF' }, { text: '', ending: 'LF' },
  ] },
  { name: 'embedded-cr-body', text: '\r\r\n', rows: [{ text: '\r', ending: 'CRLF' }] },
  { name: 'empty', text: '', rows: [] },
];
for (const entry of manual) check(entry.name, () => {
  assert.deepEqual(plain(api.textLines(entry.text)), entry.rows);
  assert.equal(api.textLineCount(entry.text), entry.rows.length);
  const rebuilt = entry.rows.map(row => row.text + ({ none: '', LF: '\n', CRLF: '\r\n' }[row.ending])).join('');
  assert.equal(rebuilt, entry.text);
});

check('shifted-eol-coordinates-and-counts', () => {
  const result = plain(api.compareLines('a\nb', 'X\na\r\nb'));
  assert.equal(result.precision, 'aligned');
  assert.deepEqual(result.stats, { adds: 1, removes: 0 });
  assert.deepEqual(result.rows, [
    { kind: 'add', oldLine: null, newLine: 1, text: 'X' },
    { kind: 'same', oldLine: 1, newLine: 2, text: 'a' },
    { kind: 'same', oldLine: 2, newLine: 3, text: 'b' },
  ]);
  assert.deepEqual(result.endingChanges, [{ oldLine: 1, newLine: 2, before: 'LF', after: 'CRLF' }]);
});
check('known-empty-is-distinct-from-missing', () => {
  const missing = plain(api.compareLines(null, 'a\n'));
  const known = plain(api.compareLines('', 'a\n'));
  assert.equal(missing.precision, 'missing-before');
  assert.equal(missing.stats, null);
  assert.deepEqual(missing.rows, [{ kind: 'uncompared', oldLine: null, newLine: 1, text: 'a' }]);
  assert.equal(known.precision, 'aligned');
  assert.deepEqual(known.stats, { adds: 1, removes: 0 });
});
check('whitespace-manual-replacement', () => {
  const result = plain(api.compareLines('a\n \nz', 'a\n\t\nz'));
  assert.deepEqual(result.stats, { adds: 1, removes: 1 });
  assert.deepEqual(result.rows.filter(r => r.kind !== 'same').map(r => [r.kind, r.text]), [['remove', ' '], ['add', '\t']]);
});
check('eof-change-does-not-invent-row', () => {
  const result = plain(api.compareLines('a\n', 'a'));
  assert.deepEqual(result.stats, { adds: 0, removes: 0 });
  assert.deepEqual(result.endingChanges, [{ oldLine: 1, newLine: 1, before: 'LF', after: 'none' }]);
  assert.equal(result.rows.length, 1);
});
check('unicode-not-normalized', () => {
  assert.deepEqual(plain(api.compareLines('é\n中😀', 'e\u0301\n中😀').stats), { adds: 1, removes: 1 });
});
check('physical-line-budget-exact-and-plus-one', () => {
  assert.deepEqual(plain(api.compareLines('', 'a\n'.repeat(20_000)).stats), { adds: 20_000, removes: 0 });
  const over = api.compareLines('', 'a\n'.repeat(20_001));
  assert.equal(over.precision, 'unavailable'); assert.equal(over.reason, 'lines'); assert.equal(over.rows.length, 0);
});
check('utf16-character-budget-exact-and-plus-one', () => {
  const boundary = '😀'.repeat(1_048_576);
  assert.equal(boundary.length, 2_097_152);
  assert.deepEqual(plain(api.compareLines('', boundary).stats), { adds: 1, removes: 0 });
  const over = api.compareLines('', boundary + 'x');
  assert.equal(over.precision, 'unavailable'); assert.equal(over.reason, 'characters'); assert.equal(over.rows.length, 0);
});
check('matrix-exact-boundary-and-fallback', () => {
  const side = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n');
  const exact = api.compareLines(side('a', 999), side('b', 999));
  assert.equal(exact.precision, 'aligned');
  assert.deepEqual(plain(exact.stats), { adds: 999, removes: 999 });
  const replacement = api.compareLines(side('a', 1000), side('b', 1000));
  assert.equal(replacement.precision, 'replacement'); assert.equal(replacement.stats, null);
  assert.equal(replacement.rows.length, 2000);
});
check('owner-mutation-invalidates-weak-cache', () => {
  const owner = { oldText: 'a\n', newText: 'a\n' };
  const first = api.comparisonFor(owner);
  assert.strictEqual(api.comparisonFor(owner), first);
  owner.oldText = null;
  assert.equal(api.comparisonFor(owner).precision, 'missing-before');
  owner.oldText = ''; owner.newText = 'b';
  assert.deepEqual(plain(api.comparisonFor(owner).stats), { adds: 1, removes: 0 });
});
assert.equal(sha(fs.readFileSync(sourcePath)), sourceSha256);
console.log(JSON.stringify({ sourcePath, sourceSha256, sourceBytes: bytes.length, checks, count: checks.length,
  boundary: 'Exact full pure production module transpiled with repository TypeScript; independent hand-written expected values. No component/UI, Agent, disk-file verification, native or full-engineering acceptance.' }, null, 2));
