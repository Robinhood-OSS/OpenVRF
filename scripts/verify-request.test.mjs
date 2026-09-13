import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {verifyEvidence, verifySignature} from './verify-request.mjs';

const fixture = JSON.parse(await readFile(new URL('../examples/evmnet-round-1000.json', import.meta.url), 'utf8'));

test('independent JS verifier accepts public round and matches cast-derived word', async () => {
  const result = await verifyEvidence(fixture);
  assert.equal(result.beaconSignature, 'VALID');
  assert.equal(result.derivedRandomWord, 'MATCH');
  assert.equal(result.requestTimingAssumption, 'REQUIRES FRESH CHAIN TIMESTAMP');
  assert.equal(result.consumerFairness, 'OUT OF SCOPE');
});

test('altered, truncated, zero and wrong-round signatures fail', async () => {
  for (const signature of ['0x00' + fixture.signature.slice(4), '0x1234', '0x' + '00'.repeat(64)]) {
    await assert.rejects(() => verifySignature(signature, 1000));
  }
  await assert.rejects(() => verifySignature(fixture.signature, 1001));
});

test('tampering with any derivation input or recorded output fails', async () => {
  for (const change of [{chainId: '1'}, {requestId: '2'}, {randomWord: '0'},
    {router: fixture.consumer}, {consumer: fixture.router}]) {
    await assert.rejects(() => verifyEvidence({...fixture, ...change}), /MISMATCH/);
  }
});
