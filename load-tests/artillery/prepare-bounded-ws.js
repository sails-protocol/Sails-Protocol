'use strict';
// Disposable local comparator only. This creates exactly one session (4 auth-tier calls).
// Refuse existing files, public endpoints and symlink targets; never print tokens.
const fs = require('node:fs');
const path = require('node:path');
const nacl = require('tweetnacl');
const base = 'http://127.0.0.1:3000';
const out = path.join(__dirname, 'bounded-ws-users.json');
const hex = b => Buffer.from(b).toString('hex');
async function post(route, body, expected) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if(response.status!==expected) throw Error('Bounded WS preparation HTTP status mismatch (details redacted)');
  const payload = await response.json();
  if(!payload?.data) throw Error('Bounded WS preparation missing response data');
  return payload.data;
}
async function main(){
  const pair=nacl.sign.keyPair(), publicKey=hex(pair.publicKey);
  const displayName='bounded-ws-'+publicKey.slice(0,8);
  const registration=await post('/v1/identity/register-challenge',{publicKey},200);
  if(typeof registration.challenge!=='string') throw Error('Missing registration challenge');
  const proof=Buffer.from('sails-registration-proof-of-possession:v1:'+registration.challenge+':'+displayName,'utf8');
  await post('/v1/identity/participants',{publicKey,displayName,signature:hex(nacl.sign.detached(proof,pair.secretKey))},201);
  const login=await post('/v1/identity/challenge',{publicKey},200);
  if(typeof login.challenge!=='string') throw Error('Missing login challenge');
  const auth=await post('/v1/identity/authenticate',{publicKey,signature:hex(nacl.sign.detached(Buffer.from(login.challenge,'utf8'),pair.secretKey))},200);
  if(typeof auth.sessionToken!=='string'||!auth.sessionToken) throw Error('Missing session token');
  fs.writeFileSync(out,JSON.stringify([{sessionToken:auth.sessionToken}]),{flag:'wx',mode:0o600});
  console.log('Prepared one bounded WebSocket comparator session (redacted)');
}
main().catch(()=>{console.error('Bounded WS session preparation failed (details redacted)');process.exitCode=1});
