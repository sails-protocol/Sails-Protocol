'use strict';
// Test-only Artillery WS comparator: fresh one-time ticket for every connection.
// Artillery WS connect.function callback receives (wsArgs, context, callback).
const fs=require('node:fs');
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
    wsArgs.target='ws://127.0.0.1:3000/v1/openp2p/chat?ticket='+encodeURIComponent(ticket);
  })().then(()=>callback(null),()=>callback(Error('Bounded WS ticket setup failed (details redacted)')));
}
module.exports={connectWithFreshTicket};
