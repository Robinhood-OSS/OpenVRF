import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {
  fetchSignature,
  assignedRelayer,
  pruneCompletedRequests,
  reconciliationHead,
  relayOnce as runRelay,
  syncRequests,
  GENESIS,
} from './relay.mjs';

function memoryState(ids = []) {
  const pendingIds = Object.fromEntries(ids.map(id => [String(id), true]));
  const state = {
    data: {pending: null, firstBlock: '0', nextBlock: '0', pendingIds},
    reason: () => null,
    requestIds: () => Object.keys(pendingIds).map(BigInt).sort((a, b) => a < b ? -1 : 1),
    indexed: async (found, nextBlock) => {
      for (const id of found) pendingIds[String(id)] = true;
      state.data.nextBlock = String(nextBlock);
    },
    delivered: async id => { delete pendingIds[String(id)]; },
    deliveredMany: async ids => { for (const id of ids) delete pendingIds[String(id)]; },
  };
  return state;
}

// Adapt these queue tests to transaction population; policy is tested separately.
async function relayOnce(options) {
  const router = {...options.router, proveRound: {staticCall: async () => {}}};
  for (const method of ['fulfill', 'retryCallback']) {
    if (router[method]) router[method] = {populateTransaction: (...args) => ({method, args})};
  }
  return runRelay({...options, router, state: options.state ?? memoryState(options.ids),
    send: async (_id, tx) => {
      const response = await options.router[tx.method](...tx.args);
      await response.wait();
      return {hash: response.hash, status: 1};
    }});
}

const signature = 'ab'.repeat(64);
test('router-wide discovery uses no consumer filter and retains both campaigns', async () => {
  const state = memoryState();
  await syncRequests({state, latestBlock: 1n, headLag: 0n, router: {
    filters: {RandomnessRequested: (id, consumer) => {
      assert.equal(id, null);
      assert.equal(consumer, null);
      return 'all-campaigns';
    }},
    queryFilter: async () => [{args: {requestId: 1n}}, {args: {requestId: 2n}}],
  }});
  assert.deepEqual(state.requestIds(), [1n, 2n]);
});

test('router-wide worker isolates a failed campaign and retries it on a later pass', async () => {
  const state = memoryState([1n, 2n]);
  const delivered = new Set();
  const sent = [];
  let failFirst = true;
  const router = {
    requests: async id => ({consumer: id === 1n ? '0xabc' : '0xdef', round: 1n,
      delivered: delivered.has(id), fulfilled: true, callbackGasLimit: 100000n}),
    retryCallback: async id => {
      if (id === 1n && failFirst) throw new Error('campaign callback failure');
      sent.push(id);
      return {hash: '0x1', wait: async () => delivered.add(id)};
    },
  };
  const options = {state, router, now: GENESIS, urls: [], log: () => {}};
  await relayOnce(options);
  assert.deepEqual(sent, [2n]);
  assert.deepEqual(state.requestIds(), [1n]);
  failFirst = false;
  await relayOnce(options);
  assert.deepEqual(sent, [2n, 1n]);
  assert.deepEqual(state.requestIds(), []);
});

test('request IDs are assigned round-robin to one configured relayer', () => {
  const relayers = ['0xaaa', '0xbbb', '0xccc'];
  assert.equal(assignedRelayer(1n, relayers), relayers[0]);
  assert.equal(assignedRelayer(2n, relayers), relayers[1]);
  assert.equal(assignedRelayer(3n, relayers), relayers[2]);
  assert.equal(assignedRelayer(4n, relayers), relayers[0]);
  assert.equal(assignedRelayer(1n, relayers, 100n, 159n, 60n), relayers[0]);
  assert.equal(assignedRelayer(1n, relayers, 100n, 160n, 60n), relayers[1]);
  assert.equal(assignedRelayer(1n, relayers, 100n, 220n, 60n), relayers[2]);
  assert.throws(() => assignedRelayer(0n, relayers), /Invalid relayer assignment/);
});

test('a relayer processes only its round-robin requests including retries', async () => {
  const sent = [];
  const relayers = ['0xaaa', '0xbbb'];
  const state = memoryState([1n, 2n, 3n, 4n]);
  await relayOnce({state, now: GENESIS, urls: ['https://drand'], log: () => {},
    fetchFn: async () => ({ok: true, json: async () => ({round: 1, signature})}),
    relayer: relayers[1], relayers, router: {
      requests: async id => ({consumer: '0x1', round: 1n, delivered: false,
        fulfilled: id === 4n, callbackGasLimit: 100000n}),
      fulfill: async id => ({hash: '0x1', wait: async () => sent.push(['fulfill', id])}),
      retryCallback: async id => ({hash: '0x2', wait: async () => sent.push(['retry', id])}),
    }});
  assert.deepEqual(sent, [['fulfill', 2n], ['retry', 4n]]);
  assert.deepEqual(state.requestIds(), [1n, 2n, 3n, 4n]);
});

test('successful proof submission reports its stored fee as reimbursement', async () => {
  let reimbursement;
  const state = memoryState([1n]);
  await runRelay({state, now: GENESIS, urls: ['https://drand'], consumer: '0x1', log: () => {},
    fetchFn: async () => ({ok: true, json: async () => ({round: 1, signature})}),
    router: {
      requests: async () => ({consumer: '0x1', round: 1n, delivered: false, fulfilled: false,
        callbackGasLimit: 100000n, fee: 123n}),
      proveRound: {staticCall: async () => {}},
      fulfill: {populateTransaction: async () => ({to: 'router'})},
    },
    send: async (_id, _transaction, _gasFloor, fee) => {
      reimbursement = fee;
      return {hash: '0x1', status: 1};
    }});
  assert.equal(reimbursement, 123n);
});

test('paused requests do not acquire or renew a cross-wallet lease', async () => {
  let leases = 0;
  const state = memoryState([1n]);
  state.reason = () => 'attempt limit';
  state.acquireRequest = async () => { leases++; return true; };
  await runRelay({state, now: GENESIS, urls: [], consumer: '0x1', relayer: '0xaaa',
    relayers: ['0xaaa', '0xbbb'], failoverSeconds: 60n, leaseSeconds: 120n, log: () => {},
    send: assert.fail, router: {
      requests: async () => ({consumer: '0x1', round: 1n, delivered: false, fulfilled: true,
        callbackGasLimit: 100000n}),
    }});
  assert.equal(leases, 0);
});

test('shutdown after transaction preparation releases the current relayer lease', async () => {
  const state = memoryState([1n]);
  let acquired = false;
  let released;
  state.acquireRequest = async () => { acquired = true; return true; };
  state.releaseRequest = async (id, holder) => { released = [id, holder]; };
  await runRelay({state, now: GENESIS, urls: [], consumer: '0x1', relayer: '0xaaa',
    relayers: ['0xaaa'], failoverSeconds: 60n, leaseSeconds: 120n, log: () => {},
    isStopping: () => acquired, send: assert.fail, router: {
      requests: async () => ({consumer: '0x1', round: 1n, delivered: false, fulfilled: true,
        callbackGasLimit: 100000n}),
      retryCallback: {populateTransaction: async () => ({to: 'router'})},
    }});
  assert.deepEqual(released, [1n, '0xaaa']);
});

test('HTTP reconciliation detects a silently stale WebSocket head', async () => {
  assert.deepEqual(await reconciliationHead({getBlockNumber: async () => 120}, 100),
    {httpHead: 120, changed: true, websocketBehind: true});
  assert.deepEqual(await reconciliationHead({getBlockNumber: async () => 120}, 120),
    {httpHead: 120, changed: false, websocketBehind: false});
});
test('formatted but rejected signatures trigger validated endpoint fallback', async () => {
  let validations = 0;
  const result = await fetchSignature(1n, ['https://one', 'https://two'],
    async () => ({ok: true, json: async () => ({round: 1, signature})}),
    async () => { if (++validations === 1) throw new Error('Verifier rejected'); });
  assert.equal(result, `0x${signature}`);
  assert.equal(validations, 2);
});
test('falls back when an endpoint returns the wrong round or malformed data', async () => {
  let calls = 0;
  const fetchFn = async () => ({ok: true, json: async () => ++calls === 1
    ? {round: 999, signature} : {round: 1000, signature}});
  assert.equal(await fetchSignature(1000n, ['https://first', 'https://second'], fetchFn), `0x${signature}`);
  assert.equal(calls, 2);
  await assert.rejects(fetchSignature(1000n, ['https://first'], async () => ({ok: false})));
});

test('restarts discover pending requests, retry callbacks, skip future/completed/other consumers', async () => {
  const sent = [];
  const consumer = '0x123';
  const requests = [null,
    {consumer, round: 1n, delivered: false, fulfilled: false, callbackGasLimit: 100000n},
    {consumer, round: 1n, delivered: false, fulfilled: true, callbackGasLimit: 100000n},
    {consumer, round: 1n, delivered: true},
    {consumer, round: 10000n, delivered: false},
    {consumer: '0x456', round: 1n, delivered: false},
  ];
  const transaction = async (id, type) => {
    sent.push([id, type]);
    return {hash: '0x1', wait: async () => { requests[Number(id)].delivered = true; }};
  };
  const router = {
    nextRequestId: async () => 6n,
    requests: async id => requests[Number(id)],
    fulfill: async id => transaction(id, 'fulfill'),
    retryCallback: async (id, gasLimit) => {
      assert.equal(gasLimit, 150000n);
      return transaction(id, 'retry');
    },
  };
  const options = {router, now: GENESIS + 100n, urls: ['https://drand'], consumer,
    fetchFn: async () => ({ok: true, json: async () => ({round: 1, signature})}), log: () => {}};
  const state = memoryState([1n, 2n, 3n, 4n, 5n]);
  await relayOnce({...options, state});
  await relayOnce({...options, state});
  assert.deepEqual(sent, [[1n, 'fulfill'], [2n, 'retry']]);
});

test('one failed request does not block later ones', async () => {
  const sent = [];
  await relayOnce({ids: [1n, 2n], now: GENESIS, urls: [], log: () => {}, router: {
    nextRequestId: async () => 3n,
    requests: async () => ({consumer: '0x1', round: 1n, delivered: false, fulfilled: true, callbackGasLimit: 100000n}),
    retryCallback: async id => {
      if (id === 1n) throw new Error('unavailable');
      return {hash: '0x2', wait: async () => sent.push(id)};
    },
  }});
  assert.deepEqual(sent, [2n]);
});

test('HTTP failure and missing fields fall back to an available endpoint', async () => {
  let calls = 0;
  const fetched = await fetchSignature(1000n, ['https://one', 'https://two', 'https://three'], async () => {
    calls++;
    if (calls === 1) throw new Error('connection unavailable');
    return {ok: true, json: async () => calls === 2 ? {} : {round: 1000, signature}};
  });
  assert.equal(fetched, `0x${signature}`);
  assert.equal(calls, 3);
});

test('unavailable beacon endpoints do not cause a paid submission', async () => {
  let submissions = 0;
  await relayOnce({ids: [1n], now: GENESIS, urls: ['https://offline'], log: () => {},
    fetchFn: async () => ({ok: false}), router: {
      nextRequestId: async () => 2n,
      requests: async () => ({consumer: '0x1', round: 1n, delivered: false, fulfilled: false}),
      fulfill: async () => { submissions++; },
    }});
  assert.equal(submissions, 0);
});

test('a fresh relayer invocation skips a request already delivered on chain', async () => {
  await relayOnce({ids: [1n], now: GENESIS, urls: [], log: () => {}, router: {
    nextRequestId: async () => 2n,
    requests: async () => ({consumer: '0x1', round: 1n, delivered: true}),
    fulfill: async () => assert.fail('Already delivered request must not be submitted'),
    retryCallback: async () => assert.fail('Already delivered callback must not be retried'),
  }});
});

test('event backfill advances in bounded pages and resumes after an RPC failure', async () => {
  const state = memoryState();
  const pages = [];
  let fail = true;
  const router = {
    filters: {RandomnessRequested: (_id, consumer) => ({consumer})},
    queryFilter: async (_filter, from, to) => {
      pages.push([from, to]);
      if (fail && from === 100) throw new Error('RPC unavailable');
      return from === 100 ? [{args: {requestId: 7n}}] : [];
    },
  };
  state.data.firstBlock = '100';
  state.data.nextBlock = '100';
  await assert.rejects(syncRequests({router, state, consumer: '0x1', latestBlock: 310n,
    blockRange: 100n, lookback: 0n, headLag: 0n}));
  assert.equal(state.data.nextBlock, '100');
  fail = false;
  await syncRequests({router, state, consumer: '0x1', latestBlock: 310n,
    blockRange: 100n, lookback: 0n, headLag: 0n});
  assert.deepEqual(pages.slice(1), [[100, 199], [200, 299], [300, 310]]);
  assert.deepEqual(state.requestIds(), [7n]);
  assert.equal(state.data.nextBlock, '311');
});

test('reconciliation leaves the newest blocks to the live listener', async () => {
  const state = memoryState();
  state.data.firstBlock = '100';
  state.data.nextBlock = '100';
  const pages = [];
  const router = {
    filters: {RandomnessRequested: () => ({})},
    queryFilter: async (_filter, from, to) => { pages.push([from, to]); return []; },
  };
  await syncRequests({router, state, consumer: '0x1', latestBlock: 1100n,
    blockRange: 2000n, lookback: 1000n, headLag: 5n});
  assert.deepEqual(pages, [[100, 1095]]);
  assert.equal(state.data.nextBlock, '1096');
});

test('startup multicall prunes completed and wrong-consumer requests in batches', async () => {
  const consumer = '0x0000000000000000000000000000000000000001';
  const other = '0x0000000000000000000000000000000000000002';
  const requestAbi = 'function requests(uint256) view returns (address consumer,uint64 round,uint32 callbackGasLimit,bool fulfilled,bool delivered,uint256 randomWord,uint256 fee)';
  const iface = new Interface([requestAbi]);
  const router = {target: '0x0000000000000000000000000000000000000003', interface: iface};
  const batches = [];
  const records = {
    1: [consumer, 1n, 100000n, true, true, 11n, 0n],
    2: [consumer, 1n, 100000n, false, false, 0n, 0n],
    3: [other, 1n, 100000n, false, false, 0n, 0n],
  };
  const multicall = {aggregate3: {staticCall: async calls => {
    batches.push(calls.length);
    return calls.map(call => {
      const [id] = iface.decodeFunctionData('requests', call.callData);
      const record = records[Number(id)];
      return record
        ? {success: true, returnData: iface.encodeFunctionResult('requests', record)}
        : {success: false, returnData: '0x'};
    });
  }}};
  const state = memoryState([1n, 2n, 3n, 4n]);
  await pruneCompletedRequests({router, multicall, state, consumer, batchSize: 2});
  assert.deepEqual(batches, [2, 2]);
  assert.deepEqual(state.requestIds(), [2n, 4n]);
  const routerWideState = memoryState([1n, 2n, 3n, 4n]);
  await pruneCompletedRequests({router, multicall, state: routerWideState, batchSize: 2});
  assert.deepEqual(routerWideState.requestIds(), [2n, 3n, 4n]);
});

test('unavailable Multicall3 leaves startup requests for individual verification', async () => {
  const consumer = '0x0000000000000000000000000000000000000001';
  const iface = new Interface([
    'function requests(uint256) view returns (address consumer,uint64 round,uint32 callbackGasLimit,bool fulfilled,bool delivered,uint256 randomWord,uint256 fee)',
  ]);
  const state = memoryState([1n, 2n]);
  await pruneCompletedRequests({
    router: {target: '0x0000000000000000000000000000000000000003', interface: iface},
    multicall: {aggregate3: {staticCall: async () => { throw new Error('not deployed'); }}},
    state,
    consumer,
  });
  assert.deepEqual(state.requestIds(), [1n, 2n]);
});

test('processing a high request ID reads only the pending set, not all earlier IDs', async () => {
  let reads = 0;
  const requests = {consumer: '0x1', round: 1n, delivered: true};
  await relayOnce({ids: [1_000_000n], now: GENESIS, urls: [], log: () => {}, router: {
    nextRequestId: async () => assert.fail('Full-history cursor must not be read'),
    requests: async id => { reads++; assert.equal(id, 1_000_000n); return requests; },
  }});
  assert.equal(reads, 1);
});
