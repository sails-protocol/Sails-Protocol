'use strict';
// Bounded Linux-only resource accounting around a child load-generator process.
// Never print command lines, environment, URLs, PIDs or raw workload output.
const {spawn}=require('node:child_process');
const {sample,delta}=require('./process-resource-sampler.cjs');
async function runMeasured(command,args,{timeoutMs=90000,intervalMs=25,env=process.env}={}){
  if(typeof command!=='string'||!command||!Array.isArray(args)||!args.every(x=>typeof x==='string'))throw Error('Invalid generator command');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw Error('Invalid generator timeout');
  const child=spawn(command,args,{env,stdio:'ignore'});
  let timer;let timeout;
  try{
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('Generator spawn failed')));});
    const start=sample(child.pid);
    let peakRssKiB=start.rssKiB;
    let samples=1;
    timer=setInterval(()=>{try{const current=sample(child.pid);peakRssKiB=Math.max(peakRssKiB,current.rssKiB);samples++;}catch{}},intervalMs);
    const code=await Promise.race([
      new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>signal?reject(Error('Generator terminated by signal')):resolve(code));child.once('error',()=>reject(Error('Generator runtime error')));}),
      new Promise((_,reject)=>{timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Generator timed out'));},timeoutMs);})
    ]);
    // /proc disappears on exit: last in-flight sample is the final observable
    // resource value, and CPU ticks are sampled before process exit.
    if(samples<1||!Number.isSafeInteger(peakRssKiB)||peakRssKiB<=0)throw Error('Missing generator resource samples');
    if(code!==0)throw Error('Generator exited nonzero (output redacted)');
    return {exitCode:code,peakRssKiB,samples,measurement:'sampled peak only'};
  }finally{clearInterval(timer);clearTimeout(timeout);if(child.exitCode===null)child.kill('SIGKILL');}
}
module.exports={runMeasured};
