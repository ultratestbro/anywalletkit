// Test infrastructure only. Public upstreams accept READ methods; all writes stay on owned Anvil nodes.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createPublicClient, http, toHex} from 'viem';
const reads = new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getBalance','eth_getCode','eth_getStorageAt','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_call','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory']);
const listen = (s) => new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${s.address().port}`));});
export const closeServer = (s) => new Promise(r=>{s.close(r);s.closeAllConnections();});
export async function jsonServer(handle) {
  const server=createServer(async(req,res)=>{
    try {
      let body='';for await(const chunk of req){body+=chunk;if(body.length>2_000_000)throw new Error('body limit');}
      const result=await handle(req,body ? JSON.parse(body) : null);
      res.writeHead(result.status??200,{'content-type':'application/json'});res.end(JSON.stringify(result.body??result));
    }catch{res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'local test request failed'}));}
  });
  return {server,url:await listen(server)};
}
export async function fork(chainId,url) {
  const upstream=createPublicClient({transport:http(url,{retryCount:1,timeout:20000})});
  if(await upstream.getChainId()!==chainId)throw new Error('upstream chain mismatch');
  const head=await upstream.getBlock();
  const proxy=await jsonServer(async(_req,body)=>{
    if(Array.isArray(body)||!reads.has(body.method))return {status:403,body:{error:'read-only upstream'}};
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('upstream unavailable');
    return {body:await response.json()};
  });
  const reserve=createServer();const local=await listen(reserve);await closeServer(reserve);
  const port=new URL(local).port;
  const child=spawn(process.env.ANVIL_BIN??'anvil',['--host','127.0.0.1','--port',port,'--accounts','0','--chain-id',String(chainId),'--fork-url',proxy.url,'--fork-block-number',String(head.number)],{stdio:'ignore'});
  let failure;child.on('error',()=>{failure=true;});
  const client=createPublicClient({transport:http(local,{retryCount:0,timeout:20000}),cacheTime:0,pollingInterval:50});
  const stop=async()=>{child.kill('SIGTERM');await closeServer(proxy.server);};
  try {
    let ready=false;
    for(let i=0;i<200;i++) {
      if(failure||child.exitCode!==null)throw new Error('Anvil failed to start');
      try {const info=await client.request({method:'anvil_nodeInfo'});if(info.forkConfig?.forkUrl!==proxy.url)throw new Error('not our fork');if(await client.getChainId()!==chainId)throw new Error('wrong fork chain');ready=true;break;}catch{}
      await new Promise(r=>setTimeout(r,100));
    }
    if(!ready)throw new Error('Anvil start timed out');
    return {client,url:local,head:{chainId,number:String(head.number),hash:head.hash,timestamp:String(head.timestamp)},stop};
  }catch(e){await stop();throw e;}
}
export async function fundedImpersonation(client,address,run) {
  await client.request({method:'anvil_setBalance',params:[address,toHex(10n**20n)]});
  await client.request({method:'anvil_impersonateAccount',params:[address]});
  try{return await run();}finally{await client.request({method:'anvil_stopImpersonatingAccount',params:[address]});}
}
export async function localCall(client,from,to,data,value=0n) {
  const hash=await client.request({method:'eth_sendTransaction',params:[{from,to,data,value:toHex(value),gas:'0x7a1200'}]});
  const receipt=await client.waitForTransactionReceipt({hash});
  if(receipt.status!=='success')throw new Error('local fork transaction reverted');
  return receipt;
}
/** Durable CAS in a real database. The test reopens it in a fresh Node process. */
export function journal(path) {
  const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)');
  return {close:()=>db.close(),load:async(id)=>{const r=db.prepare('SELECT body FROM operations WHERE id=?').get(id);return r?JSON.parse(r.body):null;},compareAndSet:async(id,revision,next)=>{
    db.exec('BEGIN IMMEDIATE');
    try {
      const old=db.prepare('SELECT revision FROM operations WHERE id=?').get(id);
      if((old?.revision??null)!==revision){db.exec('ROLLBACK');return false;}
      db.prepare('INSERT INTO operations(id,revision,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(id,next.revision,JSON.stringify(next));
      db.exec('COMMIT');return true;
    }catch(e){db.exec('ROLLBACK');throw e;}
  }};
}
