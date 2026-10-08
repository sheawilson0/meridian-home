'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const https = require('https');

function mockHttps(t, method, respond) {
  t.mock.method(https, method, (...args) => {
    const callback = args.at(-1);
    const req = new EventEmitter();
    const res = new PassThrough();
    res.statusCode = 200; res.headers = {}; res.complete = false;
    req.setTimeout = () => req;
    req.write = () => {};
    req.destroy = (error = new Error('request destroyed')) => {
      if (req.destroyed) return;
      req.destroyed = true;
      res.destroy(); req.emit('error', error); req.emit('close');
    };
    const start = () => queueMicrotask(() => { respond(res, req, () => callback(res)); });
    req.end = start;
    if (method === 'get') start();
    return req;
  });
}

module.exports = { mockHttps };
