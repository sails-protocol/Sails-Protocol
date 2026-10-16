'use strict';
// Sails TestKit: protocol test-target safety, not a load scheduler.
const assert = (condition, message) => { if (!condition) throw Error(message); };
function requireLoopbackTarget(raw, protocols) {
  const url = new URL(raw);
  assert(protocols.includes(url.protocol), 'Unsupported target protocol: ' + url.protocol);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Load testing is restricted to loopback targets');
  assert(!url.username && !url.password, 'Target URL must not contain credentials');
  assert(!url.search && !url.hash && (url.pathname === '/' || url.pathname === ''), 'Target URL must not contain path, query or fragment');
}
module.exports = { requireLoopbackTarget };
