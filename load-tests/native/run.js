const { randomInt } = require('node:crypto');
'use strict';
// Node 24 protocol-only smoke. k6 owns load scheduling and performance metrics.
const { performance } = require('node:perf_hooks');
const BASE = process.env.SAILS_LOAD_HTTP_TARGET || 'http://localhost:3000';
const WSBASE = process.env.SAILS_LOAD_WS_TARGET || 'ws://localhost:3000';
// Shared TestKit safety guard; checked before any load is issued.
const { requireLoopbackTarget } = require('../testkit/loopback-target.cjs');
const { requireResponseDataString } = require('../testkit/protocol-assertions.cjs');
const { classifyApplicationPong } = require('../testkit/ws-protocol.cjs');
function validateTargets() {
  requireLoopbackTarget(BASE, ['http:']);
  requireLoopbackTarget(WSBASE, ['ws:']);
}

const toHex = b => Buffer.from(b).toString('hex');
const assert = (ok, message) => { if (!ok) throw Error(message); };
const request = async (route, method, body, token, expected) => {
  const start = performance.now();
  const res = await fetch(BASE + route, { method, headers: { ...(body ? {'Content-Type':'application/json'} : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  assert(res.status === expected, method + ' ' + route + ': HTTP ' + res.status + ' expected ' + expected);
  let data; try { data = text ? JSON.parse(text) : {}; } catch { throw Error('Invalid JSON: ' + route); }
  return { data, ms: performance.now() - start };
};
async function authenticate(i) {
  // Load only for real authentication; target guards must run without npm install.
  const nacl = require('tweetnacl');
  const kp = nacl.sign.keyPair();
  const publicKey = toHex(kp.publicKey);
  // Original Artillery processor does not assert registration status. Here fail closed.
  const displayName = 'loadtest-' + i + '-' + publicKey.slice(0,8);
  const registration = await request('/v1/identity/register-challenge', 'POST', { publicKey }, null, 200);
  requireResponseDataString(registration, 'challenge', 'registration challenge');
  const registrationMessage = Buffer.from('sails-registration-proof-of-possession:v1:' + registration.data.data.challenge + ':' + displayName, 'utf8');
  const registrationSignature = toHex(nacl.sign.detached(registrationMessage, kp.secretKey));
  await request('/v1/identity/participants', 'POST', { publicKey, displayName, signature: registrationSignature }, null, 201);
  const challenge = await request('/v1/identity/challenge', 'POST', { publicKey }, null, 200);
  requireResponseDataString(challenge, 'challenge', 'authentication challenge');
  const signature = toHex(nacl.sign.detached(Buffer.from(challenge.data.data.challenge, 'utf8'), kp.secretKey));
  const auth = await request('/v1/identity/authenticate', 'POST', { publicKey, signature }, null, 200);
  requireResponseDataString(auth, 'sessionToken', 'sessionToken');
  return { publicKey, sessionToken: auth.data.data.sessionToken };
}
async function intent(i, existingUser) {
  const user = existingUser || await authenticate(i);
  const assets = ['BTC', 'USDT_ERC20', 'LN_BTC'];
  const created = await request('/v1/intents', 'POST', { type: 'TradeIntent', payload: { asset: assets[randomInt(assets.length)], side:'BUY', maxValue:'100', currency:'USD' } }, user.sessionToken, 201);
  const id = created.data?.data?.id;
  requireResponseDataString(created, 'id', 'intent ID');
  await request('/v1/intents/' + encodeURIComponent(id), 'DELETE', undefined, user.sessionToken, 200);
}
async function websocket(user) {
  const issued = await request('/v1/identity/ws-ticket', 'POST', undefined, user.sessionToken, 200);
  const ticket = issued.data?.data?.ticket;
  requireResponseDataString(issued, 'ticket', 'single-use WS ticket');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSBASE + '/v1/openp2p/chat?ticket=' + encodeURIComponent(ticket));
    const started = performance.now();
    let done = false;
    const timeout = setTimeout(() => finish(Error('WebSocket PONG timeout')), 15000);
    function finish(err) { if (done) return; done = true; clearTimeout(timeout); try { ws.close(); } catch {} err ? reject(err) : resolve(performance.now()-started); }
    ws.addEventListener('open', () => ws.send(JSON.stringify({type:'PING',payload:{}})));
    ws.addEventListener('message', event => {
      let msg; try { msg=JSON.parse(event.data); } catch { return finish(Error('Invalid WebSocket JSON')); }
      try { if (classifyApplicationPong(event.data)) finish(); }
      catch { finish(Error('WebSocket protocol assertion failed (details redacted)')); }
    });
    ws.addEventListener('error', () => finish(Error('WebSocket transport error')));
    ws.addEventListener('close', () => { if (!done) finish(Error('WebSocket closed before PONG')); });
  });
}
async function main(){
  validateTargets();
  const mode=process.argv[2];
  if(mode==='smoke') {
    // One user, four auth-tier calls total; avoids defeating the default shared 10/min limit.
    const user = await authenticate('smoke');
    await intent('smoke', user);
    await websocket(user);
    console.log(JSON.stringify({scenario:'authenticated-smoke',identity:'PASS',intent:'PASS',websocketPingPong:'PASS'}));
    return;
  }
  throw Error('Usage: node load-tests/native/run.js smoke (protocol-only; use k6 for load)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
