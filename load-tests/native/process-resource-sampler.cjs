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
  if(!Number.isFinite(ticks)||ticks<0||!rss)throw Error('Incomplete process resource counters');
  return {cpuTicks:ticks,rssKiB:Number(rss[1])};
}
function delta(start,end){
  if(end.cpuTicks<start.cpuTicks)throw Error('Non-monotonic CPU counters');
  return {cpuTicksDelta:end.cpuTicks-start.cpuTicks,rssKiBEnd:end.rssKiB};
}
module.exports={sample,delta};
