// READ ONLY: 1000 distinct public drand rounds, locally BLS verified; no signer or RPC writes.
import {writeFile} from 'node:fs/promises';
import {verifySignature, deriveWord, CHAIN_HASH} from './verify-request.mjs';
const count = 1000, startRound = Number(process.env.START_ROUND ?? '1000'), samples = Array(count);
if (!Number.isSafeInteger(startRound) || startRound < 1 || startRound + count > Number.MAX_SAFE_INTEGER)
  throw new Error('START_ROUND must be a positive safe integer');
const consumers = ['0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003'];
let next = 0;
await Promise.all(Array.from({length: 4}, async () => {
  while (next < count) {
    const i = next++, round = startRound + i;
    let body;
    for (const host of ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh']) {
      try {
        const response = await fetch(`${host}/${CHAIN_HASH.slice(2)}/public/${round}`, {signal: AbortSignal.timeout(15000)});
        if (!response.ok) continue;
        const candidate = await response.json();
        if (candidate.round !== round) continue;
        const signature = `0x${candidate.signature}`;
        const randomness = await verifySignature(signature, round);
        const consumer = consumers[i % 2];
        const word = BigInt(deriveWord({randomness, chainId: 31337n,
          router: '0x0000000000000000000000000000000000000001', requestId: BigInt(i + 1), consumer}));
        body = {round, signature, randomness, requestId: String(i + 1), consumer,
          randomWord: String(word), roll: String(word % 1000000n + 1n)};
        break;
      } catch { /* Only accept a fully verified signature, otherwise try another provider. */ }
    }
    if (!body) throw new Error(`Unable to retrieve/verify public round ${round}`);
    samples[i] = body;
    if ((i + 1) % 100 === 0) console.log(`Verified historical rounds: ${i + 1}`);
  }
}));
const stats = values => {
  const bins = Array(10).fill(0);
  values.forEach(x => bins[Math.min(9, Math.floor(x * 10))]++);
  const mean = values.reduce((a, b) => a + b, 0) / count;
  const chiSquare = bins.reduce((sum, n) => sum + (n - count / 10) ** 2 / (count / 10), 0);
  const variance = values.reduce((sum, x) => sum + (x - mean) ** 2, 0);
  const serialCorrelation = values.slice(1).reduce((sum, x, i) => sum + (x - mean) * (values[i] - mean), 0) / variance;
  return {bins, mean, chiSquare, degreesOfFreedom: 9, criticalAt5Percent: 16.919,
    rejectsUniformityAt5Percent: chiSquare > 16.919, serialCorrelation};
};
const raw = stats(samples.map(s => Number(BigInt(s.randomWord) >> 203n) / 2 ** 53));
const rolls = stats(samples.map(s => (Number(s.roll) - 1) / 1000000));
const beacon = stats(samples.map(s => Number(BigInt(s.randomness) >> 203n) / 2 ** 53));
const output = process.argv[2] ?? '/tmp/openvrf-historical-1000.json';
await writeFile(output, JSON.stringify({kind: 'READ_ONLY_HISTORICAL_BLS_VERIFIED', count, startRound,
  chainId: 31337, router: '0x0000000000000000000000000000000000000001',
  raw256Normalized: raw, moduloMillionRoll: rolls, beaconExploratory: beacon,
  limitations: '1000 distinct historical beacon proofs with synthetic ABI context, NOT live contract callbacks. Finite statistical diagnostics are not cryptographic proof.', samples}, null, 2));
console.log(JSON.stringify({output, count, raw, rolls, beacon}));
