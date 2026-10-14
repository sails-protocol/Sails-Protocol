'use strict';
// Node 24 native load harness candidate. No Artillery or third-party load generator.
// Preserve the authenticated flows, phase arrivals, assertions and metrics.
const nacl = require('tweetnacl');
const { performance } = require('node:perf_hooks');
const { randomInt } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.SAILS_LOAD_HTTP_TARGET || 'http://localhost:3000';
const WSBASE = process.env.SAILS_LOAD_WS_TARGET || 'ws://localhost:3000';
const phases = [{ duration: 20, rate: 5 }, { duration: 30, rate: 20 }];
const wsPhases = [{ duration: 20, rate: 5 }, { duration: 30, rate: 15 }];
const toHex = b => Buffer.from(b).toString('hex');
const assert = (ok, message) => { if (!ok) throw Error(message); };
const request = async (route, method, body, token, expected) => {
  const start = performance.now();
  const res = await fetch(BASE + route, { method, headers: { ...(body ? {'Content-Type':'application/json'} : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  assert(res.status === expected, method + ' ' + route + ': HTTP ' + res.status + ' expected ' + expected + ' ' + text.slice(0,300));
  let data; try { data = text ? JSON.parse(text) : {}; } catch { throw Error('Invalid JSON: ' + route); }
  return { data, ms: performance.now() - start };
};
async function authenticate(i) {
  const kp = nacl.sign.keyPair();
  const publicKey = toHex(kp.publicKey);
  // Original Artillery processor does not assert registration status. Here fail closed.
  await request('/v1/identity/participants', 'POST', { publicKey, displayName: 'loadtest-' + i + '-' + publicKey.slice(0,8) }, null, 201);
  const challenge = await request('/v1/identity/challenge', 'POST', { publicKey }, null, 200);
  assert(typeof challenge.data?.data?.challenge === 'string', 'Missing challenge');
  const signature = toHex(nacl.sign.detached(Buffer.from(challenge.data.data.challenge, 'utf8'), kp.secretKey));
  const auth = await request('/v1/identity/authenticate', 'POST', { publicKey, signature }, null, 200);
  assert(typeof auth.data?.data?.sessionToken === 'string', 'Missing sessionToken');
  return { publicKey, sessionToken: auth.data.data.sessionToken };
}
async function intent(i) {
  const user = await authenticate(i);
  const assets = ['BTC', 'USDT_ERC20', 'LN_BTC'];
  const created = await request('/v1/intents', 'POST', { type: 'TradeIntent', payload: { asset: assets[randomInt(assets.length)], side:'BUY', maxValue:'100', currency:'USD' } }, user.sessionToken, 201);
  const id = created.data?.data?.id;
  assert(typeof id === 'string' && id.length > 0, 'Missing intent ID');
  await request('/v1/intents/' + encodeURIComponent(id), 'DELETE', undefined, user.sessionToken, 200);
}
function websocket(user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSBASE + '/v1/openp2p/chat?token=' + encodeURIComponent(user.sessionToken));
    const started = performance.now();
    let done = false;
    const timeout = setTimeout(() => finish(Error('WebSocket PONG timeout')), 15000);
    function finish(err) { if (done) return; done = true; clearTimeout(timeout); try { ws.close(); } catch {} err ? reject(err) : resolve(performance.now()-started); }
    ws.addEventListener('open', () => ws.send(JSON.stringify({type:'PING',payload:{}})));
    ws.addEventListener('message', event => {
      let msg; try { msg=JSON.parse(event.data); } catch { return finish(Error('Invalid WebSocket JSON')); }
      if (msg.type === 'PONG') finish();
      else if (msg.type === 'ERROR') finish(Error('WebSocket ERROR: ' + JSON.stringify(msg)));
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
      if (inflight>=maxInFlight) { failed++; failures.push('overload: max in-flight'); continue; }
      const i=++issued, start=performance.now();
      inflight++; maxObserved=Math.max(maxObserved,inflight);
      const task=Promise.resolve().then(()=>work(i)).then(()=>{succeeded++;durations.push(performance.now()-start);},err=>{failed++;failures.push(String(err.message||err));}).finally(()=>{inflight--;tasks.delete(task);});
      tasks.add(task);
    }
    const remaining=begin+phase.duration*1000-performance.now();
    if(remaining>0) await new Promise(r=>setTimeout(r,remaining));
  }
  await Promise.all(tasks);
  durations.sort((a,b)=>a-b);
  const percentile=p=>durations.length?Number(durations[Math.ceil(durations.length*p)-1].toFixed(1)):null;
  const report={scenario:name,issued,succeeded,failed,maxInFlight:maxObserved,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),sampleErrors:failures.slice(0,10)};
  console.log(JSON.stringify(report,null,2));
  if(failed>0 || succeeded===0) process.exitCode=1;
}
async function main(){
  const mode=process.argv[2];
  if(mode==='intent') return runPhases('authenticated-intent',phases,intent);
  if(mode==='ws'){
    const users=JSON.parse(fs.readFileSync(path.join(__dirname,'users.json'),'utf8'));
    assert(Array.isArray(users)&&users.length>0,'No pre-authenticated users; run prep');
    return runPhases('authenticated-ws-ping-pong',wsPhases,i=>websocket(users[randomInt(users.length)]));
  }
  if(mode==='prep'){
    const count=Number(process.argv[3]||50);
    assert(Number.isInteger(count)&&count>0&&count<=1000,'Invalid prep count');
    const users=[];for(let i=0;i<count;i++)users.push(await authenticate(i));
    fs.writeFileSync(path.join(__dirname,'users.json'),JSON.stringify(users,null,2),{mode:0o600});
    console.log('Prepared '+users.length+' authenticated sessions');
    return;
  }
  throw Error('Usage: node load-tests/native/run.js intent|prep [count]|ws');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
