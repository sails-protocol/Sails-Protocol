'use strict';
const assert=require('node:assert/strict');
const {runMeasured,assertRssSampleCoverage}=require('./measured-generator.cjs');
// Boundary proofs: 1% accepted, above 1% rejected; never count missing RSS as zero.
assert.doesNotThrow(()=>assertRssSampleCoverage(100,1));
assert.doesNotThrow(()=>assertRssSampleCoverage(200,2));
assert.doesNotThrow(()=>assertRssSampleCoverage(100,0));
assert.throws(()=>assertRssSampleCoverage(99,1),/sample count insufficient/);
assert.throws(()=>assertRssSampleCoverage(100,2),/sample count insufficient/);
assert.throws(()=>assertRssSampleCoverage(2,1),/sample count insufficient/);
assert.throws(()=>assertRssSampleCoverage(100,-1),/sample count insufficient/);
assert.throws(()=>assertRssSampleCoverage(0,0),/sample count insufficient/);
(async()=>{
  const result=await runMeasured(process.execPath,['-e','setTimeout(()=>{},500)'],{timeoutMs:2000,intervalMs:25});
  assert.equal(result.exitCode,0);
  assert.ok(result.samples>=2);
  assert.ok(result.peakRssKiB>0);
  assert.ok(result.cpuTicksDeltaSampled>=0);
  await assert.rejects(runMeasured(process.execPath,['-e','process.exit(7)'],{timeoutMs:2000}),/Generator exited nonzero|Generator resource sample count insufficient/);
  await assert.rejects(runMeasured(process.execPath,['-e','setTimeout(()=>{},1500)'],{timeoutMs:150,intervalMs:25}),/Generator timed out/);
  await assert.rejects(runMeasured(process.execPath,['-e','setTimeout(()=>{},100)'],{timeoutMs:99}),/Invalid generator timeout/);
  const fast=await runMeasured(process.execPath,['-e','process.exit(0)'],{timeoutMs:2000,intervalMs:25}).then(()=> 'sampled',error=>error.message);
  assert.ok(fast==='sampled'||fast==='Generator resource sample count insufficient','Fast child must either be sampled or rejected without a false metric');
  console.log('Disposable child generator resource accounting PASS (sampled only)');
})().catch(e=>{console.error(e.message);process.exitCode=1});
