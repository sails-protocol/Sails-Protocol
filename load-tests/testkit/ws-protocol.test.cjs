'use strict';
const assert = require('node:assert/strict');
const { classifyApplicationPong } = require('./ws-protocol.cjs');
assert.equal(classifyApplicationPong('{"type":"PONG"}'), true);
assert.equal(classifyApplicationPong(Buffer.from('{"type":"PONG","payload":{}}')), true);
assert.equal(classifyApplicationPong('{"type":"PING"}'), false);
for (const raw of ['not json','null','[]','{"type":"ERROR"}']) {
  assert.throws(() => classifyApplicationPong(raw));
}
console.log('Sails TestKit WS application assertion positive/negative controls PASS');
