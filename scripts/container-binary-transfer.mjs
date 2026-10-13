import {spawnSync} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
function transfer(command,args,file,output,{timeout=120000,env=process.env}={}) {
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>120000)throw new Error('Invalid binary transfer deadline');
 const fd=openSync(file,output?'wx':'r',0o600);
 try {
  const result=spawnSync(command,args,{stdio:output?['ignore',fd,'pipe']:[fd,'pipe','pipe'],timeout,killSignal:'SIGKILL',maxBuffer:65536,env});
  if(result.error||result.signal!==null||result.status!==0)throw new Error('Binary command transfer failed');
  return result;
 }finally{closeSync(fd);}
}
export const writeCommandOutput=(command,args,file,options)=>transfer(command,args,file,true,options);
export const readCommandInput=(command,args,file,options)=>transfer(command,args,file,false,options);