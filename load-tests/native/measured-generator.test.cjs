'use strict';
const assert=require('node:assert/strict');
const {runMeasured}=require('./measured-generator.cjs');
(async()=>{
  const result=await runMeasured(process.execPath,['-e','setTimeout(()=>{},500)'],{timeoutMs:2000,intervalMs:25});
  assert.equal(result.exitCode,0);
  assert.ok(result.samples>=2);
  assert.ok(result.peakRssKiB>0);
  assert.ok(result.cpuTicksDeltaSampled>=0);
  await assert.rejects(runMeasured(process.execPath,['-e','process.exit(7)'],{timeoutMs:2000}),/Generator exited nonzero|Missing generator resource samples/);
  await assert.rejects(runMeasured(process.execPath,['-e','setTimeout(()=>{},1500)'],{timeoutMs:150,intervalMs:25}),/Generator timed out/);
  await assert.rejects(runMeasured(process.execPath,['-e','setTimeout(()=>{},100)'],{timeoutMs:99}),/Invalid generator timeout/);
  const fast=await runMeasured(process.execPath,['-e','process.exit(0)'],{timeoutMs:2000,intervalMs:25}).then(()=> 'sampled',error=>error.message);
  assert.ok(fast==='sampled'||fast==='Missing generator resource samples','Fast child must either be sampled or rejected without a false metric');
  console.log('Disposable child generator resource accounting PASS (sampled only)');
})().catch(e=>{console.error(e.message);process.exitCode=1});
