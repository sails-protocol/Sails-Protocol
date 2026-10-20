'use strict';
// Characterization test: a silent disposable server must not be mistaken for PONG parity.
// This intentionally verifies the current send+think baseline is insufficient.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {WebSocketServer}=require('ws');
const yaml=require('yaml');
(async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sails-artillery-silent-'));
  let received=0;
  server.on('connection',socket=>socket.on('message',()=>{received++; /* intentionally never reply */}));
  try{
    const port=server.address().port;
    const cfg={config:{target:'ws://127.0.0.1:'+port,phases:[{duration:1,arrivalRate:1}]},scenarios:[{engine:'ws',flow:[{connect:{}},{send:JSON.stringify({type:'PING',payload:{}})},{think:1}]}]};
    const configPath=path.join(dir,'silent.yml');
    fs.writeFileSync(configPath,yaml.stringify(cfg),{mode:0o600});
    const executable=path.resolve('node_modules/.bin/artillery');
    const exit=await new Promise((resolve,reject)=>{
      const child=spawn(executable,['run',configPath],{stdio:'ignore',env:{...process.env,NO_COLOR:'1'}});
      const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
      child.once('error',reject);
      child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
    });
    assert.ok(received>0,'The Artillery engine must actually send PING to the silent server');
    assert.deepEqual(exit,{code:0,signal:null},'Characterization changed: investigate engine behavior before promoting comparator');
    console.log('Artillery send+think SILENT control: CLI exits 0 despite missing PONG; parity remains RED');
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    for(const client of server.clients)client.terminate();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(()=>{console.error('Artillery silent control failed (details redacted)');process.exitCode=1;});
