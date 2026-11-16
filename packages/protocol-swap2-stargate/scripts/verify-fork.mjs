// LOCAL forks only. Funding, DVN verification and nonce-gap alignment are simulated.
import {mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPublicClient,http,parseAbi,encodeFunctionData,encodePacked,keccak256,pad,toHex,zeroAddress} from 'viem';
import {WalletManagerEvm,WalletAccountReadOnlyEvm} from '@anywalletkit/wallet-evm';
import {RouterSwap2Protocol} from '@anywalletkit/protocol-swap2-router';
import {remoteProvider} from '@anywalletkit/protocol-swap2-core/remote';
import {createSwap2Handler} from '@anywalletkit/protocol-swap2-core/server';
import {stargateProvider} from '../dist/provider.js';
import {stargatePins,checkedStargateQuote} from '../dist/pins.js';
import {stargateRegistry} from '../dist/deployments.js';
import {stargateTaxiProof,stargateTaxiPayout} from '../dist/tracking.js';
import {ENDPOINT_ABI} from '../dist/abi.js';
import {fork,jsonServer,closeServer,fundedImpersonation,localCall,journal} from './fork-support.mjs';
import {stringify} from './evidence.mjs';
const phrase='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // PUBLIC TEST VECTOR ONLY
const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)']);
const relayAbi=parseAbi(['struct Origin {uint32 srcEid; bytes32 sender; uint64 nonce;}','function getReceiveLibrary(address,uint32) view returns(address,bool)','function verify(Origin,address,bytes32)','function inboundNonce(address,uint32,bytes32) view returns(uint64)','function skip(address,uint32,bytes32,uint64)']);
const check=(ok,code)=>{if(!ok)throw new Error(`fork: ${code}`);},same=(a,b)=>a.toLowerCase()===b.toLowerCase();
let stage='setup';
const config=(rpcUrls,scanUrl)=>({enabled:true,rpcUrls,scanUrl,quoteTtlMs:120000,confirmations:{'eip155:8453':1,'eip155:42161':1}});
async function assertLocal(url) {
  const u=new URL(url);check(u.hostname==='127.0.0.1'&&u.protocol==='http:','nonlocal test signer refused');
  const info=await createPublicClient({transport:http(url,{retryCount:0})}).request({method:'anvil_nodeInfo'});
  check(new URL(info.forkConfig.forkUrl).hostname==='127.0.0.1','fork must use read-only loopback upstream');
}
const remote=(cfg,server)=>remoteProvider({name:'stargate',baseUrl:server,allowInsecureBaseUrl:true,headers:{authorization:'Bearer fork-only'},timeoutMs:60000,...stargatePins(cfg)});
async function resumeWorker(path) {
  const a=JSON.parse(await readFile(path,'utf8'));for(const u of Object.values(a.rpcUrls))await assertLocal(u);
  const store=journal(a.database),account=new WalletAccountReadOnlyEvm(a.actor,{provider:a.rpcUrls['eip155:8453'],chainId:8453});
  const router=new RouterSwap2Protocol(account,{fromChain:'eip155:8453',providers:[remote(config(a.rpcUrls,a.server),a.server)],operationStore:store});
  try {const r=await router.resumeSwap2(a.operationId);check(r.status.state==='completed','fresh-process resume did not verify completion');check(r.operation.steps.filter(s=>s.kind==='source').length===1,'source duplicated');await writeFile(a.result,stringify({status:r.status,phase:r.operation.phase,steps:r.operation.steps,readOnly:true}));}finally{store.close();}
}
async function childResume(a,dir) {
  const path=join(dir,`${a.operationId}.json`),result=join(dir,`${a.operationId}-result.json`);await writeFile(path,JSON.stringify({...a,result}));
  await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fileURLToPath(import.meta.url),'--resume',path],{stdio:'ignore'});p.once('error',reject);p.once('exit',c=>c===0?resolve():reject(new Error('fork: resume worker failed')));});return JSON.parse(await readFile(result,'utf8'));
}
async function main() {
  const resources=[],managers=[],dir=await mkdtemp(join(tmpdir(),'awk-stargate-fork-'));let server,store;
  try {
    stage='start Base fork';const src=await fork(8453,process.env.RPC_8453??'https://mainnet.base.org');resources.push(src);
    stage='start Arbitrum fork';const dst=await fork(42161,process.env.RPC_42161??'https://arb1.arbitrum.io/rpc');resources.push(dst);
    const rpcUrls={'eip155:8453':src.url,'eip155:42161':dst.url};for(const u of Object.values(rpcUrls))await assertLocal(u);
    const manager=new WalletManagerEvm(phrase,{provider:src.url,chainId:8453}),destManager=new WalletManagerEvm(phrase,{provider:dst.url,chainId:42161});managers.push(manager,destManager);
    const account=await manager.getAccount(123456),destAccount=await destManager.getAccount(123456),actor=await account.getAddress(),recipient=await(await destManager.getAccount(123457)).getAddress();
    for(const f of [src,dst]){for(const a of [actor,recipient])check(!await f.client.getCode({address:a}),'test account already has deployed/delegated code');await f.client.request({method:'anvil_setBalance',params:[actor,toHex(10n**20n)]});}
    const database=join(dir,'operations.sqlite');store=journal(database);const hints=new Map(),quotes=[];let handle;
    server=await jsonServer(async(req,body)=>{
      if(req.method==='GET'){const guid=req.url.split('/').at(-1);return {data:hints.has(guid)?[{guid,destination:{tx:{txHash:hints.get(guid)}}}]:[]};}
      if(req.headers.authorization!=='Bearer fork-only')return {status:401,body:{error:'unauthorized'}};
      return handle(req.url.split('/').at(-1),body,req);
    });
    const cfg=config(rpcUrls,server.url),direct=stargateProvider(cfg),getQuote=direct.getQuote;
    direct.getQuote=async(...args)=>{const q=await getQuote(...args);if(q&&args[0].dry===false)quotes.push(q);return q;};
    handle=createSwap2Handler({providers:[direct],sealSecret:'local-fork-test-sealing-key-not-a-production-secret',guard:()=>{}});
    const pins=stargatePins(cfg),provider=remote(cfg,server.url),cases=[];
    for(const [assetId,ambiguous,cachedFailure] of [[13,false,false],[1,true,false],[13,false,true]]) {
      const source=stargateRegistry.deployments.find(d=>d.chain==='eip155:8453'&&d.assetId===assetId),destination=stargateRegistry.deployments.find(d=>d.chain==='eip155:42161'&&d.assetId===assetId);
      const amount=assetId===13?1000000000000123n:10000000n,operationId=`fork-${assetId}${cachedFailure?'-cached':''}`;
      stage=`fund local asset ${assetId}`;
      if(source.token!==zeroAddress)await fundedImpersonation(src.client,source.address,()=>localCall(src.client,source.address,source.token,encodeFunctionData({abi:tokenAbi,functionName:'transfer',args:[actor,amount]})));
      const balance=(c,token,owner)=>token===zeroAddress?c.getBalance({address:owner}):c.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[owner]});
      const beforeNative=await balance(src.client,zeroAddress,actor),beforeToken=await balance(src.client,source.token,actor),beforeDest=await balance(dst.client,destination.token,recipient);
      let reviewed=false,sends=0;const reviews=[];
      const router=new RouterSwap2Protocol(account,{fromChain:source.chain,providers:[provider],operationStore:store,reviewExecution:async(plan)=>{
        check(plan.provider==='stargate'&&plan.routeId==='taxi'&&plan.sourceAmount===amount&&same(plan.recipient,recipient)&&plan.minDestAmount>0n,'wrong reviewed terms');
        check(plan.source.kind==='call'&&same(plan.source.to,source.address)&&plan.source.value<10n**17n,'wrong reviewed source');
        check(plan.approvals.every(a=>same(a.spender,source.address)&&same(a.token,source.token)&&a.amount===amount),'nonexact approval');reviews.push(plan);reviewed=true;
      }});
      const send=account.sendTransaction.bind(account);account.sendTransaction=async(tx,...rest)=>{
        check(reviewed,'signature before review');check((await store.load(operationId)).steps.at(-1)?.state==='pending','missing durable write-ahead');
        const sent=await send(tx,...rest);sends++;if(ambiguous&&same(tx.to,source.address))throw Object.assign(new Error('simulated lost broadcast reply'),{maybeSent:true,hash:sent.hash});return sent;
      };
      const options={fromToken:source.token,toToken:destination.token,toChain:destination.chain,recipient,fromTokenAmount:amount,minAmountOut:assetId===13?990000000000000n:9900000n,slippage:0.005,operationId};
      stage=`execute ${assetId} through HTTP backend`;let submitted,error;try{submitted=await router.using('stargate','taxi').swap2(options);}catch(e){error=e;}account.sendTransaction=send;
      if(!ambiguous&&error)throw error;check(ambiguous?error?.maybeSent===true:!!submitted,'unexpected source submission outcome');
      const row=await store.load(operationId),sourceStep=row.steps.find(s=>s.kind==='source');check(sourceStep?.hash,'missing journal source hash');
      const receipt=await src.client.waitForTransactionReceipt({hash:sourceStep.hash});check(receipt.status==='success','source reverted');
      const q=quotes.filter(q=>q.sourceAmount===String(amount)).at(-1);check(q,'execution quote missing');const {intent}=checkedStargateQuote(q,stargateRegistry),proof=stargateTaxiProof(intent,receipt);
      const receipts=await Promise.all(row.steps.map(s=>src.client.getTransactionReceipt({hash:s.hash}))),gas=receipts.reduce((n,r)=>n+r.gasUsed*r.effectiveGasPrice,0n);
      const messaging=beforeNative-await balance(src.client,zeroAddress,actor)-gas-(assetId===13?intent.amount-intent.amount%10n**12n:0n);
      check(messaging>0n&&messaging<=BigInt(q.txRequest.nativeFee),'messaging refund/dust accounting');
      if(assetId!==13){check(beforeToken-await balance(src.client,source.token,actor)===amount,'wrong input debit');check(await src.client.readContract({address:source.token,abi:tokenAbi,functionName:'allowance',args:[actor,source.address]})===0n,'residual allowance');check(row.steps.filter(s=>s.kind==='approval').length===1,'approval missing');}
      stage=`verify local relay ${assetId}`;
      const origin={srcEid:source.eid,sender:pad(source.tokenMessaging,{size:32}),nonce:proof.nonce};
      const [receiveLib]=await dst.client.readContract({address:destination.endpoint,abi:relayAbi,functionName:'getReceiveLibrary',args:[destination.tokenMessaging,source.eid]});
      let inbound=await dst.client.readContract({address:destination.endpoint,abi:relayAbi,functionName:'inboundNonce',args:[destination.tokenMessaging,source.eid,origin.sender]});
      check(inbound<proof.nonce&&proof.nonce-inbound<100n,'fork channel cannot be aligned');const skipped=[];
      await fundedImpersonation(dst.client,destination.tokenMessaging,async()=>{while(inbound+1n<proof.nonce){inbound++;const r=await localCall(dst.client,destination.tokenMessaging,destination.endpoint,encodeFunctionData({abi:relayAbi,functionName:'skip',args:[destination.tokenMessaging,source.eid,origin.sender,inbound]}));skipped.push(r.transactionHash);}});
      const verification=await fundedImpersonation(dst.client,receiveLib,()=>localCall(dst.client,receiveLib,destination.endpoint,encodeFunctionData({abi:relayAbi,functionName:'verify',args:[origin,destination.tokenMessaging,keccak256(encodePacked(['bytes32','bytes'],[proof.guid,proof.message]))]})));
      let cachedDelivery;
      if(cachedFailure){
        // LOCAL fault injection: recipient rejects ETH, then becomes an EOA again.
        await dst.client.request({method:'anvil_setCode',params:[recipient,'0x60006000fd']});
        cachedDelivery=await fundedImpersonation(dst.client,receiveLib,()=>localCall(dst.client,receiveLib,destination.endpoint,encodeFunctionData({abi:ENDPOINT_ABI,functionName:'lzReceive',args:[origin,destination.tokenMessaging,proof.guid,proof.message,'0x']})));
        check(!stargateTaxiPayout(proof,cachedDelivery),'rejected native payout reported as paid');
        await dst.client.request({method:'anvil_setCode',params:[recipient,'0x']});
      }
      const recoveryKind=cachedFailure?'retry-token':'retry-message',recoveryTarget=cachedFailure?destination.address:destination.endpoint;
      stage=`discover and execute paid recovery ${assetId}`;
      const resumed=await router.resumeSwap2(operationId);check(resumed.status.state==='action-required'&&resumed.id,'pending verified payload not recoverable');
      const offer=(await router.getSwap2RecoveryQuotes(resumed.id)).find(q=>q.kind===recoveryKind);check(offer,'missing remote recovery');
      check(await pins.verifyRecovery({intentId:row.intentId,sourceTxHash:sourceStep.hash},{...offer,tx:{...offer.tx,to:actor}},actor)!==null,'changed recovery accepted');
      let recoveryReviewed=false;const destSend=destAccount.sendTransaction.bind(destAccount);destAccount.sendTransaction=async(tx,...args)=>{check(recoveryReviewed,'recovery signed before review');return destSend(tx,...args);};
      const recovery=await router.recoverSwap2(resumed.id,offer.id,destAccount,{operationId:`${operationId}-recovery`,maxNativeValue:0n,review:async(o)=>{check(o.kind===recoveryKind&&o.tx.value==='0'&&same(o.tx.to,recoveryTarget),'wrong recovery review');recoveryReviewed=true;}});destAccount.sendTransaction=destSend;
      const delivered=await dst.client.waitForTransactionReceipt({hash:recovery.hash});check(stargateTaxiPayout(proof,delivered),'payout proof missing');hints.set(proof.guid,delivered.transactionHash);
      const delta=await balance(dst.client,destination.token,recipient)-beforeDest;check(delta===proof.amount,'destination balance delta mismatch');check((await router.getSwap2RecoveryQuotes(resumed.id)).length===0,'consumed replay offered');
      const nonceBefore=await src.client.getTransactionCount({address:actor});stage=`fresh-process resume ${assetId}`;
      const reopened=await childResume({rpcUrls,server:server.url,database,actor,operationId},dir);
      let repeated=false;try{await router.using('stargate','taxi').swap2(options);}catch(e){repeated=/already exists/.test(e.message);}check(repeated&&await src.client.getTransactionCount({address:actor})===nonceBefore,'restart duplicated a send');
      cases.push({assetId,amount,source:source.chain,destination:destination.chain,sourceHash:sourceStep.hash,guid:proof.guid,amountReceived:proof.amount,messagingPaid:messaging,sourceGasPaid:gas,reviews,sourceSteps:row.steps,ambiguousReplySimulated:ambiguous,cachedRecipientFailureSimulated:cachedFailure,cachedDeliveryHash:cachedDelivery?.transactionHash,recoveryKind,sourceSendCount:sends,relay:{dvnSimulated:true,receiveLibrary:receiveLib,verificationHash:verification.transactionHash,skippedLocalNonces:skipped},recoveryHash:delivered.transactionHash,resume:reopened,destinationBalanceDelta:delta,replayRefused:true});
      console.log(`Fork verified: ${source.symbol}, HTTP quote/build, payout, paid recovery, process restart${ambiguous?', lost reply':''}${cachedFailure?', cached token retry':''}`);
    }
    const report={schemaVersion:1,kind:'local-mainnet-fork-integration',capturedAt:new Date().toISOString(),publicTransactionsSent:0,limitations:['Local simulated funding and DVN verification; not a funded public cross-chain transfer','One-confirmation LOCAL policy; no real network finality/latency or mobile device assertion'],forks:resources.map(r=>r.head),cases};
    const file=new URL('../tests/fixtures/fork.json',import.meta.url),tmp=new URL('../tests/fixtures/fork.json.tmp',import.meta.url);await writeFile(tmp,stringify(report));await rename(tmp,file);
  }finally{store?.close();for(const m of managers)m.dispose();if(server)await closeServer(server.server);for(const r of resources.reverse())await r.stop();await rm(dir,{recursive:true,force:true});}
}
try{if(process.argv[2]==='--resume')await resumeWorker(process.argv[3]);else await main();}
catch(e){console.error(`Stargate fork failed at ${stage}: ${e.message?.startsWith('fork:')?e.message:e.name}. No public transactions sent.`);process.exitCode=1;}
