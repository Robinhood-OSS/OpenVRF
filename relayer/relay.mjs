export const CHAIN_HASH = '04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';
export const GENESIS = 1727521075n;
export const PERIOD = 3n;
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
// A request read returning the zero address means the ID does not exist on chain.
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Every instance using the same ordered list independently reaches the same assignment.
export function assignedRelayer(requestId, relayers, readyAt = 0n, now = readyAt, failoverSeconds = 0n) {
  if (requestId < 1n || !relayers.length) throw new Error('Invalid relayer assignment');
  const elapsed = now > readyAt ? now - readyAt : 0n;
  const rotations = failoverSeconds > 0n ? elapsed / failoverSeconds : 0n;
  return relayers[Number((requestId - 1n + rotations) % BigInt(relayers.length))];
}

// Fail once on a broken socket; the container supervisor creates a fresh provider.
export function monitorWebSocket(socket, onFailure) {
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    onFailure();
  };
  socket.addEventListener('close', fail);
  socket.addEventListener('error', fail);
  return () => {
    socket.removeEventListener('close', fail);
    socket.removeEventListener('error', fail);
  };
}

// Deferred ethers filters deliver one event payload, not positional decoded arguments.
export function subscribeRequests(router, consumer, onRequest) {
  return router.on(router.filters.RandomnessRequested(null, consumer ?? null), event => {
    onRequest(BigInt(event.args.requestId));
  });
}

export async function reconciliationHead(provider, websocketHead) {
  const httpHead = await provider.getBlockNumber();
  return {httpHead, changed: httpHead !== websocketHead, websocketBehind: httpHead > websocketHead};
}

export async function fetchSignature(round, urls, fetchFn = fetch, validate = async () => {}, log = () => {}) {
  for (const [index, base] of urls.entries()) {
    const started = Date.now();
    try {
      const response = await fetchFn(`${base.replace(/\/$/, '')}/${CHAIN_HASH}/public/${round}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) { log(`Drand endpoint ${index + 1}: HTTP ${response.status} after ${Date.now() - started}ms`); continue; }
      const body = await response.json();
      if (String(body.round) !== String(round) || !/^[0-9a-f]{128}$/i.test(body.signature)) {
        log(`Drand endpoint ${index + 1}: malformed response after ${Date.now() - started}ms`);
        continue;
      }
      const signature = `0x${body.signature}`;
      await validate(signature, round);
      log(`Drand endpoint ${index + 1}: fetched and validated round ${round} in ${Date.now() - started}ms`);
      return signature;
    } catch {
      log(`Drand endpoint ${index + 1}: fetch or validation failed after ${Date.now() - started}ms`);
      /* Try the next public relay. On-chain BLS verification is authoritative. */
    }
  }
  throw new Error(`No drand signature available for round ${round}`);
}

// Persist each completed log page before advancing. A small overlap makes discovery idempotent and
// recovers events replaced by ordinary short reorganizations.
export async function syncRequests({router, state, consumer, latestBlock, startId = 1n,
  blockRange = 2000n, lookback = 1000n, headLag = 5n, isStopping = () => false, onDiscover = () => {}}) {
  if (latestBlock < 0n || startId < 1n || blockRange < 1n || lookback < 0n || headLag < 0n) {
    throw new Error('Invalid index configuration');
  }
  if (latestBlock < headLag) return;
  const safeHead = latestBlock - headLag;
  const firstBlock = BigInt(state.data.firstBlock);
  const cursor = BigInt(state.data.nextBlock);
  let from = cursor > lookback ? cursor - lookback : 0n;
  if (from < firstBlock) from = firstBlock;
  if (from > safeHead) from = safeHead >= lookback ? safeHead - lookback + 1n : firstBlock;
  if (from < firstBlock) from = firstBlock;
  const filter = router.filters.RandomnessRequested(null, consumer ?? null);
  while (from <= safeHead && !isStopping()) {
    const to = from + blockRange - 1n < safeHead ? from + blockRange - 1n : safeHead;
    if (from > BigInt(Number.MAX_SAFE_INTEGER) || to > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Block number exceeds JavaScript safe integer range');
    }
    const events = await router.queryFilter(filter, Number(from), Number(to));
    const ids = events.map(event => BigInt(event.args.requestId)).filter(id => id >= startId);
    await state.indexed(ids, to + 1n);
    onDiscover(ids);
    from = to + 1n;
  }
}

// A fresh service scope may discover years of already-completed requests. Multicall keeps startup
// RPC usage proportional to batches rather than request count; failed subcalls stay queued so the
// normal relay path can verify them individually instead of accidentally dropping work.
export async function pruneCompletedRequests({router, multicall, state, consumer, batchSize = 500}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Invalid multicall batch size');
  const ids = state.requestIds().filter(id => state.data.pending?.id !== String(id));
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const calls = batch.map(id => ({
      target: router.target,
      allowFailure: true,
      callData: router.interface.encodeFunctionData('requests', [id]),
    }));
    let results;
    try {
      results = await multicall.aggregate3.staticCall(calls);
    } catch {
      return;
    }
    const completed = [];
    for (let index = 0; index < batch.length; index++) {
      if (!results[index]?.success) continue;
      try {
        const request = router.interface.decodeFunctionResult('requests', results[index].returnData);
        if (request.delivered || request.consumer.toLowerCase() === ZERO_ADDRESS ||
            (consumer && request.consumer.toLowerCase() !== consumer.toLowerCase())) {
          completed.push(batch[index]);
        }
      } catch { /* Keep malformed results pending for authoritative individual verification. */ }
    }
    if (completed.length) await state.deliveredMany(completed);
  }
}

// The persistent pending set is the work queue; on-chain storage remains authoritative per request.
export async function relayOnce({router, state, send, now, urls, consumer, relayer, relayers,
  failoverSeconds = 0n, leaseSeconds = failoverSeconds,
  fetchFn = fetch, log = console.log, isStopping = () => false}) {
  if (!state || !send) throw new Error('Bounded sender and persistent state required');
  for (const id of state.requestIds()) {
    if (isStopping()) break;
    try {
      const request = await router.requests(id);
      // A zeroed on-chain record means the request event was reorganized out; it can never
      // become ready, so drop it in every mode instead of leasing and retrying it forever.
      if (request.delivered || request.consumer.toLowerCase() === ZERO_ADDRESS ||
          (consumer && request.consumer.toLowerCase() !== consumer.toLowerCase())) {
        await state.delivered(id);
        continue;
      }
      const readyAt = GENESIS + (request.round - 1n) * PERIOD;
      if (readyAt > now) continue;
      if (relayer && relayers &&
          assignedRelayer(id, relayers, readyAt, now, failoverSeconds) !== relayer) continue;
      const reason = state.reason(id);
      if (reason) { if (reason !== 'backoff' && reason !== 'unresolved transaction') log(`ALERT request ${id} paused: ${reason}`); continue; }
      if (relayer && state.acquireRequest &&
          !(await state.acquireRequest(id, relayer, leaseSeconds))) continue;
      const started = Date.now();
      log(`Processing request ${id}: beacon scheduled ${now - readyAt}s before current block timestamp`);
      const increasedRetryGas = (request.callbackGasLimit * 3n + 1n) / 2n;
      const retryGas = increasedRetryGas > 1_000_000n ? 1_000_000n : increasedRetryGas;
      let transaction;
      if (request.fulfilled) {
        transaction = await router.retryCallback.populateTransaction(id, retryGas);
      } else {
        await fetchSignature(request.round, urls, fetchFn, async signature => {
          const candidate = await router.fulfill.populateTransaction(id, signature);
          await send.prepare(candidate); // Invalid proofs fall through to the next endpoint.
          transaction = candidate;
        }, message => log(`Request ${id}: ${message}`));
      }
      if (isStopping()) {
        if (relayer) await state.releaseRequest?.(id, relayer);
        break;
      }
      log(`Request ${id}: ready to submit after ${Date.now() - started}ms preparation`);
      const result = await send(id, transaction, (request.fulfilled ? retryGas : request.callbackGasLimit) +
        (request.fulfilled ? 150000n : 600000n), request.fulfilled ? 0n : request.fee);
      if (result.paused) {
        if (relayer) await state.releaseRequest?.(id, relayer);
        log(`ALERT request ${id} paused: ${result.paused}`);
        continue;
      }
      if (result.pending) { log(`ALERT request ${id}: transaction ${result.hash} pending reconciliation${result.reason ? ` (${result.reason})` : ''}`); break; }
      log(`Processed request ${id}: ${result.hash}, status ${result.status}`);
      if (result.status !== 1 && relayer) await state.releaseRequest?.(id, relayer);
      if ((await router.requests(id)).delivered) await state.delivered(id);
      else log(`ALERT request ${id}: callback not delivered; retries remain bounded`);
    } catch (error) {
      if (!state.data.pending && relayer) await state.releaseRequest?.(id, relayer);
      // Do not print RPC errors wholesale: they can include URLs with API credentials.
      log(`Request ${id} deferred (${error.code ?? error.name ?? 'error'})`);
      if (state.failed) throw error;
    }
  }
}
