'use strict';
// Node 24 native load harness candidate. No Artillery or third-party load generator.
// Preserve the authenticated flows, phase arrivals, assertions and metrics.
const { performance } = require('node:perf_hooks');
const { randomInt } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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

const phases = [{ duration: 20, rate: 5 }, { duration: 30, rate: 20 }];
const wsPhases = [{ duration: 20, rate: 5 }, { duration: 30, rate: 15 }];
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
async function runPhases(name, config, work) {
  const maxInFlight = Number(process.env.SAILS_LOAD_MAX_INFLIGHT || 100);
  assert(Number.isInteger(maxInFlight) && maxInFlight > 0, 'Invalid max in-flight');
  let issued=0, succeeded=0, failed=0, inflight=0, maxObserved=0;
  const durations=[], failures=[], tasks=new Set();
  for (const phase of config) {
    const begin=performance.now();
    const count=phase.duration*phase.rate;
    for (let n=0;n<count;n++) {
      const due=begin + n*1000/phase.rate;
      const delay=due-performance.now();
      if (delay>0) await new Promise(r=>setTimeout(r,delay));
      const i=++issued;
      if (inflight>=maxInFlight) { failed++; failures.push('overload: max in-flight'); continue; }
      const start=performance.now();
      inflight++; maxObserved=Math.max(maxObserved,inflight);
      const task=Promise.resolve().then(()=>work(i)).then(()=>{succeeded++;durations.push(performance.now()-start);},err=>{failed++;failures.push(String(err.message||err));}).finally(()=>{inflight--;tasks.delete(task);});
      tasks.add(task);
    }
    const remaining=begin+phase.duration*1000-performance.now();
    if(remaining>0) await new Promise(r=>setTimeout(r,remaining));
  }
  await Promise.all(tasks);
  const expectedArrivals=config.reduce((total,phase)=>total+phase.duration*phase.rate,0);
  assert(issued===expectedArrivals, 'Arrival accounting mismatch');
  assert(succeeded+failed===issued, 'Outcome accounting mismatch');
  durations.sort((a,b)=>a-b);
  const percentile=p=>durations.length?Number(durations[Math.ceil(durations.length*p)-1].toFixed(1)):null;
  const report={scenario:name,issued,succeeded,failed,maxInFlight:maxObserved,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),sampleErrors:failures.slice(0,10)};
  console.log(JSON.stringify(report,null,2));
  if(failed>0 || succeeded===0) process.exitCode=1;
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
  if(mode==='bench-small') {
    // CTO-approved isolated rehearsal: 1 real identity (4 auth calls), at most
    // 2 sequential HTTP intent round-trips and 2 sequential WS PING/PONGs.
    // Never use this low-volume correctness result to claim sustained parity.
    const user=await authenticate('bench-small');
    await runPhases('isolated-http-rehearsal',[{duration:2,rate:1}],i=>intent(i,user));
    await runPhases('isolated-ws-rehearsal',[{duration:2,rate:1}],()=>websocket(user));
    return;
  }
  if(mode==='intent') return runPhases('authenticated-intent',phases,intent);
  if(mode==='ws'){
    const poolPath=path.join(__dirname,'users.json');
    const stats=fs.lstatSync(poolPath);
    assert(!stats.isSymbolicLink(), 'Session pool must not be a symlink');
    assert(stats.isFile(), 'Session pool must be a regular file');
    if (process.platform !== 'win32') assert((stats.mode & 0o077) === 0, 'Session pool permissions must be private (0600)');
    const users=JSON.parse(fs.readFileSync(poolPath,'utf8'));
    assert(Array.isArray(users)&&users.length>0,'No pre-authenticated users; run prep');
    assert(users.every(u=>u && typeof u.sessionToken==='string' && u.sessionToken.length>0), 'Invalid session pool');
    return runPhases('authenticated-ws-ping-pong',wsPhases,i=>websocket(users[randomInt(users.length)]));
  }
  if(mode==='prep'){
    const count=Number(process.argv[3]||50);
    assert(Number.isInteger(count)&&count>0&&count<=1000,'Invalid prep count');
    const users=[];for(let i=0;i<count;i++)users.push(await authenticate(i));
    const poolPath=path.join(__dirname,'users.json');
    fs.writeFileSync(poolPath,JSON.stringify(users,null,2),{mode:0o600,flag:'wx'});
    console.log('Prepared '+users.length+' authenticated sessions');
    return;
  }
  throw Error('Usage: node load-tests/native/run.js smoke|bench-small|intent|prep [count]|ws');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
