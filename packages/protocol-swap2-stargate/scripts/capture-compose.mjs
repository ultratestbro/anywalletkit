// Historical mainnet evidence only. No signatures, sends or API key.
import {writeFile, rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {decodeAbiParameters, encodeFunctionData, decodeFunctionResult, keccak256, parseEventLogs, slice} from 'viem';
import {builtinNetwork} from '@anywalletkit/networks';
import {stargateRegistry} from '../dist/deployments.js';
import {STARGATE_ABI} from '../dist/abi.js';
import {destinationAmount} from '../dist/amounts.js';
import {checkStargateReceipt} from '../dist/tracking.js';
import {COMPOSE_ABI, LIFI_COMPOSE_ABI, LIFI_COMPOSE_PAYLOAD, LIFI_ETHEREUM_COMPOSER, proveLifiStargateCompose, lifiStargateComposeOutcome, stargateComposeQueueState} from '../dist/compose.js';
import {COMPOSE_DEX_PINS, COMPOSE_POOL_ABI, validateLifiUnoswap2Compose} from '../dist/compose-dex.js';
import {context, stringify, EvidenceError} from './evidence.mjs';
const assert = (ok, reason) => {if (!ok) throw new EvidenceError(reason);};
const same = (a,b) => a.toLowerCase() === b.toLowerCase();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const upstreamCommit = '0094415e2da5efa775380fefa9c9540ca65d755b';
const pins = LIFI_ETHEREUM_COMPOSER, contexts = new Map();
let stage = 'initialization';
async function text(url) {const r = await fetch(url, {signal: AbortSignal.timeout(20000)}); assert(r.ok, 'HTTP-unavailable'); return r.text();}
async function chain(d) {
  if (!contexts.has(d.chain)) contexts.set(d.chain, await context(d.chain, d.chainId, process.env[`RPC_${d.chainId}`] ? [process.env[`RPC_${d.chainId}`]] : builtinNetwork(d.chain).rpcs.slice(0,2)));
  return contexts.get(d.chain);
}
async function evidence(d, hash) {
  stage = `receipt:${d.chain}`;
  const ctx = await chain(d), c = ctx.client;
  const [receipt, tx] = await Promise.all([c.getTransactionReceipt({hash}), c.getTransaction({hash})]);
  const b = await c.getBlock({blockNumber: receipt.blockNumber});
  assert(receipt.status === 'success' && receipt.blockNumber <= ctx.block.number && b.hash && same(tx.blockHash,b.hash) && tx.blockNumber === receipt.blockNumber, 'receipt-not-canonical');
  checkStargateReceipt(receipt, hash, b.hash);
  return {chain:d.chain, chainId:d.chainId, block:{number:b.number,hash:b.hash,timestamp:b.timestamp}, transaction:{hash,from:tx.from,to:tx.to,input:tx.input,value:tx.value}, receipt};
}
async function capture() {
  const cases = [], provenance = {upstreamCommit, contracts:[], sources:[]};
  for (const path of ['deployments/mainnet.json','src/Periphery/ReceiverStargateV2.sol','src/Periphery/Executor.sol','src/Libraries/LibSwap.sol','src/Interfaces/ILiFi.sol']) {
    const url = `https://raw.githubusercontent.com/lifinance/contracts/${upstreamCommit}/${path}`, raw = await text(url);
    if (path.endsWith('mainnet.json')) {const d=JSON.parse(raw); assert(same(d.ReceiverStargateV2,pins.receiver)&&same(d.Executor,pins.executor),'deployment-mismatch');}
    provenance.sources.push({url,sha256:sha256(raw)});
  }
  for (const [address, expectedCodeHash] of [[pins.receiver,pins.receiverCodeHash],[pins.executor,pins.executorCodeHash],[COMPOSE_DEX_PINS.router,COMPOSE_DEX_PINS.routerCodeHash],[COMPOSE_DEX_PINS.factory,COMPOSE_DEX_PINS.factoryCodeHash]]) {
    const url=`https://eth.blockscout.com/api/v2/smart-contracts/${address}`,raw=await text(url),v=JSON.parse(raw);
    assert(!v.proxy_type&&!v.is_changed_bytecode && (address===COMPOSE_DEX_PINS.factory ? v.is_verified : v.is_fully_verified&&!v.is_partially_verified),'unverified-or-proxy-composer');
    const codeHash=keccak256(v.deployed_bytecode);
    assert(codeHash===expectedCodeHash,'verified-code-pin-mismatch');
    provenance.contracts.push({address,url,responseSha256:sha256(raw),name:v.name,compiler:v.compiler_version,sourceSha256:sha256(v.source_code),codeHash,constructorArgs:v.constructor_args,fullyVerified:v.is_fully_verified,partiallyVerified:v.is_partially_verified,proxy:false});
  }
  for (const sample of [
    {guid:'0x617b0840da41638651bf677a1459da1cc997ef035d16af994f59718ee2205798',outcome:'completed'},
    {guid:'0xa58a234dff2fc196c9cefb41371b16426d06ea0255363fd7868807137e9099c9',outcome:'intermediate-refunded'},
  ]) {
    stage='scan-discovery';
    const url=`https://scan.layerzero-api.com/v1/messages/guid/${sample.guid}`,m=JSON.parse(await text(url)).data.find(m=>same(m.guid,sample.guid)); assert(m,'scan-message-missing');
    const assetId=parseInt(slice(m.source.tx.payload,1,3).slice(2),16);
    const src=stargateRegistry.deployments.find(d=>d.eid===m.pathway.srcEid&&d.assetId===assetId),dst=stargateRegistry.deployments.find(d=>d.eid===m.pathway.dstEid&&d.assetId===assetId);
    assert(src&&dst&&dst.chain===pins.chain&&stargateRegistry.route(src.chain,src.token,dst.chain,dst.token),'unreviewed-route');
    const source=await evidence(src,m.source.tx.txHash),delivery=await evidence(dst,m.destination.tx.txHash),execution=await evidence(dst,m.destination.lzCompose.txs[0].txHash);
    const sent=parseEventLogs({abi:STARGATE_ABI,eventName:'OFTSent',logs:source.receipt.logs.filter(l=>same(l.address,src.address)),strict:true}).find(l=>same(l.args.guid,sample.guid));assert(sent,'source-transfer-missing');
    const composeMsg=slice(m.source.tx.payload,75),composeFrom=slice(m.source.tx.payload,55,75),[,swaps,recipient]=decodeAbiParameters(LIFI_COMPOSE_PAYLOAD,composeMsg);
    assert(sample.outcome!=='completed'||slice(swaps[0].callData,0,4)==='0x8770ba91','unexpected-success-dex-selector');
    const minimum=sample.outcome==='completed'?BigInt(slice(swaps[0].callData,68,100)):1n;
    const expected={bridge:{source:src,destination:dst,mode:'taxi',sender:sent.args.fromAddress,recipient:pins.receiver,amount:sent.args.amountSentLD,minimum:destinationAmount(sent.args.amountReceivedLD,src.localDecimals,dst.localDecimals,src.sharedDecimals),nativeDrop:0n},composeFrom,composeMsg,recipient,finalToken:swaps.at(-1).receivingAssetId,minimum};
    const c=(await chain(dst)).client,calls=[],code={receiver:await c.getCode({address:pins.receiver,blockNumber:execution.block.number}),executor:await c.getCode({address:pins.executor,blockNumber:execution.block.number})};
    const proof=proveLifiStargateCompose(expected,source.receipt,delivery.receipt,code),outcome=lifiStargateComposeOutcome(proof,execution.receipt); assert(outcome.state===sample.outcome,'runtime-outcome-mismatch');
    async function read(address,abi,functionName,args,blockNumber) {
      stage=`state:${functionName}`;const data=encodeFunctionData({abi,functionName,args}),r=await c.call({to:address,data,blockNumber});assert(r.data,'missing-state');
      const decoded=decodeFunctionResult({abi,functionName,data:r.data});calls.push({to:address,functionName,data,result:r.data,decoded,blockNumber});return decoded;
    }
    const queueArgs=[dst.address,pins.receiver,proof.bridge.guid,0];
    assert(stargateComposeQueueState(proof.messageHash,await read(dst.endpoint,COMPOSE_ABI,'composeQueue',queueArgs,delivery.block.number))==='pending','compose-not-pending');
    assert(stargateComposeQueueState(proof.messageHash,await read(dst.endpoint,COMPOSE_ABI,'composeQueue',queueArgs,execution.block.number))==='consumed','compose-not-consumed');
    for(const [fn,value] of [['executor',pins.executor],['endpointV2',dst.endpoint],['tokenMessaging',dst.tokenMessaging]]) assert(same(await read(pins.receiver,LIFI_COMPOSE_ABI,fn,[],execution.block.number),value),'receiver-identity-mismatch');
    await read(pins.receiver,LIFI_COMPOSE_ABI,'recoverGas',[],execution.block.number);
    let dexEvidence;
    if (sample.outcome === 'completed') {
      stage = 'nested-dex-validation';
      const validated = await validateLifiUnoswap2Compose(proof, c, execution.block.number);
      const dexCode = {router: await c.getCode({address:COMPOSE_DEX_PINS.router,blockNumber:execution.block.number}),factory:await c.getCode({address:COMPOSE_DEX_PINS.factory,blockNumber:execution.block.number})};
      for (const pool of validated.pools) {
        const token0 = await read(pool,COMPOSE_POOL_ABI,'token0',[],execution.block.number);
        const token1 = await read(pool,COMPOSE_POOL_ABI,'token1',[],execution.block.number);
        const fee = await read(pool,COMPOSE_POOL_ABI,'fee',[],execution.block.number);
        assert(same(await read(COMPOSE_DEX_PINS.factory,COMPOSE_POOL_ABI,'getPool',[token0,token1,fee],execution.block.number),pool),'pool-factory-mismatch');
      }
      dexEvidence = {code:dexCode,validated};
    }
    for(const side of [source,delivery,execution])assert(same((await(await chain(side.chain===src.chain?src:dst)).client.getBlock({blockNumber:side.block.number})).hash,side.block.hash),'block-changed');
    cases.push({guid:sample.guid,discovery:{url,scanComposeStatus:m.destination.lzCompose.status},expected,minimumEvidence:sample.outcome==='completed'?'1inch unoswap2 minReturn argument (not an execution validator)':'synthetic caller threshold 1; fallback classification does not depend on final minimum',source,delivery,execution,code,calls,outcome,...(dexEvidence?{dexEvidence}:{})});
    console.log(`Verified historical compose: ${outcome.state}`);
  }
  const file=new URL('../tests/fixtures/compose.json',import.meta.url),tmp=new URL('../tests/fixtures/compose.json.tmp',import.meta.url);
  await writeFile(tmp,stringify({schemaVersion:1,kind:'historical-mainnet-compose-evidence',capturedAt:new Date().toISOString(),provenance,cases}));await rename(tmp,file);
}
try {await capture();}catch(e){console.error(`Compose capture failed at ${stage}: ${e instanceof EvidenceError?e.code:'RPC/API/validation error'}. Previous fixture preserved.`);process.exitCode=1;}
