'use strict';
// Experimental Artillery engine match proof, never a production benchmark.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {WebSocketServer}=require('ws');
const yaml=require('yaml');
async function runMode(mode){
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sails-artillery-match-'));
  let pings=0;
  server.on('connection',socket=>socket.on('message',raw=>{
    let message;
    try{message=JSON.parse(String(raw));}catch{return;}
    if(message.type!=='PING')return;
    pings++;
    if(mode==='SILENT')return;
    socket.send(JSON.stringify({type:mode==='PONG'?'PONG':'ERROR',payload:{}}));
  }));
  try{
    const config={config:{target:'ws://127.0.0.1:'+server.address().port,phases:[{duration:1,arrivalRate:1}]},scenarios:[{engine:'ws',flow:[{connect:{}},{send:{payload:JSON.stringify({type:'PING',payload:{}}),match:[{json:'$.type',value:'PONG',strict:true}],response:{timeout:2}}}]}]};
    const file=path.join(dir,'match.yml');
    fs.writeFileSync(file,yaml.stringify(config),{mode:0o600});
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(path.resolve('node_modules/.bin/artillery'),['run',file],{stdio:['ignore','pipe','pipe'],env:{...process.env,NO_COLOR:'1'}});
      let output='';const limit=32768;
      for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{if(output.length<limit)output+=String(data).slice(0,limit-output.length);});
      const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
      child.once('error',reject);
      child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,output});});
    });
    assert.ok(pings>0,mode+': actual Artillery PING required');
    if(mode==='PONG')assert.deepEqual({code:result.code,signal:result.signal},{code:0,signal:null},'PONG must succeed');
    else assert.ok(result.code!==0||/response timeout|Failed capture or match|vusers.failed|errors\./i.test(result.output),mode+': engine must report an error');
    console.log('Artillery engine match experiment',mode,'exit:',result.code,'signal:',result.signal||'none','PING count:',pings);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    for(const client of server.clients)client.terminate();
    await new Promise(resolve=>server.close(resolve));
  }
}
(async()=>{for(const mode of ['PONG','SILENT','ERROR'])await runMode(mode);console.log('Artillery match experiment completed; independent review and parity gates remain OPEN');})().catch(()=>{console.error('Artillery engine match experiment FAILED (output redacted)');process.exitCode=1;});
