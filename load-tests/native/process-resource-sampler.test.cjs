'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {sample,delta}=require('./process-resource-sampler.cjs');
(async()=>{
  assert.throws(()=>sample(0),/Invalid process identifier/);
  assert.throws(()=>sample(-1),/Invalid process identifier/);
  assert.throws(()=>delta({cpuTicks:2},{cpuTicks:1,rssKiBEnd:1}),/Non-monotonic CPU/);
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  try{
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    const first=sample(child.pid);
    await new Promise(resolve=>setTimeout(resolve,50));
    const last=sample(child.pid);
    const result=delta(first,last);
    assert.ok(Number.isFinite(result.cpuTicksDelta)&&result.cpuTicksDelta>=0);
    assert.ok(Number.isSafeInteger(result.rssKiBEnd)&&result.rssKiBEnd>0);
    console.log('Bounded process CPU/RSS sampler PASS (no sensitive process details emitted)');
  }finally{child.kill('SIGTERM');}
})().catch(e=>{console.error(e.message);process.exitCode=1});
