// PUBLIC MAINNET. Default run only quotes; `--send <case>` broadcasts one capped Taxi transfer.
// The signer phrase comes from STARGATE_ENV_FILE (TEST_WALLET_MNEMONIC=...) and is never printed.
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createPublicClient,http,parseAbi,formatUnits,zeroAddress} from 'viem';
import {WalletManagerEvm,WalletAccountReadOnlyEvm} from '@anywalletkit/wallet-evm';
import {RouterSwap2Protocol} from '@anywalletkit/protocol-swap2-router';
import {remoteProvider} from '@anywalletkit/protocol-swap2-core/remote';
import {createSwap2Handler} from '@anywalletkit/protocol-swap2-core/server';
import {stargateProvider} from '../dist/provider.js';
import {stargatePins,checkedStargateQuote} from '../dist/pins.js';
import {stargateRegistry} from '../dist/deployments.js';
import {stargateTaxiProof} from '../dist/tracking.js';
import {jsonServer,closeServer,journal} from './fork-support.mjs';
import {stringify} from './evidence.mjs';
const RPC={'eip155:8453':process.env.RPC_8453??'https://mainnet.base.org','eip155:42161':process.env.RPC_42161??'https://arb1.arbitrum.io/rpc'};
// Hard caps: amount per case and the native value (messaging fee + ETH amount) a reviewed source may carry.
const CASES={
  'base-arb-eth':{from:'eip155:8453',to:'eip155:42161',assetId:13,amount:800000000000000n,min:792000000000000n,maxValue:1800000000000000n},
  'arb-base-eth':{from:'eip155:42161',to:'eip155:8453',assetId:13,amount:800000000000000n,min:792000000000000n,maxValue:1800000000000000n},
  'base-arb-usdc':{from:'eip155:8453',to:'eip155:42161',assetId:1,amount:2000000n,min:1980000n,maxValue:1000000000000000n},
  'arb-base-usdc':{from:'eip155:42161',to:'eip155:8453',assetId:1,amount:2000000n,min:1980000n,maxValue:1000000000000000n},
};
const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)']);
const check=(ok,code)=>{if(!ok)throw new Error(`mainnet: ${code}`);},same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const log=(...a)=>console.log(new Date().toISOString().slice(11,19),...a);
const DIR=process.env.STARGATE_MAINNET_DIR??join(homedir(),'.awk-stargate-mainnet'),DATABASE=join(DIR,'operations.sqlite');
const REPORT=new URL('../tests/fixtures/mainnet-funded.json',import.meta.url);
const config=()=>({enabled:true,rpcUrls:RPC,quoteTtlMs:120000});
const client=(chain)=>createPublicClient({transport:http(RPC[chain],{retryCount:3,timeout:20000})});
const balance=(chain,token,owner)=>token===zeroAddress?client(chain).getBalance({address:owner}):client(chain).readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[owner]});
const sides=(c)=>[stargateRegistry.deployments.find(d=>d.chain===c.from&&d.assetId===c.assetId),stargateRegistry.deployments.find(d=>d.chain===c.to&&d.assetId===c.assetId)];
async function phrase() {
  const file=process.env.STARGATE_ENV_FILE;check(file,'set STARGATE_ENV_FILE');
  const line=(await readFile(file,'utf8')).split('\n').map(l=>/^TEST_WALLET_MNEMONIC=(.*)$/.exec(l.trim())).find(Boolean);
  const value=line?.[1].replace(/^(["'])(.*)\1$/,'$2').trim();check(value&&value.split(/\s+/).length>=12,'TEST_WALLET_MNEMONIC missing');return value;
}
// Production shape: quotes/builds cross a sealed HTTP backend; the client keeps its own pins and RPCs.
async function backend() {
  const quotes=[],direct=stargateProvider(config()),getQuote=direct.getQuote;
  direct.getQuote=async(...args)=>{const q=await getQuote(...args);if(q&&args[0].dry===false)quotes.push(q);return q;};
  const handle=createSwap2Handler({providers:[direct],sealSecret:'local-mainnet-verification-seal-not-a-production-secret',guard:()=>{}});
  const server=await jsonServer(async(req,body)=>req.headers.authorization==='Bearer mainnet-local'?handle(req.url.split('/').at(-1),body,req):{status:401,body:{error:'unauthorized'}});
  const provider=remoteProvider({name:'stargate',baseUrl:server.url,allowInsecureBaseUrl:true,headers:{authorization:'Bearer mainnet-local'},timeoutMs:60000,...stargatePins(config())});
  return {quotes,provider,close:()=>closeServer(server.server)};
}
async function appendReport(entry) {
  const report=await readFile(REPORT,'utf8').then(JSON.parse).catch(()=>({schemaVersion:1,kind:'public-mainnet-funded',limitations:['Small capped transfers from one test wallet; not a load or latency study'],cases:[]}));
  const old=report.cases.find(c=>c.operationId===entry.operationId);report.cases=[...report.cases.filter(c=>c!==old),{...old,...entry}];report.updatedAt=new Date().toISOString();
  const tmp=new URL('../tests/fixtures/mainnet-funded.json.tmp',import.meta.url);await writeFile(tmp,stringify(report));await rename(tmp,REPORT);
}
async function track(router,operationId,timeoutMs) {
  const deadline=Date.now()+timeoutMs;let last;
  for(;;){
    const r=await router.resumeSwap2(operationId);
    if(r.status.state!==last){last=r.status.state;log(`status ${last}${r.status.destTxHash?` dest ${r.status.destTxHash}`:''}`);}
    if(['completed','failed','refunded','action-required'].includes(r.status.state)||Date.now()>deadline)return r;
    await new Promise(res=>setTimeout(res,30000));
  }
}
async function main() {
  const [mode,name]=process.argv.slice(2);
  const manager=(chain)=>phrase().then(p=>new WalletManagerEvm(p,{provider:RPC[chain],chainId:Number(chain.split(':')[1])}));
  const probe=await manager('eip155:8453'),actor=await(await probe.getAccount(0)).getAddress();probe.dispose();
  log(`actor ${actor}`);
  for(const chain of Object.keys(RPC))log(chain,'ETH',formatUnits(await balance(chain,zeroAddress,actor),18),'USDC',formatUnits(await balance(chain,stargateRegistry.deployments.find(d=>d.chain===chain&&d.assetId===1).token,actor),6));
  await mkdir(DIR,{recursive:true,mode:0o700});
  if(mode==='--resume'){
    // Fresh process, read-only account: the journal alone must reconstruct the transfer.
    const store=journal(DATABASE),op=await store.load(name);check(op,'unknown operation');const {provider,close}=await backend();
    try{const router=new RouterSwap2Protocol(new WalletAccountReadOnlyEvm(actor,{provider:RPC[op.sourceChain],chainId:Number(op.sourceChain.split(':')[1])}),{fromChain:op.sourceChain,providers:[provider],operationStore:store});
      const r=await track(router,name,Number(process.env.STARGATE_TRACK_MS??2400000));log(`resumed ${name}: ${r.status.state}, source steps ${r.operation.steps.filter(s=>s.kind==='source').length}`);
      await appendReport({operationId:name,resume:{readOnlyProcess:true,status:r.status,sourceSteps:r.operation.steps.filter(s=>s.kind==='source').length,checkedAt:new Date().toISOString()}});
    }finally{store.close();await close();}
    return;
  }
  const {quotes,provider,close}=await backend();
  try{
    if(mode!=='--send'){
      for(const [id,c] of Object.entries(CASES)){
        const [source,destination]=sides(c),router=new RouterSwap2Protocol(new WalletAccountReadOnlyEvm(actor,{provider:RPC[c.from],chainId:Number(c.from.split(':')[1])}),{fromChain:c.from,providers:[provider]});
        const q=await router.using('stargate','taxi').quoteSwap2({fromToken:source.token,toToken:destination.token,toChain:c.to,recipient:actor,fromTokenAmount:c.amount,slippage:0.005}).catch(e=>({error:e.message}));
        log(id,q.error??`out ${q.toTokenAmount} min ${q.toTokenAmountMin} fees ${(q.fees??[]).map(f=>`${f.type}=${f.amount}`).join(" ")}`);
      }
      return;
    }
    const c=CASES[name];check(c,`unknown case; one of ${Object.keys(CASES).join(', ')}`);
    const [source,destination]=sides(c),operationId=`mainnet-${name}-${Date.now()}`;
    const m=await manager(c.from),account=await m.getAccount(0);
    const store=journal(DATABASE);let reviewed;
    try{
      const beforeSrcNative=await balance(c.from,zeroAddress,actor),beforeSrcToken=await balance(c.from,source.token,actor),beforeDest=await balance(c.to,destination.token,actor);
      check(beforeSrcToken>=c.amount&&beforeSrcNative>=c.maxValue,'insufficient source balance');
      const router=new RouterSwap2Protocol(account,{fromChain:c.from,providers:[provider],operationStore:store,reviewExecution:async(plan)=>{
        check(plan.provider==='stargate'&&plan.routeId==='taxi'&&plan.sourceAmount===c.amount&&same(plan.recipient,actor)&&plan.minDestAmount>0n,'wrong reviewed terms');
        check(plan.source.kind==='call'&&same(plan.source.to,source.address)&&plan.source.value<=c.maxValue,'source value above cap');
        check(plan.approvals.every(a=>same(a.spender,source.address)&&same(a.token,source.token)&&a.amount===c.amount),'nonexact approval');
        reviewed=plan;log(`reviewed: value ${plan.source.value}, min out ${plan.minDestAmount}, approvals ${plan.approvals.length}`);
      }});
      const options={fromToken:source.token,toToken:destination.token,toChain:c.to,recipient:actor,fromTokenAmount:c.amount,minAmountOut:c.min,slippage:0.005,operationId};
      log(`send ${name} ${operationId}`);
      await router.using('stargate','taxi').swap2(options);
      const row=await store.load(operationId),sourceStep=row.steps.find(s=>s.kind==='source');check(sourceStep?.hash,'missing journal source hash');
      const receipt=await client(c.from).waitForTransactionReceipt({hash:sourceStep.hash});check(receipt.status==='success','source reverted');
      const q=quotes.at(-1),{intent}=checkedStargateQuote(q,stargateRegistry),proof=stargateTaxiProof(intent,receipt);
      const receipts=await Promise.all(row.steps.filter(s=>s.hash&&s.chain===c.from).map(s=>client(c.from).getTransactionReceipt({hash:s.hash}))),gas=receipts.reduce((n,r)=>n+r.gasUsed*r.effectiveGasPrice+(r.l1Fee??0n),0n);
      const spentNative=beforeSrcNative-await balance(c.from,zeroAddress,actor);
      const residual=source.token===zeroAddress?0n:await client(c.from).readContract({address:source.token,abi:tokenAbi,functionName:'allowance',args:[actor,source.address]});check(residual===0n,'residual allowance');
      log(`source ${sourceStep.hash} guid ${proof.guid} amount ${proof.amount}; tracking`);
      const entry={operationId,case:name,actor,source:c.from,destination:c.to,symbol:source.symbol,amount:String(c.amount),sourceHash:sourceStep.hash,guid:proof.guid,amountReceivedLD:String(proof.amount),quotedMin:String(reviewed.minDestAmount),nativeFeeCap:q.txRequest.nativeFee,sourceValue:String(reviewed.source.value),sourceNativeSpent:String(spentNative),sourceGasReceipts:String(gas),steps:row.steps.map(s=>({kind:s.kind,state:s.state,hash:s.hash})),sentAt:new Date().toISOString()};
      await appendReport(entry);
      const r=await track(router,operationId,Number(process.env.STARGATE_TRACK_MS??2400000));
      const delta=await balance(c.to,destination.token,actor)-beforeDest;
      await appendReport({...entry,status:r.status,destinationBalanceDelta:String(delta),completedAt:new Date().toISOString()});
      log(`${name}: ${r.status.state}; destination delta ${delta} (proof amount ${proof.amount})`);
      check(r.status.state==='completed','not completed within the tracking window; resume later with --resume '+operationId);
    }finally{store.close();m.dispose();}
  }finally{await close();}
}
try{await main();}catch(e){console.error(e.message?.startsWith('mainnet:')?e.message:e);process.exitCode=1;}
