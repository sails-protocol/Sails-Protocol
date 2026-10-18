'use strict';
// Linux /proc bounded, local-only process resource snapshot. No command lines,
// environment, URLs, tokens or PIDs are printed. Not a benchmark by itself.
const fs=require('node:fs');
function sample(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Invalid process identifier');
  const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');
  const end=stat.lastIndexOf(')');
  if(end<0)throw Error('Malformed proc stat');
  const fields=stat.slice(end+2).trim().split(/\s+/);
  const ticks=Number(fields[11])+Number(fields[12]); // fields 14/15: utime/stime
  const status=fs.readFileSync('/proc/'+pid+'/status','utf8');
  const rss=/^VmRSS:\s+(\d+) kB$/m.exec(status);
  if(!Number.isSafeInteger(ticks)||ticks<0)throw Error('Incomplete process CPU counters');
  if(!rss){
    // The process can exit between reading stat and status. Recheck state;
    // a zombie has no VmRSS and is an expected end-of-life sampling race.
    if(['Z','X','x'].includes(fields[0]))throw Error('Process exited during resource sample');
    try{
      const latest=fs.readFileSync('/proc/'+pid+'/stat','utf8');
      const close=latest.lastIndexOf(')');
      if(close>=0 && ['Z','X','x'].includes(latest.slice(close+2).trim().split(/\s+/)[0]))
        throw Error('Process exited during resource sample');
    }catch(error){
      if(error?.message==='Process exited during resource sample')throw error;
      if(error?.code==='ENOENT'||error?.code==='ESRCH')throw Error('Process exited during resource sample');
      throw error;
    }
    // Linux may omit VmRSS in a transient proc-status snapshot. A second
    // independent proc-statm read can supply resident pages without relaxing
    // the requirement for a positive, finite memory observation.
    try{
      const statm=fs.readFileSync('/proc/'+pid+'/statm','utf8').trim().split(/\s+/);
      const residentPages=Number(statm[1]);
      // The workflow verifies the actual kernel page size with getconf.
      // Fail closed rather than silently treating page counts as KiB.
      const pageKiB=Number(process.env.SAILS_PROC_PAGE_KIB||4);
      if(pageKiB!==4)throw Error('Unsupported process page size');
      const fallbackKiB=residentPages*pageKiB;
      if(Number.isSafeInteger(fallbackKiB)&&fallbackKiB>0)return {cpuTicks:ticks,rssKiB:fallbackKiB};
      // A zero resident count may be an exit transition; only classify it
      // as lifecycle if a fresh /proc/stat read independently confirms exit.
      if(residentPages===0){
        const finalStat=fs.readFileSync('/proc/'+pid+'/stat','utf8');
        const finalClose=finalStat.lastIndexOf(')');
        if(finalClose>=0 && ['Z','X','x'].includes(finalStat.slice(finalClose+2).trim().split(/\s+/)[0]))
          throw Error('Process exited during resource sample');
      }
    }catch(error){
      if(error?.message==='Process exited during resource sample')throw error;
      if(error?.message==='Unsupported process page size')throw error;
      if(error?.code==='ENOENT'||error?.code==='ESRCH')throw Error('Process exited during resource sample');
    }
    // The original stat snapshot also exposes resident pages (field 24).
    // Accept only a positive, safe counter; never turn absent RSS into zero.
    const statResidentPages=Number(fields[21]);
    const statResidentKiB=statResidentPages*Number(process.env.SAILS_PROC_PAGE_KIB||4);
    if(Number.isSafeInteger(statResidentKiB)&&statResidentKiB>0)
      return {cpuTicks:ticks,rssKiB:statResidentKiB};
    // Diagnostic category only: no PID, command line, environment or values.
    // Distinguish live process with absent RSS from a lifecycle transition.
    const finalStat=fs.readFileSync('/proc/'+pid+'/stat','utf8');
    const finalClose=finalStat.lastIndexOf(')');
    const finalFields=finalClose>=0?finalStat.slice(finalClose+2).trim().split(/\s+/):[];
    if(['Z','X','x'].includes(finalFields[0]))throw Error('Process exited during resource sample');
    if(finalFields[0]!==fields[0])throw Error('Process state changed during RSS sample');
    throw Error('Incomplete process RSS counters: live-state-no-positive-rss');
  }
  return {cpuTicks:ticks,rssKiB:Number(rss[1])};
}
function delta(start,end){
  if(end.cpuTicks<start.cpuTicks)throw Error('Non-monotonic CPU counters');
  return {cpuTicksDelta:end.cpuTicks-start.cpuTicks,rssKiBEnd:end.rssKiB};
}
async function observe(pid,work,{intervalMs=25}={}){
  if(typeof work!=='function'||!Number.isSafeInteger(intervalMs)||intervalMs<10||intervalMs>1000)throw Error('Invalid bounded sampling configuration');
  const start=sample(pid);
  let peakRssKiB=start.rssKiB;
  let samples=1;
  let readErrors=0;
  const timer=setInterval(()=>{
    try{const next=sample(pid);peakRssKiB=Math.max(peakRssKiB,next.rssKiB);samples++;}
    catch{readErrors++;}
  },intervalMs);
  try{
    const value=await work();
    const end=sample(pid);
    peakRssKiB=Math.max(peakRssKiB,end.rssKiB);
    const usage=delta(start,end);
    if(readErrors>0||samples<2||!Number.isSafeInteger(usage.cpuTicksDelta)||!Number.isSafeInteger(peakRssKiB)||peakRssKiB<=0)throw Error('Incomplete resource sample');
    return {value,usage:{...usage,peakRssKiB,samples:samples+1}};
  }finally{clearInterval(timer);}
}
module.exports={sample,delta,observe};
