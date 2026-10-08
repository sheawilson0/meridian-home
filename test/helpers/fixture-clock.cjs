'use strict';

// Freeze dates, keeping real timers so sockets and test deadlines still work.
const RealDate = Date;
const now = Date.parse('2026-10-08T11:00:00.000Z');
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
