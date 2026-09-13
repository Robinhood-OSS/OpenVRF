// Read-only evidence checker. No signer, private key, or transaction submission.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {fetchBeacon} from 'drand-client';
import {AbiCoder, Contract, FetchRequest, JsonRpcProvider, ZeroAddress, getAddress, keccak256, sha256} from 'ethers';

export const CHAIN_HASH = '0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';
// Pinned public evmnet metadata, not obtained from the RPC being checked.
export const PUBLIC_KEY = '07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b3820557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b';
const ABI = [
  'function CHAIN_HASH() view returns (bytes32)',
  'function requests(uint256) view returns (address consumer,uint64 round,uint32 callbackGasLimit,bool fulfilled,bool delivered,uint256 randomWord,uint256 fee)',
  'function roundRandomness(uint64) view returns (bytes32)',
  'event RandomnessRequested(uint256 indexed requestId,address indexed consumer,uint64 round)',
  'event RandomnessFulfilled(uint256 indexed requestId,uint256 randomWord)',
  'event RoundProven(uint64 indexed roundNumber,bytes signature)',
];

export async function verifySignature(signature, round) {
  if (!/^0x[0-9a-fA-F]{128}$/.test(signature) || BigInt(round) < 1n || BigInt(round) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid signature encoding or unsupported round');
  }
  const randomness = sha256(signature);
  // A transport-free drand client: verifies locally using its JS BN254 implementation.
  await fetchBeacon({
    options: {disableBeaconVerification: false},
    chain: () => ({info: async () => ({public_key: PUBLIC_KEY, schemeID: 'bls-bn254-unchained-on-g1'})}),
    get: async () => ({round: Number(round), signature: signature.slice(2), randomness: randomness.slice(2)}),
  }, Number(round));
  return randomness;
}

export function deriveWord({randomness, chainId, router, requestId, consumer}) {
  return BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32', 'uint256', 'address', 'uint256', 'address'],
    [CHAIN_HASH, randomness, chainId, router, requestId, consumer],
  )));
}

export async function verifyEvidence(evidence) {
  const randomness = await verifySignature(evidence.signature, evidence.round);
  const word = deriveWord({...evidence, randomness});
  if (word !== BigInt(evidence.randomWord)) throw new Error('Derived random word MISMATCH');
  return {beaconSignature: 'VALID', derivedRandomWord: 'MATCH', randomWord: word.toString(),
    requestTimingAssumption: 'REQUIRES FRESH CHAIN TIMESTAMP', consumerFairness: 'OUT OF SCOPE'};
}

export async function verifyRequest(provider, address, requestId, fromBlock = 0) {
  const routerAddress = getAddress(address);
  const id = BigInt(requestId);
  if (id < 1n || !Number.isSafeInteger(fromBlock) || fromBlock < 0) throw new Error('Invalid request ID or start block');
  const router = new Contract(routerAddress, ABI, provider);
  const snapshot = await provider.getBlock('latest');
  if (!snapshot || fromBlock > snapshot.number) throw new Error('Invalid snapshot/start block');
  const blockTag = snapshot.number;
  const request = await router.requests(id, {blockTag});
  if (request.consumer === ZeroAddress) throw new Error('Request does not exist');
  if (!request.fulfilled) throw new Error('Request is pending; no fulfillment to verify');
  if (await router.CHAIN_HASH({blockTag}) !== CHAIN_HASH) throw new Error('Wrong beacon chain');
  const events = async filter => {
    const found = [];
    for (let start = fromBlock; start <= blockTag; start += 2000) {
      found.push(...await router.queryFilter(filter, start, Math.min(start + 1999, blockTag)));
    }
    return found;
  };
  const requested = await events(router.filters.RandomnessRequested(id));
  const fulfilled = await events(router.filters.RandomnessFulfilled(id));
  if (requested.length !== 1 || fulfilled.length !== 1) throw new Error('Expected exactly one request and fulfillment event; check scan range');
  const start = requested[0];
  const end = fulfilled[0];
  if (start.args.consumer !== request.consumer || start.args.round !== request.round ||
      end.args.randomWord !== request.randomWord || start.blockNumber > end.blockNumber ||
      (start.blockNumber === end.blockNumber && start.index >= end.index)) throw new Error('Request/event MISMATCH');
  const receipt = await provider.getTransactionReceipt(end.transactionHash);
  if (!receipt || receipt.status !== 1 || receipt.blockHash !== end.blockHash) throw new Error('Missing or inconsistent receipt');
  const proofs = receipt.logs.filter(log => log.address.toLowerCase() === routerAddress.toLowerCase())
    .map(log => { try { return {log, parsed: router.interface.parseLog(log)}; } catch { return null; } })
    .filter(item => item?.parsed?.name === 'RoundProven' && item.parsed.args.roundNumber === request.round && item.log.index < end.index);
  if (!proofs.length) throw new Error('No matching round proof in fulfillment receipt');
  const signature = proofs.at(-1).parsed.args.signature;
  const chainId = (await provider.getNetwork()).chainId;
  const result = await verifyEvidence({signature, round: request.round, chainId, router: routerAddress,
    requestId: id, consumer: request.consumer, randomWord: request.randomWord});
  if (await router.roundRandomness(request.round, {blockTag}) !== sha256(signature)) throw new Error('Stored beacon randomness MISMATCH');
  if ((await provider.getBlock(blockTag))?.hash !== snapshot.hash) throw new Error('Snapshot changed; rerun after reorganization');
  return {...result, onChainFulfillment: 'MATCH', callbackDelivery: request.delivered ? 'ROUTER REPORTS DELIVERED' : 'NOT DELIVERED',
    chainId: chainId.toString(), router: routerAddress, requestId: id.toString(), round: request.round.toString(),
    snapshotBlock: blockTag, snapshotHash: snapshot.hash, requestTransaction: start.transactionHash,
    fulfillmentTransaction: end.transactionHash, rpcEvidence: 'TRUSTED RPC; NOT A CONSENSUS PROOF'};
}

async function main() {
  const {values} = parseArgs({options: {fixture: {type: 'string'}, rpc: {type: 'string'}, router: {type: 'string'},
    'request-id': {type: 'string'}, 'from-block': {type: 'string'}, help: {type: 'boolean'}}});
  if (values.help) {
    console.log('node scripts/verify-request.mjs --fixture examples/evmnet-round-1000.json\nnode scripts/verify-request.mjs --rpc URL --router ADDRESS --request-id ID [--from-block DEPLOYMENT_BLOCK]');
    return;
  }
  if (values.fixture) {
    if (values.rpc || values.router || values['request-id'] || values['from-block']) throw new Error('Choose fixture OR RPC mode');
    const result = await verifyEvidence(JSON.parse(await readFile(values.fixture, 'utf8')));
    console.log(JSON.stringify({...result, onChainFulfillment: 'NOT CHECKED (OFFLINE SYNTHETIC EXAMPLE)'}, null, 2));
    return;
  }
  if (!values.rpc || !values.router || !values['request-id']) throw new Error('Required: --rpc, --router, --request-id (or use --help)');
  const connection = new FetchRequest(values.rpc);
  connection.timeout = 15_000;
  const provider = new JsonRpcProvider(connection);
  try { console.log(JSON.stringify(await verifyRequest(provider, values.router, values['request-id'], Number(values['from-block'] ?? 0)), null, 2)); }
  finally { provider.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // RPC errors may contain credential-bearing URLs; do not echo them.
    console.error('Verification failed or evidence unavailable. Check inputs, proof, RPC and scan range; no fairness claim was established.');
    process.exitCode = 1;
  });
}
