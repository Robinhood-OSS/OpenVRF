import test from 'node:test';
import assert from 'node:assert/strict';
import {createGasPriceCache, boundedSender} from './sender.mjs';
import {relayOnce, GENESIS, monitorWebSocket} from './relay.mjs';

test('gas cache shares concurrent refresh, uses base-fee headroom, and expires', async () => {
  let now = 0, calls = 0, price = 100n;
  const cache = createGasPriceCache({send: async () => {calls++; return `0x${price.toString(16)}`;},
    getBlock: async () => ({baseFeePerGas: 120n})}, {now: () => now});
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.deepEqual(a, {required: 120n, buffered: 180n});
  assert.equal(a, b);
  assert.equal(calls, 1);
  now = 29999;
  assert.equal((await cache.get()).buffered, 180n);
  assert.equal(calls, 1);
  price = 200n; now = 30000;
  assert.equal((await cache.get()).buffered, 300n);
  assert.equal(calls, 2);
});

test('failed refresh does not renew stale quote; stale submissions fail until recovery', async () => {
  let now = 0, fail = false;
  const cache = createGasPriceCache({send: async () => {if (fail) throw Error('unavailable'); return '0x64';},
    getBlock: async () => ({baseFeePerGas: 100n})}, {now: () => now});
  await cache.get();
  fail = true; now = 10000;
  await assert.rejects(cache.refresh());
  assert.equal((await cache.get()).buffered, 150n); // Still within original lifetime.
  now = 30000;
  await assert.rejects(cache.get());
  await assert.rejects(cache.get());
  fail = false;
  assert.equal((await cache.get()).buffered, 150n);
});

function senderFixture(estimateGas) {
  let reserves = 0, broadcasts = 0, populated;
  const send = boundedSender({maxGasPrice: 200n,
    provider: {send: async () => '0x64', getBlock: async () => ({baseFeePerGas: 100n}), estimateGas,
      broadcastTransaction: async () => {broadcasts++;}, waitForTransaction: async () => ({status: 1})},
    wallet: {address: '0x1', populateTransaction: async tx => {populated = tx; return {...tx, nonce: 0};},
      signTransaction: async () => '0x1234'},
    state: {reserve: async (_id, cost) => {reserves++; assert.equal(cost, populated.gasLimit * populated.gasPrice); return null;},
      broadcasted: async () => {}, confirmed: async () => {}}});
  return {send, counts: () => ({reserves, broadcasts}), populated: () => populated};
}

test('prepared fulfillment reuses full simulation exactly once; retry still estimates', async () => {
  let estimates = 0;
  const f = senderFixture(async () => {estimates++; return 500000n;});
  const tx = {to: 'router', data: 'proof'};
  await f.send.prepare(tx);
  await f.send(1n, tx, 700000n);
  assert.equal(estimates, 1);
  assert.equal(f.populated().gasLimit, 700000n);
  assert.deepEqual(f.counts(), {reserves: 1, broadcasts: 1});
  await f.send(2n, tx, 700000n); // Estimate is one-use, not permanently cached.
  assert.equal(estimates, 2);
  await f.send(3n, {to: 'router', data: 'retry'}, 300000n);
  assert.equal(estimates, 3);
});

test('full simulation rejects invalid proof before spending, falls back and reuses valid estimate', async () => {
  let delivered = false, estimates = 0, fetched = 0;
  const bad = '0x' + '00'.repeat(64), good = '0x' + 'ab'.repeat(64);
  const f = senderFixture(async tx => {
    estimates++;
    if (tx.data === bad) throw Error('invalid proof');
    assert.equal(tx.data, good);
    return 500000n;
  });
  const state = {data: {pending: null}, requestIds: () => [1n], reason: () => null,
    delivered: async () => {delivered = true;}};
  const router = {requests: async () => ({consumer: '0x1', round: 1n, fulfilled: false,
      delivered: f.counts().broadcasts === 1, callbackGasLimit: 100000n, fee: 0n}),
    proveRound: {staticCall: assert.fail},
    fulfill: {populateTransaction: async (_id, signature) => ({to: 'router', data: signature})}};
  await relayOnce({router, state, send: f.send, now: GENESIS, urls: ['https://first','https://second'],
    fetchFn: async () => ({ok: true, json: async () => ({round: 1, signature: (++fetched === 1 ? bad : good).slice(2)})}),
    log: () => {}});
  assert.equal(estimates, 2); // One rejected candidate and one valid candidate, no proof-only call.
  assert.deepEqual(f.counts(), {reserves: 1, broadcasts: 1});
  assert.equal(delivered, true);
});

test('cached gas ceiling and stale-quote failure both prevent reservation and broadcast', async () => {
  let now = 0, price = '0xc8', fail = false;
  const provider = {send: async () => {if (fail) throw Error('unavailable'); return price;},
    getBlock: async () => ({baseFeePerGas: 100n}), estimateGas: assert.fail, broadcastTransaction: assert.fail};
  const cache = createGasPriceCache(provider, {now: () => now});
  await cache.refresh();
  const send = boundedSender({provider, wallet: {}, state: {reserve: assert.fail}, maxGasPrice: 200n, gasPrices: cache});
  assert.equal((await send(1n, {}, 700000n)).paused, 'gas price cap');
  now = 30000; fail = true;
  await assert.rejects(send(1n, {}, 700000n));
});


test('socket failure triggers recovery once and cleanup removes old listeners', () => {
  const socket = new EventTarget();
  let failures = 0;
  const cleanup = monitorWebSocket(socket, () => {failures++;});
  socket.dispatchEvent(new Event('close'));
  socket.dispatchEvent(new Event('error'));
  assert.equal(failures, 1);
  cleanup();
  let afterCleanup = 0;
  const cleanupFresh = monitorWebSocket(socket, () => {afterCleanup++;});
  cleanupFresh();
  socket.dispatchEvent(new Event('close'));
  socket.dispatchEvent(new Event('error'));
  assert.equal(afterCleanup, 0);
});
