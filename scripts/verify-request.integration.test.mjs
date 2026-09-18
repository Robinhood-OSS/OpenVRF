import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {ContractFactory, JsonRpcProvider} from 'ethers';
import {verifyRequest} from './verify-request.mjs';

test('read-only checker verifies local request, proof receipt and callback', {timeout: 30_000}, async () => {
  const fixture = JSON.parse(await readFile(new URL('../examples/evmnet-round-1000.json', import.meta.url), 'utf8'));
  const roundTime = 1727521075 + 999 * 3;
  // Loopback only; never use this disposable Anvil signer on a public chain.
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', '18549', '--timestamp', String(roundTime - 100), '--silent'], {stdio: 'ignore'});
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
    await provider.send('evm_setNextBlockTimestamp', [roundTime - 1]);
    const requestReceipt = await (await consumer.request()).wait();
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
    provider.destroy();
    anvil.kill('SIGTERM');
  }
});
