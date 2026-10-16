'use strict';
// Protocol-only fail-closed assertions. No load scheduling, thresholds or metrics.
function requireNonemptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Missing or invalid ' + label);
  }
  return value;
}
function requireResponseDataString(response, key, label) {
  return requireNonemptyString(response?.data?.data?.[key], label);
}
function requireApplicationPong(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'PONG') {
    throw new Error('Expected application PONG');
  }
  return true;
}
module.exports = { requireNonemptyString, requireResponseDataString, requireApplicationPong };
