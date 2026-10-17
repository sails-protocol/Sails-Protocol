'use strict';
// Real loopback WebSocket transport, not Artillery engine integration.
const assert=require('node:assert/strict');
const {WebSocketServer}=require('ws');
const {provePongOverRealSocket}=require('./ws-bounded-processor.js');
(async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  let mode='PONG';
  server.on('connection',socket=>{
    socket.on('message',raw=>{
      const message=JSON.parse(String(raw));
      assert.equal(message.type,'PING');
      if(mode==='CLOSE'){socket.close();return;}
      if(mode==='MALFORMED'){socket.send('{invalid-json');return;}
      if(mode!=='SILENT')socket.send(JSON.stringify({type:mode,payload:{}}));
    });
  });
  try{
    const address=server.address();
    const url='ws://127.0.0.1:'+address.port;
    await provePongOverRealSocket(url,{timeoutMs:300});
    mode='NOT_PONG';
    await assert.rejects(provePongOverRealSocket(url,{timeoutMs:50}),/PONG timeout/);
    mode='ERROR';
    await assert.rejects(provePongOverRealSocket(url,{timeoutMs:100}),/WS application ERROR/);
    mode='MALFORMED';
    await assert.rejects(provePongOverRealSocket(url,{timeoutMs:100}),/JSON|Unexpected token|Expected property/);
    mode='CLOSE';
    await assert.rejects(provePongOverRealSocket(url,{timeoutMs:100}),/WS closed before PONG/);
    mode='SILENT';
    await assert.rejects(provePongOverRealSocket(url,{timeoutMs:50}),/PONG timeout/);
    await assert.rejects(provePongOverRealSocket('ws://example.com',{timeoutMs:100}),/clean loopback URL/);
    console.log('Real loopback WebSocket PONG positive/negative transport proof PASS; Artillery engine parity OPEN');
  }finally{await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
