// LOCAL ONLY. Actual OpenVRF requests/callbacks with the public, BLS-verified round-1000 proof.
// One beacon round intentionally isolates request/consumer domain separation, not beacon entropy.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
import {ContractFactory, JsonRpcProvider, Wallet, NonceManager} from 'ethers';
import {verifySignature, deriveWord} from './verify-request.mjs';

const count = Number(process.argv[3] ?? 1000);
assert(Number.isSafeInteger(count) && count > 0 && count <= 10000, 'Sample count must be between 1 and 10000');
const fixture = JSON.parse(await readFile('examples/evmnet-round-1000.json', 'utf8'));
const randomness = await verifySignature(fixture.signature, fixture.round);
const port = await new Promise(resolve => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {const p = s.address().port; s.close(() => resolve(p));});
});
const roundTime = 1727521075 + (fixture.round - 1) * 3;
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--timestamp',
  String(roundTime - 100), '--silent'], {stdio: 'ignore'});
const p = new JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, {staticNetwork: true, cacheTimeout: -1, batchStallTime: 0});
// Poll receipts directly with a deadline; event-based tx.wait() stalled during
// the first 10k request-only run despite the receipt already being mined.
async function mined(tx) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const receipt = await p.getTransactionReceipt(tx.hash);
    if (receipt) { assert.equal(receipt.status, 1, `Transaction reverted: ${tx.hash}`); return receipt; }
    await sleep(20);
  }
  throw new Error(`Receipt timeout: ${tx.hash}`);
}
try {
  for (let i = 0; ; i++) {
    try {await p.getBlockNumber(); break;} catch {if (i > 50) throw new Error('Anvil startup failed'); await sleep(100);}
  }
  // Anvil's publicly known disposable account; never written into output.
  await p.send('anvil_setBlockTimestampInterval', [0]);
  const signer = new NonceManager(Wallet.fromPhrase('test test test test test test test test test test test junk').connect(p));
  const artifact = async name => JSON.parse(await readFile(`out/${name}.sol/${name}.json`, 'utf8'));
  const ra = await artifact('OpenVRF');
  const router = await new ContractFactory(ra.abi, ra.bytecode.object, signer).deploy(await signer.getAddress(), await signer.getAddress(), 0);
  await mined(router.deploymentTransaction());
  const ca = await artifact('ExampleConsumer');
  const consumers = [];
  for (let i = 0; i < 2; i++) {
    const c = await new ContractFactory(ca.abi, ca.bytecode.object, signer).deploy(await router.getAddress());
    await mined(c.deploymentTransaction());
    await mined(await router.setConsumerAuthorization(await c.getAddress(), true));
    consumers.push(c);
  }
  const samples = [];
  for (let i = 0; i < count; i++) {
    await p.send('evm_setNextBlockTimestamp', [roundTime - 1]);
    const tx = await consumers[i % 2].request();
    const receipt = await mined(tx);
    const event = receipt.logs.map(l => {try {return router.interface.parseLog(l);} catch {return null;}})
      .find(e => e?.name === 'RandomnessRequested');
    assert.equal(event.args.requestId, BigInt(i + 1));
    assert.equal(event.args.round, BigInt(fixture.round));
    samples.push({requestId: String(event.args.requestId), consumer: event.args.consumer,
      requestNonce: tx.nonce, requestBlock: receipt.blockNumber, requestTransaction: tx.hash});
    if ((i + 1) % 100 === 0) console.log(`Requests mined: ${i + 1}/${count}`);
  }
  // All requests, across two consumers, are pending before any fulfillment.
  for (const s of samples) {
    const q = await router.requests(s.requestId);
    assert.equal(q.fulfilled, false); assert.equal(q.delivered, false);
  }
  const pendingBeforeCallbacks = samples.length;
  await p.send('evm_setNextBlockTimestamp', [roundTime]);
  // Reverse order proves mapping is request-specific, not FIFO.
  for (let i = count - 1; i >= 0; i--) {
    const s = samples[i];
    const tx = await router.fulfill(s.requestId, fixture.signature);
    const receipt = await mined(tx);
    const q = await router.requests(s.requestId);
    assert.equal(q.fulfilled, true); assert.equal(q.delivered, true);
    const c = consumers[i % 2];
    assert.equal(await c.received(s.requestId), true);
    assert.equal(await consumers[(i + 1) % 2].received(s.requestId), false);
    assert.equal(await c.results(s.requestId), q.randomWord);
    assert.equal(q.randomWord, BigInt(deriveWord({randomness, chainId: 31337n, router: await router.getAddress(), requestId: BigInt(s.requestId), consumer: s.consumer})));
    Object.assign(s, {randomWord: String(q.randomWord), roll: String(q.randomWord % 1000000n + 1n),
      callbackNonce: tx.nonce, callbackBlock: receipt.blockNumber, callbackTransaction: tx.hash});
    if (i % 100 === 0) console.log(`Callbacks remaining: ${i}`);
  }
  assert.equal(new Set(samples.map(s => s.randomWord)).size, count);
  assert.equal(new Set(samples.flatMap(s => [s.requestNonce, s.callbackNonce])).size, count * 2);
  const stats = values => {
    const bins = Array(10).fill(0);
    values.forEach(x => bins[Math.min(9, Math.floor(x * 10))]++);
    const mean = values.reduce((a, b) => a + b, 0) / count;
    const chiSquare = bins.reduce((sum, n) => sum + (n - count / 10) ** 2 / (count / 10), 0);
    const variance = values.reduce((sum, x) => sum + (x - mean) ** 2, 0);
    const serialCorrelation = values.slice(1).reduce((sum, x, i) => sum + (x - mean) * (values[i] - mean), 0) / variance;
    return {bins, mean, chiSquare, degreesOfFreedom: 9, serialCorrelation};
  };
  const raw = stats(samples.map(s => Number(BigInt(s.randomWord) >> 203n) / 2 ** 53));
  const rolls = stats(samples.map(s => (Number(s.roll) - 1) / 1000000));
  // Predeclared 5% chi-square threshold; diagnostic, not a security gate or proof.
  const diagnosticPass = raw.chiSquare < 16.919 && rolls.chiSquare < 16.919;
  const result = {kind: 'LOCAL_ACTUAL_CONTRACT', chainId: 31337, count, consumers: await Promise.all(consumers.map(c => c.getAddress())),
    router: await router.getAddress(), fixture, pendingBeforeCallbacks, nonceCount: count * 2,
    raw256Normalized: raw, moduloMillionRoll: rolls, diagnosticPass,
    limitations: 'Fixed public beacon round; tests request/consumer derivation, callback isolation and uniformity diagnostics. Not proof of unpredictability, fairness or independence; not live-chain samples.', samples};
  const output = process.argv[2] ?? '/tmp/openvrf-distribution-1000.json';
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({output, count, pendingBeforeCallbacks, raw, rolls, diagnosticPass}));
} finally {
  p.destroy(); anvil.kill('SIGTERM');
}
