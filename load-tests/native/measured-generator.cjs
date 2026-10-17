'use strict';
// Bounded Linux-only resource accounting around a child load-generator process.
// Never print command lines, environment, URLs, PIDs or raw workload output.
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const {sample}=require('./process-resource-sampler.cjs');
async function runMeasured(command,args,{timeoutMs=90000,intervalMs=25,env=process.env,outputFile=null}={}){
  if(typeof command!=='string'||!command||!Array.isArray(args)||!args.every(x=>typeof x==='string'))throw Error('Invalid generator command');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw Error('Invalid generator timeout');
  const outputFd=outputFile?fs.openSync(outputFile,'w',0o600):null;
  let child;
  try{child=spawn(command,args,{env,stdio:outputFd===null?'ignore':['ignore',outputFd,outputFd]});}
  finally{if(outputFd!==null)fs.closeSync(outputFd);}
  let timer;let timeout;
  try{
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('Generator spawn failed')));});
    const start=sample(child.pid);
    let peakRssKiB=start.rssKiB;
    let samples=1;
    let readErrors=0;
    let readErrorCategory='unknown';
    let vanishedAtExit=0;
    let exited=false;
    let lastCpuTicks=start.cpuTicks;
    timer=setInterval(()=>{if(exited)return;try{const current=sample(child.pid);peakRssKiB=Math.max(peakRssKiB,current.rssKiB);lastCpuTicks=current.cpuTicks;samples++;}catch(error){if(error?.code==='ENOENT'||error?.code==='ESRCH'||(error?.message==='Incomplete process resource counters'&&child.exitCode!==null))vanishedAtExit++;else {readErrors++;readErrorCategory=error?.code==='EACCES'?'permission':error?.code==='EIO'?'io':error?.message==='Incomplete process CPU counters'?'cpu-incomplete':error?.message==='Incomplete process RSS counters'?'rss-incomplete':error?.message==='Malformed proc stat'?'malformed':'other';}}},intervalMs);
    const code=await Promise.race([
      new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>{exited=true;return signal?reject(Error('Generator terminated by signal')):resolve(code);});child.once('error',()=>reject(Error('Generator runtime error')));}),
      new Promise((_,reject)=>{timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Generator timed out'));},timeoutMs);})
    ]);
    // /proc disappears on exit: last in-flight sample is the final observable
    // resource value, and CPU ticks are sampled before process exit.
    if(samples<2)throw Error('Generator resource sample count insufficient');
    if(readErrors>0)throw Error('Generator resource sampling read error: '+readErrorCategory);
    if(!Number.isSafeInteger(lastCpuTicks)||lastCpuTicks<start.cpuTicks||!Number.isSafeInteger(peakRssKiB)||peakRssKiB<=0)throw Error('Generator resource counters invalid');
    if(code!==0)throw Error('Generator exited nonzero (output redacted)');
    return {exitCode:code,cpuTicksDeltaSampled:lastCpuTicks-start.cpuTicks,peakRssKiB,samples,vanishedAtExit,measurement:'sampled process counters only; excludes post-last-sample CPU; proc disappearance counted separately'};
  }finally{clearInterval(timer);clearTimeout(timeout);if(child.exitCode===null)child.kill('SIGKILL');}
}
module.exports={runMeasured};
