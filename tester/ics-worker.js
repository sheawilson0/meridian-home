'use strict';

// Reads one calendar off the main thread (tester/ics.js), so a calendar built to be slow
// (thousands of repeating events from 1990) can't hold up anyone else's page.
const { parentPort, workerData } = require('worker_threads');
const { parseIcsFeed } = require('../calendar-ics');

const { text, label, now, days } = workerData;
parentPort.postMessage(parseIcsFeed(text, label, { now, windowDays: days }).slice(0, 200));
