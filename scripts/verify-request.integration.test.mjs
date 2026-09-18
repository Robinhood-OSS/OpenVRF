import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {ContractFactory, JsonRpcProvider, WebSocketProvider} from 'ethers';
import {subscribeRequests} from '../relayer/relay.mjs';
import {verifyRequest} from './verify-request.mjs';

test('read-only checker verifies local request, proof receipt and callback', {timeout: 30_000}, async () => {
  const fixture = JSON.parse(await readFile(new URL('../examples/evmnet-round-1000.json', import.meta.url), 'utf8'));
  const roundTime = 1727521075 + 999 * 3;
  // Loopback only; never use this disposable Anvil signer on a public chain.
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', '18549', '--timestamp', String(roundTime - 100), '--silent'], {stdio: 'ignore'});
  let wsProvider, wsRouter;
  let spawnError;
  anvil.on('error', error => { spawnError = error; });
  const provider = new JsonRpcProvider('http://127.0.0.1:18549', 31337, {staticNetwork: true, cacheTimeout: -1});
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if (spawnError) throw spawnError;
      if (anvil.exitCode !== null) throw new Error('Anvil failed; port 18549 must be free');
      try { await provider.getBlockNumber(); ready = true; break; } catch {}
    }
    assert.ok(ready, 'Anvil did not start');
    const signer = await provider.getSigner();
    const deploy = async (name, args = []) => {
      const artifact = JSON.parse(await readFile(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
      const contract = await new ContractFactory(artifact.abi, artifact.bytecode.object, signer).deploy(...args);
      await contract.waitForDeployment();
      return contract;
    };
    const signerAddress = await signer.getAddress();
    const router = await deploy('OpenVRF', [signerAddress, signerAddress, 0]);
    const address = await router.getAddress();
    const consumer = await deploy('ExampleConsumer', [address]);
    await (await router.setConsumerAuthorization(await consumer.getAddress(), true)).wait();
    wsProvider = new WebSocketProvider('ws://127.0.0.1:18549', 31337, {staticNetwork: true});
    wsRouter = router.connect(wsProvider);
    let resolveEvent;
    const observed = new Promise(resolve => {resolveEvent = resolve;});
    const seen = [];
    let resolveWideEvent;
    const observedWide = new Promise(resolve => {resolveWideEvent = resolve;});
    await subscribeRequests(wsRouter, undefined, requestId => resolveWideEvent(requestId));
    await subscribeRequests(wsRouter, await consumer.getAddress(), requestId => {
      seen.push(requestId);
      resolveEvent(requestId);
    });
    // Give the actual socket subscription time to establish before mining the request.
    await sleep(200);
    await provider.send('evm_setNextBlockTimestamp', [roundTime - 2]);
    const requestReceipt = await (await consumer.request()).wait();
    const receivedId = await Promise.race([observed, sleep(3000).then(() => {throw Error('WebSocket listener did not queue request');})]);
    const wideId = await Promise.race([observedWide, sleep(3000).then(() => {throw Error('Router-wide listener did not queue request');})]);
    assert.equal(receivedId, 1n);
    assert.equal(wideId, 1n);
    assert.deepEqual(seen, [1n]);
    await assert.rejects(() => verifyRequest(provider, address, 1), /pending/);
    await assert.rejects(() => verifyRequest(provider, address, 2), /does not exist/);
    await provider.send('evm_setNextBlockTimestamp', [roundTime]);
    await (await router.fulfill(1, fixture.signature)).wait();
    const report = await verifyRequest(provider, address, 1, requestReceipt.blockNumber);
    assert.equal(report.beaconSignature, 'VALID');
    assert.equal(report.onChainFulfillment, 'MATCH');
    assert.equal(report.callbackDelivery, 'ROUTER REPORTS DELIVERED');
    assert.equal(report.randomWord, (await consumer.results(1)).toString());
    assert.equal(report.requestTimingAssumption, 'REQUIRES FRESH CHAIN TIMESTAMP');
    await assert.rejects(() => verifyRequest(provider, address, 1, requestReceipt.blockNumber + 1), /exactly one/);
  } finally {
    if (wsRouter) await wsRouter.removeAllListeners();
    if (wsProvider) await wsProvider.destroy();
    provider.destroy();
    anvil.kill('SIGTERM');
  }
});
