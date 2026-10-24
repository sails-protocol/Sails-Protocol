'use strict';
const assert = require('node:assert/strict');
const { requireLoopbackTarget } = require('./loopback-target.cjs');
for (const [url,protocols] of [
  ['http://127.0.0.1:3000',['http:']],
  ['http://localhost:3000',['http:']],
  ['ws://[::1]:3000',['ws:']],
]) assert.doesNotThrow(() => requireLoopbackTarget(url,protocols));
for (const [url,protocols] of [
  ['https://example.com',['http:']],
  ['http://example.com',['http:']],
  ['http://127.0.0.1.evil.test',['http:']],
  ['http://user:password@localhost:3000',['http:']],
  ['http://localhost:3000/private',['http:']],
  ['http://localhost:3000/?ticket=secret',['http:']],
  ['http://localhost:3000/#fragment',['http:']],
  ['ws://example.com',['ws:']],
  ['http://localhost:3000',['ws:']],
]) assert.throws(() => requireLoopbackTarget(url,protocols));
console.log('Sails TestKit loopback target positive/negative controls PASS');
