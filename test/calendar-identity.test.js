'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate only identity selection, without starting the daemon or its jobs.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  .replace(/(const WORK_EMAIL = .+?\?\? )'[^']*';/, "$1'owner@example.com';");
const start = source.indexOf('const WORK_EMAIL =');
const end = source.indexOf('function parseIcsFeed(', start);
assert.ok(start >= 0 && end > start);
function emails(calendar) {
  const ctx = { CONFIG: { calendar }, calendars: { urls: () => ['fictional-feed'] }, calendarIcs: { ownerFromFeedUrl: () => 'owner@example.invalid' } };
  return Array.from(vm.runInNewContext(source.slice(start, end) + '\nselfEmails()', ctx));
}

test('calendar identity preserves the existing default and allows an explicit empty identity', () => {
  assert.deepEqual(emails(undefined), ['owner@example.com', 'owner@example.invalid']);
  assert.deepEqual(emails({ workEmail: '', selfEmails: ['Me@example.invalid'] }), ['me@example.invalid', 'owner@example.invalid']);
});

test('calendar identity uses the configured email and deduplicates case-insensitively', () => {
  assert.deepEqual(emails({ workEmail: 'Me@example.invalid', selfEmails: ['me@example.invalid', 'other@example.invalid'] }), ['me@example.invalid', 'other@example.invalid', 'owner@example.invalid']);
});
