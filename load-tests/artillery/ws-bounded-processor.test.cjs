'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {assertPongFromSocket}=require('./ws-bounded-processor.js');
class Socket extends EventEmitter {
  constructor(reply){super();this.reply=reply;this.sent=[];}
  send(message){
    this.sent.push(JSON.parse(message));
    if(this.reply!==null)queueMicrotask(()=>this.emit('message',JSON.stringify(this.reply)));
  }
}
(async()=>{
  const ok=new Socket({type:'PONG'});
  await assertPongFromSocket(ok,{timeoutMs:100});
  assert.deepEqual(ok.sent,[{type:'PING',payload:{}}]);
  assert.equal(ok.listenerCount('message'),0);
  await assert.rejects(assertPongFromSocket(new Socket({type:'ERROR'}),{timeoutMs:100}),/WS application ERROR/);
  await assert.rejects(assertPongFromSocket(new Socket({type:'OTHER'}),{timeoutMs:20}),/PONG timeout/);
  await assert.rejects(assertPongFromSocket(new Socket(null),{timeoutMs:20}),/PONG timeout/);
  const closed=new Socket(null);
  const promise=assertPongFromSocket(closed,{timeoutMs:100});
  queueMicrotask(()=>closed.emit('close'));
  await assert.rejects(promise,/closed before PONG/);
  console.log('Artillery socket assertion helper positive/negative unit checks passed; engine integration not established');
})().catch(e=>{console.error(e);process.exitCode=1});
