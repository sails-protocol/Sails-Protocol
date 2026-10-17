'use strict';
// Test-only protocol assertion. No sockets, scheduling, metrics or load generation.
function classifyApplicationPong(raw) {
  let data;
  try { data = JSON.parse(String(raw)); }
  catch { throw Error('Invalid WS JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid WS message');
  if (data.type === 'ERROR') throw Error('WS application ERROR (redacted)');
  return data.type === 'PONG';
}
module.exports = { classifyApplicationPong };
