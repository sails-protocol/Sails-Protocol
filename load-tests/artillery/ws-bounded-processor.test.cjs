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
  const invalid=new Socket({type:'PONG'});
  assert.throws(()=>assertPongFromSocket(invalid,{timeoutMs:0}),/Invalid bounded PONG timeout/);
  const malformed=new Socket(null);
  const malformedPromise=assertPongFromSocket(malformed,{timeoutMs:100});
  queueMicrotask(()=>malformed.emit('message','not-json'));
  await assert.rejects(malformedPromise,/Invalid WS JSON/);
  assert.equal(malformed.listenerCount('message'),0);
  const transport=new Socket(null);
  const transportPromise=assertPongFromSocket(transport,{timeoutMs:100});
  queueMicrotask(()=>transport.emit('error',new Error('sensitive details')));
  await assert.rejects(transportPromise,/WS transport error/);
  assert.equal(transport.listenerCount('error'),0);
  const nonPong=new Socket({type:'NOT_PONG',payload:{}});
  await assert.rejects(assertPongFromSocket(nonPong,{timeoutMs:20}),/PONG timeout/);
  assert.equal(nonPong.listenerCount('message'),0);
  const socketInterface={on(){},send(){}};
  assert.throws(()=>assertPongFromSocket(null,{timeoutMs:100}),/Unsupported WebSocket assertion interface/);
  assert.equal(typeof socketInterface.on,'function');
  assert.throws(()=>assertPongFromSocket(socketInterface,{timeoutMs:100}),/Unsupported WebSocket assertion interface/);
  assert.equal(socketInterface.send instanceof Function,true);
  const timed=new Socket(null);
  await assert.rejects(assertPongFromSocket(timed,{timeoutMs:20}),/PONG timeout/);
  assert.equal(timed.listenerCount('message'),0);
  console.log('Artillery socket assertion helper positive/negative unit checks passed; engine integration not established');
})().catch(e=>{console.error(e);process.exitCode=1});
