import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openRelayState} from './state.mjs';
import {boundedSender, reconcilePending} from './sender.mjs';

const hash = `0x${'ab'.repeat(32)}`;
const pending = {hash, signedTransaction: '0x1234', nonce: 0n};
const limits = {maxAttempts: 3, backoffMs: 1000, requestWei: 100n, totalWei: 150n};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-state-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return join(dir, 'state.json');
}
test('attempts, exponential backoff and reservations persist across restart', async t => {
  const path = await fixture(t);
  let state = await openRelayState(path, 'scope', limits);
  await state.reserve(1n, 10n, pending, 1000);
  assert.equal(state.reason(1n, 1000), 'unresolved transaction');
  await state.confirmed(hash);
  assert.equal(state.reason(1n, 1999), 'backoff');
  await state.close();
  state = await openRelayState(path, 'scope', limits);
  assert.equal(state.data.authorizedWei, '10');
  await state.reserve(1n, 10n, pending, 2000);
  await state.confirmed(hash);
  assert.equal(state.reason(1n, 3999), 'backoff');
  await state.reserve(1n, 10n, pending, 4000);
  await state.confirmed(hash);
  assert.equal(state.reason(1n, 10000), 'attempt limit');
  await state.close();
});
test('event cursor and unfinished request IDs persist across restart', async t => {
  const path = await fixture(t);
  let state = await openRelayState(path, 'scope', limits, 100n);
  await state.indexed([7n, 1_000_000n], 201n);
  await state.close();
  state = await openRelayState(path, 'scope', limits, 0n);
  assert.equal(state.data.firstBlock, '100');
  assert.equal(state.data.nextBlock, '201');
  assert.deepEqual(state.requestIds(), [7n, 1_000_000n]);
  await state.delivered(7n);
  assert.deepEqual(state.requestIds(), [1_000_000n]);
  await state.close();
});
test('completed request accounting compacts into the lifetime total', async t => {
  const state = await openRelayState(await fixture(t), 'scope', limits);
  await state.indexed([1n], 2n);
  await state.reserve(1n, 10n, pending, 1000);
  await state.confirmed(hash);
  await state.delivered(1n);
  assert.equal(state.data.authorizedWei, '10');
  assert.equal(state.data.retiredWei, '10');
  assert.equal(state.data.requests['1'], undefined);
  assert.deepEqual(state.requestIds(), []);
  await state.close();
});
test('request and global caps prevent reservations exceeding either cap', async t => {
  const state = await openRelayState(await fixture(t), 'scope', limits);
  assert.equal(await state.reserve(1n, 101n, pending), 'request spending cap');
  await state.reserve(1n, 100n, pending);
  await state.confirmed(hash);
  assert.equal(await state.reserve(2n, 51n, pending), 'total spending cap');
  await state.reserve(2n, 50n, pending);
  await state.confirmed(hash);
  assert.equal(state.reason(3n), 'total spending cap');
  await state.close();
});
test('successful reimbursement renews the operating cap without erasing lifetime spend', async t => {
  const state = await openRelayState(await fixture(t), 'scope', limits);
  await state.reserve(1n, 100n, pending, 1000, 80n);
  await state.confirmed(hash, 1);
  await state.retireOperation(1n);
  assert.equal(state.data.authorizedWei, '100');
  assert.equal(state.data.reimbursedWei, '80');
  assert.equal(state.data.retiredWei, '100');
  assert.equal(await state.reserve(1n, 100n, pending, 2000), null);
  await state.close();
});
test('a reimbursed fulfillment renews capacity after the operating cap is reached', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 150n});
  await state.reserve(1n, 150n, pending, 1000);
  await state.confirmed(hash, 1);
  assert.equal(state.reason(2n), 'total spending cap');
  assert.equal(await state.reserve(2n, 50n, pending, 2000, 100n), null);
  await state.confirmed(hash, 1);
  assert.equal(state.data.authorizedWei, '200');
  assert.equal(state.data.reimbursedWei, '100');
  await state.close();
});
test('failed fulfillment does not replenish the operating cap', async t => {
  const state = await openRelayState(await fixture(t), 'scope', limits);
  await state.reserve(1n, 100n, pending, 1000, 100n);
  await state.confirmed(hash, 0);
  await state.retireOperation(1n);
  assert.equal(state.data.reimbursedWei, '0');
  assert.equal(await state.reserve(1n, 51n, pending, 2000), 'total spending cap');
  await state.close();
});
test('reimbursement metadata must be nonnegative', async t => {
  const state = await openRelayState(await fixture(t), 'scope', limits);
  await assert.rejects(state.reserve(1n, 10n, pending, 1000, -1n));
  await state.close();
});
test('duplicate writers and different signer/router scopes fail closed', async t => {
  const path = await fixture(t);
  const state = await openRelayState(path, 'scope', limits);
  await assert.rejects(openRelayState(path, 'scope', limits), {code: 'EEXIST'});
  await state.close();
  await assert.rejects(openRelayState(path, 'other', limits));
});
test('a stale file lock from a dead process is taken over', async t => {
  const path = await fixture(t);
  await mkdir(`${path}.lock`, {mode: 0o700});
  // No live process can hold this out-of-range PID.
  await writeFile(join(`${path}.lock`, 'pid'), '999999999\n', {mode: 0o600});
  const state = await openRelayState(path, 'scope', limits);
  await state.indexed([7n], 10n);
  await state.close();
  const reopened = await openRelayState(path, 'scope', limits);
  assert.deepEqual(reopened.requestIds(), [7n]);
  await reopened.close();
});
test('a file lock held by a live process is still refused', async t => {
  const path = await fixture(t);
  await mkdir(`${path}.lock`, {mode: 0o700});
  await writeFile(join(`${path}.lock`, 'pid'), `${process.pid}\n`, {mode: 0o600});
  await assert.rejects(openRelayState(path, 'scope', limits), {code: 'EEXIST'});
  // Fail-closed must leave the live holder's lock untouched.
  assert.equal((await readFile(join(`${path}.lock`, 'pid'), 'utf8')).trim(), String(process.pid));
});
test('sender persists reservation before broadcast and retains uncertain submissions', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000000n, totalWei: 1000000n});
  let broadcasts = 0;
  const provider = {send: async () => '0x1', estimateGas: async () => 21000n,
    broadcastTransaction: async () => { broadcasts++; assert.ok(state.data.pending); throw new Error('Connection lost'); }};
  const wallet = {address: '0x1', populateTransaction: async tx => ({...tx, nonce: 0}), signTransaction: async () => '0x1234'};
  const send = boundedSender({wallet, provider, state, maxGasPrice: 2n});
  assert.equal((await send(1n, {}, 60000n)).pending, true);
  assert.equal(state.data.authorizedWei, '60000');
  assert.ok(state.data.pending);
  assert.equal((await send(2n, {}, 60000n)).paused, 'unresolved transaction');
  assert.equal(broadcasts, 1);
  await state.close();
});
test('high gas price pauses without signing or reserving', async () => {
  const send = boundedSender({wallet: {}, state: {}, provider: {send: async () => '0x3'}, maxGasPrice: 2n});
  assert.deepEqual(await send(1n, {}, 1n), {paused: 'gas price cap'});
});

test('corrupted ledger is rejected, never silently reset', async t => {
  const path = await fixture(t);
  await writeFile(path, '{broken', {mode: 0o600});
  await assert.rejects(openRelayState(path, 'scope', limits));
});
test('version 1 ledger migration preserves prior spending and attempt limits', async t => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify({version: 1, scope: 'scope', authorizedWei: '10',
    requests: {'1': {attempts: 1, authorizedWei: '10', nextAttemptAt: 0}}, pending: null}), {mode: 0o600});
  const state = await openRelayState(path, 'scope', limits, 100n);
  assert.equal(state.data.version, 6);
  assert.equal(state.data.authorizedWei, '10');
  assert.equal(state.data.requests['1'].attempts, 1);
  assert.equal(state.data.nextBlock, '100');
  await state.close();
});
test('version 3 pending transaction migrates with zero reimbursement', async t => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify({version: 3, scope: 'scope', authorizedWei: '10',
    retiredWei: '0', requests: {'1': {attempts: 1, authorizedWei: '10', nextAttemptAt: 2000}},
    pending: {id: '1', hash, signedTransaction: '0x1234', nonce: '0', submittedAt: 1000,
      lastBroadcastAt: 1001}, firstBlock: '100', nextBlock: '101', pendingIds: {'1': true}}), {mode: 0o600});
  const state = await openRelayState(path, 'scope', limits);
  assert.equal(state.data.version, 6);
  assert.equal(state.data.reimbursedWei, '0');
  assert.equal(state.data.pending.reimbursementWei, '0');
  assert.equal(state.data.pending.signedTransaction, '0x1234');
  assert.equal(state.data.pending.rebroadcastCount, 0);
  await state.close();
});

test('version 4 pending transaction migrates bounded recovery fields', async t => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify({version: 4, scope: 'scope', authorizedWei: '10', reimbursedWei: '0',
    retiredWei: '0', requests: {'1': {attempts: 1, authorizedWei: '10', nextAttemptAt: 2000}},
    pending: {id: '1', hash, signedTransaction: '0x1234', nonce: '0', submittedAt: 1000,
      lastBroadcastAt: 1001, reimbursementWei: '0'}, firstBlock: '100', nextBlock: '101',
    pendingIds: {'1': true}}), {mode: 0o600});
  const state = await openRelayState(path, 'scope', limits);
  assert.equal(state.data.version, 6);
  assert.deepEqual({count: state.data.pending.rebroadcastCount, next: state.data.pending.nextRebroadcastAt,
    manual: state.data.pending.manualIntervention, reason: state.data.pending.manualReason},
  {count: 0, next: '0', manual: false, reason: null});
  assert.equal(state.data.requests['1'].nextAttemptAt, '2000');
  assert.equal(state.data.pending.submittedAt, '1000');
  assert.equal(state.data.pending.lastBroadcastAt, '1001');
  await state.close();
});

test('a legacy fee-claim pending transaction migrates to manual intervention', async t => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify({version: 6, scope: 'scope', authorizedWei: '10',
    reimbursedWei: '0', retiredWei: '0',
    requests: {'fee-claim': {attempts: 1, authorizedWei: '10', nextAttemptAt: '1000'}},
    pending: {id: 'fee-claim', hash, signedTransaction: '0x1234', nonce: '0', submittedAt: '1000',
      lastBroadcastAt: '1001', reimbursementWei: '0', rebroadcastCount: 0, nextRebroadcastAt: '0',
      manualIntervention: false, manualReason: null},
    firstBlock: '0', nextBlock: '0', pendingIds: {}}), {mode: 0o600});
  const state = await openRelayState(path, 'scope', limits);
  assert.equal(state.data.requests['fee-claim'], undefined);
  assert.match(state.data.pending.id, /^[1-9][0-9]*$/);
  assert.equal(state.data.requests[state.data.pending.id].authorizedWei, '10');
  assert.equal(state.data.pending.manualIntervention, true);
  assert.equal(state.data.pending.manualReason, 'legacy fee-claim operation');
  assert.equal(state.data.authorizedWei, '10');
  assert.equal(state.data.retiredWei, '0');
  // Receipt monitoring continues but automatic broadcasting stays off.
  const result = await reconcilePending({wallet: {address: '0x1'}, state, provider: {
    getTransactionReceipt: async () => null, getBlockNumber: async () => 1,
    getTransactionCount: async () => 0, getTransaction: async () => null,
  }});
  assert.equal(result.reason, 'manual intervention: legacy fee-claim operation');
  await state.close();
  // The migrated ledger reloads cleanly under the current validator.
  const reopened = await openRelayState(path, 'scope', limits);
  assert.equal(reopened.data.pending.manualIntervention, true);
  await reopened.close();
});

test('a settled legacy fee-claim reservation folds into lifetime spending', async t => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify({version: 6, scope: 'scope', authorizedWei: '15',
    reimbursedWei: '0', retiredWei: '5',
    requests: {'fee-claim': {attempts: 2, authorizedWei: '10', nextAttemptAt: '1000'}},
    pending: null, firstBlock: '0', nextBlock: '0', pendingIds: {}}), {mode: 0o600});
  const state = await openRelayState(path, 'scope', limits);
  assert.equal(state.data.requests['fee-claim'], undefined);
  assert.equal(state.data.retiredWei, '15');
  assert.equal(state.data.authorizedWei, '15');
  await state.close();
});

test('inconsistent version 6 manual intervention state is rejected', async t => {
  const path = await fixture(t);
  let state = await openRelayState(path, 'scope', limits);
  await state.reserve(1n, 10n, pending, 1000);
  await state.close();
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.pending.manualIntervention = true;
  data.pending.manualReason = null;
  await writeFile(path, JSON.stringify(data), {mode: 0o600});
  await assert.rejects(openRelayState(path, 'scope', limits), /Invalid pending state/);
});

for (const invalidTimestamp of [Number.MAX_SAFE_INTEGER + 1, 1.5, -1]) {
  test(`version 5 migration rejects invalid timestamp ${invalidTimestamp}`, async t => {
    const path = await fixture(t);
    let state = await openRelayState(path, 'scope', limits);
    await state.reserve(1n, 10n, pending, 1000);
    await state.close();
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.version = 5;
    data.requests['1'].nextAttemptAt = invalidTimestamp;
    data.pending.submittedAt = 1000;
    data.pending.lastBroadcastAt = 0;
    data.pending.nextRebroadcastAt = 0;
    await writeFile(path, JSON.stringify(data), {mode: 0o600});
    await assert.rejects(openRelayState(path, 'scope', limits), /Invalid legacy timestamp/);
  });
}

test('state methods reject unsafe numeric Unix timestamps', async t => {
  const state = await openRelayState(await fixture(t), 'scope', limits);
  await assert.rejects(state.reserve(1n, 10n, pending, Number.MAX_SAFE_INTEGER + 1),
    /Invalid Unix timestamp/);
  await state.close();
});

for (const status of [0, 1, null]) test(`receipt status ${status} preserves conservative spending`, async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000000n, totalWei: 1000000n});
  const provider = {send: async () => '0x1', estimateGas: async () => 21000n,
    broadcastTransaction: async () => {}, waitForTransaction: async () => status === null ? null : {status}};
  const wallet = {address: '0x1', populateTransaction: async tx => ({...tx, nonce: 0}), signTransaction: async () => '0x1234'};
  const send = boundedSender({wallet, provider, state, maxGasPrice: 2n});
  if (status === null) { assert.equal((await send(1n, {}, 60000n)).pending, true); assert.ok(state.data.pending); }
  else { assert.equal((await send(1n, {}, 60000n)).status, status); assert.equal(state.data.pending, null); }
  assert.equal(state.data.authorizedWei, '60000');
  assert.equal(state.data.requests['1'].attempts, 1);
  await state.close();
});

test('pending reconciliation rebroadcasts identical bytes when the nonce remains unused', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  await state.reserve(1n, 10n, pending, 1000);
  let raw;
  const provider = {
    getTransactionReceipt: async () => null,
    getTransaction: async () => null,
    getBlockNumber: async () => 1,
    getTransactionCount: async () => 0,
    broadcastTransaction: async value => { raw = value; },
    waitForTransaction: async () => ({status: 1}),
  };
  const result = await reconcilePending({wallet: {address: '0x1'}, provider, state, receiptTimeoutMs: 1});
  assert.equal(raw, pending.signedTransaction);
  assert.deepEqual(result, {resolved: true, hash, status: 1});
  assert.equal(state.data.pending, null);
  await state.close();
});

test('consumed confirmed nonce retires the impossible transaction for retry', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  await state.reserve(1n, 10n, pending, 1000);
  let nonceBlock;
  const result = await reconcilePending({wallet: {address: '0x1'}, state, confirmations: 2,
    provider: {
      getTransactionReceipt: async () => null,
      // A stale sequencer response may still expose the replaced transaction as pending.
      getTransaction: async () => ({hash}),
      getBlockNumber: async () => 101,
      getTransactionCount: async (_address, block) => { nonceBlock = block; return 1; },
    }});
  assert.deepEqual(result, {resolved: true, hash, status: 'replaced'});
  assert.equal(nonceBlock, 100);
  assert.equal(state.data.pending, null);
  assert.equal(state.data.requests['1'].attempts, 1);
  await state.close();
});

test('rebroadcast backoff and limit persist across restart', async t => {
  const path = await fixture(t);
  let state = await openRelayState(path, 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  await state.reserve(1n, 10n, pending, 1000);
  let broadcasts = 0;
  const provider = {
    getTransactionReceipt: async () => null,
    getTransaction: async () => null,
    getBlockNumber: async () => 1,
    getTransactionCount: async () => 0,
    broadcastTransaction: async () => { broadcasts++; throw new Error('RPC rejected'); },
  };
  assert.equal((await reconcilePending({wallet: {address: '0x1'}, provider, state,
    maxRebroadcasts: 1, rebroadcastBackoffMs: 30000, now: 2000})).reason, 'rebroadcast rejected');
  assert.equal(state.data.pending.rebroadcastCount, 1);
  assert.equal(state.data.pending.nextRebroadcastAt, '32000');
  await state.close();

  state = await openRelayState(path, 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  assert.equal((await reconcilePending({wallet: {address: '0x1'}, provider, state,
    maxRebroadcasts: 1, rebroadcastBackoffMs: 30000, now: 3000})).reason, 'rebroadcast backoff');
  assert.equal((await reconcilePending({wallet: {address: '0x1'}, provider, state,
    maxRebroadcasts: 1, rebroadcastBackoffMs: 30000, now: 32000})).reason,
  'manual intervention: rebroadcast limit reached');
  assert.equal(state.data.pending.manualIntervention, true);
  assert.equal(broadcasts, 1);
  assert.match((await reconcilePending({wallet: {address: '0x1'}, provider, state, now: 100000})).reason,
    /^manual intervention:/);
  assert.equal(broadcasts, 1);
  await state.close();
});

test('manual intervention still resolves from a confirmed receipt', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  await state.reserve(1n, 10n, pending, 1000);
  await state.requireManualIntervention(hash, 'rebroadcast limit reached');
  const result = await reconcilePending({wallet: {address: '0x1'}, state, confirmations: 2,
    provider: {
      getTransactionReceipt: async () => ({status: 1, blockNumber: 100}),
      getBlockNumber: async () => 101,
    }});
  assert.deepEqual(result, {resolved: true, hash, status: 1});
  assert.equal(state.data.pending, null);
  await state.close();
});

test('unexpected confirmed nonce gap enters manual intervention once', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  await state.reserve(1n, 10n, {...pending, nonce: 1n}, 1000);
  const provider = {
    getTransactionReceipt: async () => null,
    getTransaction: async () => null,
    getBlockNumber: async () => 10,
    getTransactionCount: async () => 0,
  };
  assert.equal((await reconcilePending({wallet: {address: '0x1'}, state, provider})).reason,
    'manual intervention: nonce gap');
  assert.equal(state.data.pending.manualIntervention, true);
  assert.equal(state.data.pending.manualReason, 'confirmed nonce is below stored nonce');
  assert.match((await reconcilePending({wallet: {address: '0x1'}, state, provider})).reason,
    /^manual intervention:/);
  await state.close();
});

test('pending reconciliation stays nonfatal while a transaction remains in the mempool', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  await state.reserve(1n, 10n, pending, 1000);
  const result = await reconcilePending({wallet: {address: '0x1'}, state, provider: {
    getTransactionReceipt: async () => null, getBlockNumber: async () => 1,
    getTransactionCount: async () => 0, getTransaction: async () => ({hash}),
  }});
  assert.deepEqual(result, {resolved: false, hash, reason: 'mempool'});
  assert.ok(state.data.pending);
  await state.close();
});

test('pending reconciliation retires a mempool transaction superseded by another relayer', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  await state.reserve(1n, 10n, pending, 1000);
  let obsoleteChecks = 0;
  const result = await reconcilePending({wallet: {address: '0x1'}, state,
    isObsolete: async stored => { obsoleteChecks++; return stored.hash === hash; },
    provider: {
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => 1,
      getTransactionCount: async () => 0,
      getTransaction: async () => ({hash}),
    }});
  assert.deepEqual(result, {resolved: true, hash, status: 'superseded'});
  assert.equal(obsoleteChecks, 1);
  assert.equal(state.data.pending, null);
  await state.close();
});

test('pending reconciliation waits for configured confirmation depth', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  await state.reserve(1n, 10n, pending, 1000);
  let head = 100;
  const provider = {
    getTransactionReceipt: async () => ({status: 1, blockNumber: 100}),
    getBlockNumber: async () => head,
  };
  assert.deepEqual(await reconcilePending({wallet: {address: '0x1'}, provider, state, confirmations: 2}),
    {resolved: false, hash, reason: 'confirming', confirmations: 1});
  assert.ok(state.data.pending);
  head = 101;
  assert.deepEqual(await reconcilePending({wallet: {address: '0x1'}, provider, state, confirmations: 2}),
    {resolved: true, hash, status: 1});
  assert.equal(state.data.pending, null);
  await state.close();
});

test('pending reconciliation without the lease observes but never rebroadcasts', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  await state.reserve(1n, 10n, pending, 1000);
  let broadcasts = 0;
  const result = await reconcilePending({wallet: {address: '0x1'}, state, allowBroadcast: false,
    provider: {
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => 1,
      getTransactionCount: async () => 0,
      getTransaction: async () => null,
      broadcastTransaction: async () => { broadcasts++; },
    }});
  assert.deepEqual(result, {resolved: false, hash, reason: 'lease held by successor'});
  assert.equal(broadcasts, 0);
  assert.ok(state.data.pending);
  await state.close();
});

test('superseded pending transaction is retired without rebroadcast', async t => {
  const state = await openRelayState(await fixture(t), 'scope', {...limits, requestWei: 1000n, totalWei: 1000n});
  await state.reserve(1n, 10n, pending, 1000);
  let broadcasts = 0;
  const result = await reconcilePending({wallet: {address: '0x1'}, state,
    isObsolete: async stored => stored.hash === hash,
    provider: {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
      broadcastTransaction: async () => { broadcasts++; },
    }});
  assert.deepEqual(result, {resolved: true, hash, status: 'superseded'});
  assert.equal(broadcasts, 0);
  assert.equal(state.data.pending, null);
  await state.close();
});
