'use strict';
// Test-only Artillery WS comparator: fresh one-time ticket for every connection.
// Artillery WS connect.function callback receives (wsArgs, context, callback).
const fs=require('node:fs');
const { classifyApplicationPong } = require('../testkit/ws-protocol.cjs');
const path=require('node:path');
const poolPath=path.join(__dirname,'bounded-ws-users.json');
function connectWithFreshTicket(wsArgs,context,callback){
  (async()=>{
    const stat=fs.lstatSync(poolPath);
    if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0)) throw Error('Private session pool required');
    const users=JSON.parse(fs.readFileSync(poolPath,'utf8'));
    if(!Array.isArray(users)||users.length!==1||typeof users[0]?.sessionToken!=='string'||!users[0].sessionToken) throw Error('Invalid session pool');
    const response=await fetch('http://127.0.0.1:3000/v1/identity/ws-ticket',{
      method:'POST',headers:{Authorization:'Bearer '+users[0].sessionToken},signal:AbortSignal.timeout(15000)
    });
    if(response.status!==200) throw Error('WS ticket request rejected');
    const payload=await response.json();
    const ticket=payload?.data?.ticket;
    if(typeof ticket!=='string'||!ticket) throw Error('Missing one-time WS ticket');
    if(!wsArgs||typeof wsArgs!=='object') throw Error('Unsupported Artillery WS connection interface');
    wsArgs.target='ws://127.0.0.1:3000/v1/openp2p/chat?ticket='+encodeURIComponent(ticket);
    // The ticket URL is a bearer capability: do not emit wsArgs or this URL to logs.
  })().then(()=>callback(null),()=>callback(Error('Bounded WS ticket setup failed (details redacted)')));
}
// Fail-closed PONG assertion for an Artillery WS engine that exposes the
// underlying socket to a custom processor hook. Not wired into the scenario
// until engine semantics are verified; never label send+think as PONG proof.
function assertPongFromSocket(ws,{timeoutMs=15000}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000) throw Error('Invalid bounded PONG timeout');
  if(!ws||typeof ws.on!=='function'||typeof ws.send!=='function') throw Error('Unsupported WebSocket assertion interface');
  return new Promise((resolve,reject)=>{
    let finished=false;
    const timer=setTimeout(()=>finish(Error('PONG timeout')),timeoutMs);
    function finish(err){if(finished)return;finished=true;clearTimeout(timer);ws.off?.('message',onMessage);ws.off?.('close',onClose);ws.off?.('error',onError);err?reject(err):resolve();}
    function onMessage(raw){
      try { if (classifyApplicationPong(raw)) finish(); }
      catch (error) { finish(error); }
    }
    function onClose(){finish(Error('WS closed before PONG'));}
    function onError(){finish(Error('WS transport error'));}
    ws.on('message',onMessage);ws.on('close',onClose);ws.on('error',onError);
    try{ws.send(JSON.stringify({type:'PING',payload:{}}));}catch{finish(Error('WS send failed'));}
  });
}
module.exports={connectWithFreshTicket,assertPongFromSocket};
