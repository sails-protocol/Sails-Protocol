'use strict';
// Test-only Artillery HTTP comparator. No changes to legacy scenarios.
// Current protocol: registration PoP followed by signed login challenge.
const nacl = require('tweetnacl');
const hex = bytes => Buffer.from(bytes).toString('hex');
const base = 'http://127.0.0.1:3000';
async function post(route, body, expected) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== expected) throw Error(route + ': HTTP ' + response.status + ' expected ' + expected);
  const payload = await response.json();
  if (!payload?.data) throw Error(route + ': missing response data');
  return payload.data;
}
async function setupCurrentAuthenticatedUser(context, events) {
  try {
    const pair = nacl.sign.keyPair();
    const publicKey = hex(pair.publicKey);
    const displayName = 'artillery-comparator-' + publicKey.slice(0, 8);
    const registration = await post('/v1/identity/register-challenge', { publicKey }, 200);
    if (typeof registration.challenge !== 'string') throw Error('Missing registration challenge');
    const proof = Buffer.from('sails-registration-proof-of-possession:v1:' + registration.challenge + ':' + displayName, 'utf8');
    await post('/v1/identity/participants', {
      publicKey, displayName, signature: hex(nacl.sign.detached(proof, pair.secretKey)),
    }, 201);
    const login = await post('/v1/identity/challenge', { publicKey }, 200);
    if (typeof login.challenge !== 'string') throw Error('Missing login challenge');
    const authenticated = await post('/v1/identity/authenticate', {
      publicKey,
      signature: hex(nacl.sign.detached(Buffer.from(login.challenge, 'utf8'), pair.secretKey)),
    }, 200);
    if (typeof authenticated.sessionToken !== 'string' || !authenticated.sessionToken) throw Error('Missing session token');
    context.vars.sessionToken = authenticated.sessionToken;
  } catch (error) {
    // Never print bearer tokens or server response bodies.
    events.emit('error', 'current-auth comparator setup failed (details redacted)');
    throw Error('current-auth comparator setup failed (details redacted)');
  }
}
// Artillery afterResponse hooks count completed engine-level operations,
// independently of the global HTTP request total. No payloads or tokens logged.
function recordIntentCreateResponse(requestParams, response, context, events, next) {
  if (response?.statusCode !== 201) throw Error('Intent create response status mismatch (redacted)');
  events.emit('counter', 'sails.intent_create_responses', 1);
  return next();
}
function recordIntentCancelResponse(requestParams, response, context, events, next) {
  if (response?.statusCode !== 200) throw Error('Intent cancel response status mismatch (redacted)');
  events.emit('counter', 'sails.intent_cancel_responses', 1);
  return next();
}
module.exports = { setupCurrentAuthenticatedUser, recordIntentCreateResponse, recordIntentCancelResponse };
