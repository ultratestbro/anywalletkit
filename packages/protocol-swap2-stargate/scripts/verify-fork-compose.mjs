// LOCAL forks only. Funding, DVN verification and the LayerZero executor's lzCompose are simulated.
import {mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicClient,http,parseAbi,encodeFunctionData,encodePacked,keccak256,pad,toHex} from 'viem';
import {WalletManagerEvm} from '@anywalletkit/wallet-evm';
import {RouterSwap2Protocol} from '@anywalletkit/protocol-swap2-router';
import {remoteProvider} from '@anywalletkit/protocol-swap2-core/remote';
import {createSwap2Handler} from '@anywalletkit/protocol-swap2-core/server';
import {stargateProvider} from '../dist/provider.js';
import {stargatePins} from '../dist/pins.js';
import {stargateRegistry} from '../dist/deployments.js';
import {COMPOSE_ABI,LIFI_COMPOSE_ABI,LIFI_ETHEREUM_COMPOSER} from '../dist/compose.js';
import {checkedStargateComposeQuote,quoteStargateComposeSwap,stargateComposeProof} from '../dist/compose-route.js';
import {stargateComposedTaxiProof} from '../dist/tracking.js';
import {stargateComposeMessage} from '../dist/compose-route.js';
import {fork,jsonServer,closeServer,fundedImpersonation,localCall,journal} from './fork-support.mjs';
import {stringify} from './evidence.mjs';
const phrase='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // PUBLIC TEST VECTOR ONLY
const DAI='0x6B175474E89094C44Da98b954EedeAC495271d0F';
const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)']);
const relayAbi=parseAbi(['struct Origin {uint32 srcEid; bytes32 sender; uint64 nonce;}','function getReceiveLibrary(address,uint32) view returns(address,bool)','function verify(Origin,address,bytes32)','function inboundNonce(address,uint32,bytes32) view returns(uint64)','function skip(address,uint32,bytes32,uint64)','function lzReceive(Origin,address,bytes32,bytes,bytes) payable']);
const check=(ok,code)=>{if(!ok)throw new Error(`fork: ${code}`);},same=(a,b)=>a.toLowerCase()===b.toLowerCase();
let stage='setup';
const config=(rpcUrls,scanUrl,composeRetryAfterS)=>({enabled:true,rpcUrls,scanUrl,quoteTtlMs:120000,confirmations:{'eip155:42161':1,'eip155:1':1},compose:{enabled:true},composeRetryAfterS});
async function assertLocal(url) {
  const u=new URL(url);check(u.hostname==='127.0.0.1'&&u.protocol==='http:','nonlocal test signer refused');
  const info=await createPublicClient({transport:http(url,{retryCount:0})}).request({method:'anvil_nodeInfo'});
  check(new URL(info.forkConfig.forkUrl).hostname==='127.0.0.1','fork must use read-only loopback upstream');
}
async function main() {
  const resources=[],managers=[],dir=await mkdtemp(join(tmpdir(),'awk-stargate-compose-'));let server,store;
  try {
    stage='start Arbitrum fork';const src=await fork(42161,process.env.RPC_42161??'https://arb1.arbitrum.io/rpc');resources.push(src);
    stage='start Ethereum fork';const dst=await fork(1,process.env.RPC_1??'https://ethereum-rpc.publicnode.com');resources.push(dst);
    const rpcUrls={'eip155:42161':src.url,'eip155:1':dst.url};for(const u of Object.values(rpcUrls))await assertLocal(u);
    // Anvil loads pool state lazily: one cold QuoterV2 batch exceeds the SDK's 12 s RPC timeout. Warm it once.
    stage='warm Ethereum pool state';const warm=createPublicClient({transport:http(dst.url,{timeout:600_000,retryCount:0})});await quoteStargateComposeSwap(warm,await warm.getBlockNumber(),'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',DAI,20_000_000n);
    const manager=new WalletManagerEvm(phrase,{provider:src.url,chainId:42161}),destManager=new WalletManagerEvm(phrase,{provider:dst.url,chainId:1});managers.push(manager,destManager);
    const account=await manager.getAccount(123456),destAccount=await destManager.getAccount(123456),actor=await account.getAddress(),recipient=await(await destManager.getAccount(123457)).getAddress();
    for(const f of [src,dst]){for(const a of [actor,recipient])check(!await f.client.getCode({address:a}),'test account already has deployed/delegated code');await f.client.request({method:'anvil_setBalance',params:[actor,toHex(10n**20n)]});}
    store=journal(join(dir,'operations.sqlite'));const hints=new Map(),quotes=[];let handle;
    server=await jsonServer(async(req,body)=>{
      if(req.method==='GET'){const guid=req.url.split('/').at(-1),h=hints.get(guid);return {data:h?[{guid,destination:{tx:{txHash:h.delivery},lzCompose:{txs:h.compose.map(txHash=>({txHash}))}}}]:[]};}
      if(req.headers.authorization!=='Bearer fork-only')return {status:401,body:{error:'unauthorized'}};
      return handle(req.url.split('/').at(-1),body,req);
    });
    const cfg=config(rpcUrls,server.url,0),direct=stargateProvider(cfg),getQuote=direct.getQuote;
    direct.getQuote=async(...args)=>{const q=await getQuote(...args);if(q&&args[0].dry===false)quotes.push(q);return q;};
    handle=createSwap2Handler({providers:[direct],sealSecret:'local-fork-test-sealing-key-not-a-production-secret',guard:()=>{}});
    const remote=(c)=>remoteProvider({name:'stargate',baseUrl:server.url,allowInsecureBaseUrl:true,headers:{authorization:'Bearer fork-only'},timeoutMs:60000,multiQuotes:true,...stargatePins(c)});
    const source=stargateRegistry.deployments.find(d=>d.chain==='eip155:42161'&&d.assetId===1),destination=stargateRegistry.deployments.find(d=>d.chain==='eip155:1'&&d.assetId===1);
    const balance=(c,token,owner)=>c.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[owner]});
    const cases=[];
    for(const scenario of ['retry-completes','griefed-fallback']) {
      const amount=20_000_000n,operationId=`fork-compose-${scenario}`;
      stage=`fund ${scenario}`;
      // Warm-up can outlast the quoter's 5-minute freshness bound: mine a current block on both forks.
      for(const f of [src,dst])await f.client.request({method:'evm_mine',params:[]});
      await fundedImpersonation(src.client,source.address,()=>localCall(src.client,source.address,source.token,encodeFunctionData({abi:tokenAbi,functionName:'transfer',args:[actor,amount]})));
      const router=new RouterSwap2Protocol(account,{fromChain:source.chain,providers:[remote(cfg)],operationStore:store,reviewExecution:async(plan)=>{
        check(plan.provider==='stargate'&&plan.routeId==='compose'&&plan.sourceAmount===amount&&same(plan.recipient,recipient)&&plan.minDestAmount>0n,'wrong reviewed terms');
        check(plan.source.kind==='call'&&same(plan.source.to,source.address)&&plan.source.value<10n**17n,'wrong reviewed source');
        check(plan.approvals.length===1&&plan.approvals.every(a=>same(a.spender,source.address)&&same(a.token,source.token)&&a.amount===amount),'nonexact approval');
      }});
      const preview=await router.using('stargate','compose').quoteSwap2({fromToken:source.token,toToken:DAI,toChain:'eip155:1',recipient,fromTokenAmount:amount,slippage:0.01});
      check(BigInt(preview.toTokenAmountMin)>0n,'no compose preview');
      const beforeDai=await balance(dst.client,DAI,recipient),beforeUsdc=await balance(dst.client,destination.token,recipient);
      stage=`execute ${scenario} through HTTP backend`;
      await router.using('stargate','compose').swap2({fromToken:source.token,toToken:DAI,toChain:'eip155:1',recipient,fromTokenAmount:amount,minAmountOut:BigInt(preview.toTokenAmountMin),slippage:0.01,operationId});
      const row=await store.load(operationId),sourceStep=row.steps.find(s=>s.kind==='source');check(sourceStep?.hash,'missing journal source hash');
      const receipt=await src.client.waitForTransactionReceipt({hash:sourceStep.hash});check(receipt.status==='success','source reverted');
      check(await src.client.readContract({address:source.token,abi:tokenAbi,functionName:'allowance',args:[actor,source.address]})===0n,'residual allowance');
      const q=quotes.at(-1),{compose}=checkedStargateComposeQuote(q,stargateRegistry),bridge=stargateComposedTaxiProof(compose.bridge,receipt,compose.bridge.sender,stargateComposeMessage(compose)),lifi=stargateComposeProof(compose,bridge);
      stage=`verify local relay ${scenario}`;
      const origin={srcEid:source.eid,sender:pad(source.tokenMessaging,{size:32}),nonce:bridge.nonce};
      const [receiveLib]=await dst.client.readContract({address:destination.endpoint,abi:relayAbi,functionName:'getReceiveLibrary',args:[destination.tokenMessaging,source.eid]});
      let inbound=await dst.client.readContract({address:destination.endpoint,abi:relayAbi,functionName:'inboundNonce',args:[destination.tokenMessaging,source.eid,origin.sender]});
      check(inbound<bridge.nonce&&bridge.nonce-inbound<100n,'fork channel cannot be aligned');
      await fundedImpersonation(dst.client,destination.tokenMessaging,async()=>{while(inbound+1n<bridge.nonce){inbound++;await localCall(dst.client,destination.tokenMessaging,destination.endpoint,encodeFunctionData({abi:relayAbi,functionName:'skip',args:[destination.tokenMessaging,source.eid,origin.sender,inbound]}));}});
      await fundedImpersonation(dst.client,receiveLib,()=>localCall(dst.client,receiveLib,destination.endpoint,encodeFunctionData({abi:relayAbi,functionName:'verify',args:[origin,destination.tokenMessaging,keccak256(encodePacked(['bytes32','bytes'],[bridge.guid,bridge.message]))]})));
      const delivery=await fundedImpersonation(dst.client,receiveLib,()=>localCall(dst.client,receiveLib,destination.endpoint,encodeFunctionData({abi:relayAbi,functionName:'lzReceive',args:[origin,destination.tokenMessaging,bridge.guid,bridge.message,'0x']})));
      check(delivery.status==='success','delivery reverted');hints.set(bridge.guid,{delivery:delivery.transactionHash,compose:[]});
      const queueArgs=[destination.address,LIFI_ETHEREUM_COMPOSER.receiver,bridge.guid,0];
      check(await dst.client.readContract({address:destination.endpoint,abi:COMPOSE_ABI,functionName:'composeQueue',args:queueArgs})===lifi.messageHash,'compose not queued with the reviewed message');
      // A backend may offer the retry early; a client on the default 600 s window must still refuse to sign it.
      const patient=new RouterSwap2Protocol(account,{fromChain:source.chain,providers:[remote(config(rpcUrls,server.url,600))],operationStore:store});
      const waiting=await patient.resumeSwap2(operationId);check(waiting.status.state==='pending','client reported a retry inside the executor window');
      const early=(await patient.getSwap2RecoveryQuotes(waiting.id)).find(o=>o.kind==='compose');
      if(early){let refused=false;try{await patient.recoverSwap2(waiting.id,early.id,destAccount,{operationId:`${operationId}-early`,maxNativeValue:0n,review:async()=>{throw new Error('fork: early retry reached review');}});}catch(e){refused=/recovery refused/.test(e.message);}check(refused,'client signed a retry inside the executor window');}
      const resumed=await router.resumeSwap2(operationId);check(resumed.status.state==='action-required','pending compose not recoverable');
      let compose2,recovery,offer;
      if(scenario==='retry-completes'){
        stage='discover and execute compose retry';
        offer=(await router.getSwap2RecoveryQuotes(resumed.id)).find(o=>o.kind==='compose');check(offer&&same(offer.tx.to,destination.endpoint)&&offer.tx.value==='0'&&BigInt(offer.tx.gasLimit)>=compose.gas,'missing bounded compose retry');
        let reviewed=false;
        recovery=await router.recoverSwap2(resumed.id,offer.id,destAccount,{operationId:`${operationId}-recovery`,maxNativeValue:0n,review:async(o)=>{check(o.kind==='compose','wrong recovery review');reviewed=true;}});
        check(reviewed,'recovery signed without review');
        compose2=await dst.client.waitForTransactionReceipt({hash:recovery.hash});
      } else {
        stage='griefing lzCompose with too little gas';
        // Anyone may call lzCompose: below recoverGas the receiver pays the bridged token instead of swapping.
        const data=encodeFunctionData({abi:COMPOSE_ABI,functionName:'lzCompose',args:[...queueArgs,lifi.message,'0x']});
        for(const gas of [150_000n,170_000n,190_000n,210_000n,240_000n]){
          await dst.client.request({method:'anvil_impersonateAccount',params:[recipient]});await dst.client.request({method:'anvil_setBalance',params:[recipient,toHex(10n**18n)]});
          const hash=await dst.client.request({method:'eth_sendTransaction',params:[{from:recipient,to:destination.endpoint,data,gas:toHex(gas)}]});
          await dst.client.request({method:'anvil_stopImpersonatingAccount',params:[recipient]});
          const r=await dst.client.waitForTransactionReceipt({hash});if(r.status==='success'){compose2=r;break;}
        }
        check(compose2,'griefing call never succeeded');
      }
      hints.set(bridge.guid,{delivery:delivery.transactionHash,compose:[compose2.transactionHash]});
      const final=await router.resumeSwap2(operationId);
      const daiDelta=await balance(dst.client,DAI,recipient)-beforeDai,usdcDelta=await balance(dst.client,destination.token,recipient)-beforeUsdc;
      if(scenario==='retry-completes')check(final.status.state==='completed'&&daiDelta>=compose.minReturn&&usdcDelta===0n,'compose retry did not deliver the reviewed output');
      else check(final.status.state==='partial'&&daiDelta===0n&&usdcDelta===bridge.amount&&compose2.logs.some(l=>same(l.address,LIFI_ETHEREUM_COMPOSER.receiver)),'fallback not reported as partial bridged-token payout');
      check(await dst.client.readContract({address:destination.endpoint,abi:COMPOSE_ABI,functionName:'composeQueue',args:queueArgs})===`0x${'0'.repeat(63)}1`,'compose not consumed');
      check((await router.getSwap2RecoveryQuotes(final.id)).length===0,'consumed compose offered again');
      cases.push({scenario,amount,source:source.chain,destination:destination.chain,finalToken:DAI,sourceHash:sourceStep.hash,guid:bridge.guid,bridgedAmount:bridge.amount,minReturn:compose.minReturn,composeGas:compose.gas,dex:compose.dex,deliveryHash:delivery.transactionHash,composeHash:compose2.transactionHash,composeGasUsed:compose2.gasUsed,recoveryOffer:offer?{kind:offer.kind,gasLimit:offer.tx.gasLimit}:null,state:final.status.state,daiDelta,usdcDelta,journal:row.steps});
      console.log(`Fork verified compose: ${scenario} → ${final.status.state}`);
    }
    const report={schemaVersion:1,kind:'local-mainnet-fork-compose',capturedAt:new Date().toISOString(),publicTransactionsSent:0,limitations:['Local simulated funding, DVN verification and executor lzCompose; not a funded public transfer','The griefing case drives the receiver fallback with a deliberately underfunded lzCompose'],forks:resources.map(r=>r.head),cases};
    const file=new URL('../tests/fixtures/fork-compose.json',import.meta.url),tmp=new URL('../tests/fixtures/fork-compose.json.tmp',import.meta.url);await writeFile(tmp,stringify(report));await rename(tmp,file);
  }finally{store?.close();for(const m of managers)m.dispose();if(server)await closeServer(server.server);for(const r of resources.reverse())await r.stop();await rm(dir,{recursive:true,force:true});}
}
try{await main();}catch(e){console.error(`Stargate compose fork failed at ${stage}: ${e.message?.startsWith('fork:')?e.message:(e.shortMessage??e.message??e.name)}. No public transactions sent.`);process.exitCode=1;}
