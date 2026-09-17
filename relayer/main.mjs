import { readFile, stat } from 'node:fs/promises';
import {
    Contract,
    FetchRequest,
    JsonRpcProvider,
    Transaction,
    Wallet,
    WebSocketProvider,
    isAddress,
    parseEther,
    parseUnits,
} from 'ethers';
import {
    relayOnce,
    reconciliationHead,
    syncRequests,
    pruneCompletedRequests,
    CHAIN_HASH,
    MULTICALL3_ADDRESS,
} from './relay.mjs';
import { openRelayState } from './state.mjs';
import { boundedSender, reconcilePending } from './sender.mjs';

// A node-postgres Client never reconnects after its connection dies: every database read then
// rejects on every poll while the process stays alive, so Docker's restart policy never fires.
// Persistent poll failure must exit nonzero for the orchestrator; transient failures only log.
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

let provider,
    wsProvider,
    wsRouter,
    state,
    reconcileTimer,
    wakeRelayer,
    fatalError,
    stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
        stopping = true;
        wakeRelayer?.();
    });
// Last-resort handlers request an orderly shutdown. Normal RPC/request failures are handled locally;
// an uncaught error is not considered safe to ignore and the process exits nonzero after cleanup.
for (const event of ['uncaughtException', 'unhandledRejection'])
    process.on(event, (error) => {
        fatalError = error instanceof Error ? error : new Error(String(error));
        stopping = true;
        wakeRelayer?.();
    });
try {
    const env = process.env;
    // Router-wide mode discovers newly authorized campaigns without restarting the worker
    // and is the Compose default; bare Node runs still require explicit opt-in here.
    const allConsumers = env.RELAY_ALL_CONSUMERS === 'true';
    const consumer = allConsumers ? undefined : env.CONSUMER_ADDRESS;
    const consumerScope = allConsumers ? 'all-consumers' : consumer;
    if (
        !env.RPC_URL ||
        !isAddress(env.ROUTER_ADDRESS ?? '') ||
        !env.RELAYER_KEY_FILE ||
        (!allConsumers && !isAddress(consumer ?? '')) ||
        !env.DATABASE_URL
    )
        throw new Error('Missing configuration');
    const connection = new FetchRequest(env.RPC_URL);
    connection.timeout = 15000;
    provider = new JsonRpcProvider(connection);
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(env.CHAIN_ID ?? '46630')) throw new Error('Chain ID mismatch');
    const keyFile = env.RELAYER_KEY_FILE;
    const wallet = new Wallet((await readFile(keyFile, 'utf8')).trim(), provider);
    // e2e.mjs deliberately uses 0644 disposable keys for Docker mounts; warn only.
    if ((await stat(keyFile)).mode & 0o077)
        console.error(`WARNING ${keyFile} is readable by group or other users; restrict it to mode 0600`);
    const router = new Contract(
        env.ROUTER_ADDRESS,
        [
            'function CHAIN_HASH() view returns (bytes32)',
            'function owner() view returns (address)',
            'function authorizedConsumers(address) view returns (bool)',
            'function authorizedRelayers(address) view returns (bool)',
            'function nextRequestId() view returns (uint256)',
            'function requests(uint256) view returns (address consumer,uint64 round,uint32 callbackGasLimit,bool fulfilled,bool delivered,uint256 randomWord,uint256 fee)',
            'function proveRound(bytes,uint64)',
            'function fulfill(uint256,bytes)',
            'function retryCallback(uint256,uint32)',
            'event RandomnessRequested(uint256 indexed requestId,address indexed consumer,uint64 round)',
        ],
        provider,
    );
    if (env.WS_URL) {
        wsProvider = new WebSocketProvider(env.WS_URL, network.chainId, { staticNetwork: true });
        wsRouter = new Contract(env.ROUTER_ADDRESS, router.interface, wsProvider);
    }
    if ((await router.CHAIN_HASH()) !== `0x${CHAIN_HASH}`) throw new Error('Beacon mismatch');
    if (consumer && !(await router.authorizedConsumers(consumer)))
        throw new Error('Consumer is not authorized');
    const owner = await router.owner();
    if (
        owner.toLowerCase() !== wallet.address.toLowerCase() &&
        !(await router.authorizedRelayers(wallet.address))
    ) {
        throw new Error('Relayer is not authorized');
    }
    const relayers = (env.RELAYER_ADDRESSES || wallet.address)
        .split(',')
        .map((address) => address.trim().toLowerCase());
    if (
        relayers.some((address) => !isAddress(address)) ||
        new Set(relayers).size !== relayers.length ||
        !relayers.includes(wallet.address.toLowerCase())
    ) {
        throw new Error('Invalid RELAYER_ADDRESSES');
    }
    const relayerSetVersion = env.RELAYER_SET_VERSION ?? '1';
    if (!/^[1-9][0-9]*$/.test(relayerSetVersion)) throw new Error('Invalid RELAYER_SET_VERSION');
    const startId = BigInt(env.START_REQUEST_ID ?? '1');
    const startBlock = BigInt(env.START_BLOCK ?? '0');
    const startupBlockRange = BigInt(env.STARTUP_EVENT_BLOCK_RANGE ?? '100000');
    const multicallBatchSize = Number(env.MULTICALL_BATCH_SIZE ?? '500');
    const blockRange = BigInt(env.EVENT_BLOCK_RANGE ?? '2000');
    const lookback = BigInt(env.REORG_LOOKBACK_BLOCKS ?? '1000');
    const headLag = BigInt(env.RECONCILE_HEAD_LAG_BLOCKS ?? '5');
    const reconcileMs = Number(env.RECONCILE_SECONDS ?? '30') * 1000;
    const receiptTimeoutMs = Number(env.RECEIPT_TIMEOUT_SECONDS ?? '60') * 1000;
    const confirmations = Number(env.RECEIPT_CONFIRMATIONS ?? '2');
    const maxRebroadcasts = Number(env.MAX_REBROADCASTS ?? '5');
    const rebroadcastBackoffMs = Number(env.REBROADCAST_BACKOFF_SECONDS ?? '30') * 1000;
    const failoverSeconds = BigInt(env.RELAYER_FAILOVER_SECONDS ?? '60');
    const leaseSeconds = BigInt(env.RELAYER_LEASE_SECONDS ?? '120');
    const maxGasPrice = parseUnits(env.MAX_GAS_PRICE_GWEI ?? '2', 'gwei');
    if (
        startId < 1n ||
        startBlock < 0n ||
        startupBlockRange < 1n ||
        !Number.isSafeInteger(multicallBatchSize) ||
        multicallBatchSize < 1 ||
        blockRange < 1n ||
        lookback < 0n ||
        headLag < 0n ||
        !Number.isSafeInteger(reconcileMs) ||
        reconcileMs < 1000 ||
        !Number.isSafeInteger(receiptTimeoutMs) ||
        receiptTimeoutMs < 1000 ||
        !Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 100 ||
        !Number.isSafeInteger(maxRebroadcasts) || maxRebroadcasts < 0 || maxRebroadcasts > 100 ||
        !Number.isSafeInteger(rebroadcastBackoffMs) || rebroadcastBackoffMs < 1000 ||
        failoverSeconds < 1n || failoverSeconds > BigInt(Number.MAX_SAFE_INTEGER) ||
        leaseSeconds < BigInt(Math.ceil(receiptTimeoutMs / 1000) + Math.ceil(reconcileMs / 1000)) ||
        leaseSeconds > BigInt(Number.MAX_SAFE_INTEGER) ||
        maxGasPrice <= 0n
    ) {
        throw new Error('Invalid configuration');
    }
    state = await openRelayState(
        env.DATABASE_URL,
        `${network.chainId}:${wallet.address}:${env.ROUTER_ADDRESS}:${consumerScope}`.toLowerCase(),
        {
            maxAttempts: Number(env.MAX_ATTEMPTS ?? '3'),
            backoffMs: Number(env.RETRY_BACKOFF_SECONDS ?? '30') * 1000,
            requestWei: parseEther(env.MAX_REQUEST_SPEND_ETH ?? '0.001'),
            totalWei: parseEther(env.MAX_TOTAL_SPEND_ETH ?? '0.01'),
        },
        startBlock,
        `${network.chainId}:${wallet.address}`.toLowerCase(),
        {
            scope: `${network.chainId}:${env.ROUTER_ADDRESS}:${consumerScope}`.toLowerCase(),
            version: relayerSetVersion,
            policy: {
                algorithm: 'request-id-round-robin-v1',
                relayers,
                failoverSeconds: String(failoverSeconds),
                leaseSeconds: String(leaseSeconds),
            },
        },
    );
    let lastPendingAlert;
    const reconcileTransaction = async () => {
        const pendingId = state.data.pending?.id;
        let ownsLease = true;
        if (pendingId) {
            ownsLease = await state.acquireRequest(
                BigInt(pendingId), wallet.address.toLowerCase(), leaseSeconds,
            );
        }
        const result = await reconcilePending({
            wallet, provider, state, receiptTimeoutMs, confirmations, allowBroadcast: ownsLease,
            maxRebroadcasts, rebroadcastBackoffMs,
            isObsolete: async (pending) => {
                if (!pending.signedTransaction) return false;
                let method;
                try {
                    const transaction = Transaction.from(pending.signedTransaction);
                    method = router.interface.parseTransaction({ data: transaction.data })?.name;
                } catch {
                    return false;
                }
                const head = await provider.getBlockNumber();
                const blockTag = Math.max(0, head - confirmations + 1);
                const request = await router.requests(BigInt(pending.id), {blockTag});
                return method === 'fulfill' ? request.fulfilled : method === 'retryCallback' && request.delivered;
            },
        });
        if (!result.resolved) {
            const alert = `${result.hash}:${result.reason}`;
            if (alert !== lastPendingAlert)
                console.error(`ALERT transaction ${result.hash} remains unresolved (${result.reason})`);
            lastPendingAlert = alert;
        } else if (result.hash) {
            lastPendingAlert = undefined;
            console.log(`Reconciled transaction ${result.hash}, status ${result.status}`);
        }
        if (result.resolved && pendingId &&
            (result.status === 'replaced' || result.status === 'superseded')) {
            await state.releaseRequest(BigInt(pendingId), wallet.address.toLowerCase());
        }
        return result.resolved;
    };
    if (state.data.pending) await reconcileTransaction();
    const send = boundedSender({ wallet, provider, state, maxGasPrice, receiptTimeoutMs, confirmations });
    const urls = (env.DRAND_URLS ?? 'https://api.drand.sh,https://api2.drand.sh,https://api3.drand.sh')
        .split(',')
        .map((url) => url.trim());
    const latestBlock = await provider.getBlock('latest');
    let latestBlockNumber = latestBlock.number;
    await syncRequests({
        router,
        state,
        consumer,
        latestBlock: BigInt(latestBlock.number),
        startId,
        blockRange: startupBlockRange,
        lookback,
        headLag,
    });
    const multicall = new Contract(
        MULTICALL3_ADDRESS,
        ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)'],
        provider,
    );
    await pruneCompletedRequests({
        router,
        multicall,
        state,
        consumer,
        batchSize: multicallBatchSize,
    });

    // Live path (no one-second HTTP polling):
    //
    //   WebSocket RandomnessRequested ──> persist request ID ──┐
    //   WebSocket new block ──────────────────────────────────┤
    //                                                        v
    //                              inspect pending IDs that may now be ready
    //                                                        |
    //                         fetch + preflight drand proof ──> fulfill/retry
    //                                                        |
    //                                  delivered ──> remove from pending set
    //
    // Recovery path (once per RECONCILE_SECONDS and on restart):
    //
    //   startup: fresh HTTP head + cursor ──> bounded eth_getLogs ──> Multicall3 prune ──> pending IDs
    //   periodic: fresh HTTP head + cursor ──> bounded eth_getLogs ──────────────────────> missed IDs
    //                RPC failure ──> cursor is unchanged ───────────────────────────────> retry next pass
    //
    // The 1,000-block default overlap makes duplicate discovery intentional and harmless. Both
    // discovery paths feed the same ID-keyed set, and this loop processes it serially.
    // Contract storage remains authoritative; PostgreSQL is the durable work queue and
    // conservative operating ledger.
    let queuedIds = [],
        blockAdvanced = true,
        lastReconcile = Date.now(),
        consecutivePollFailures = 0;
    let wake;
    const waitForWake = () =>
        new Promise((resolve) => {
            wake = resolve;
        });
    const notify = () => {
        if (wake) {
            const resolve = wake;
            wake = undefined;
            resolve();
        }
    };
    wakeRelayer = notify;
    if (wsProvider && wsRouter) {
        wsProvider.on('block', (blockNumber) => {
            latestBlockNumber = blockNumber;
            blockAdvanced = true;
            notify();
        });
        wsRouter.on(wsRouter.filters.RandomnessRequested(null, consumer ?? null), (requestId) => {
            queuedIds.push(BigInt(requestId));
            notify();
        });
    }
    reconcileTimer = setInterval(notify, reconcileMs);
    console.log(
        `Relayer ${wallet.address} on chain ${network.chainId}; relayer set ${relayerSetVersion}, round-robin slot ${relayers.indexOf(wallet.address.toLowerCase()) + 1}/${relayers.length}; ${wsProvider ? 'WebSocket listener active' : 'HTTP reconciliation active'}; authorized spending ${state.data.authorizedWei} wei`,
    );
    while (!stopping) {
        try {
            if (!(await state.assignmentActive())) {
                state.failed = true;
                throw new Error('Relayer set is no longer active');
            }
            if (queuedIds.length) {
                const ids = queuedIds;
                queuedIds = [];
                await state.discovered(ids.filter((id) => id >= startId));
            }
            if (Date.now() - lastReconcile >= reconcileMs) {
                if (state.data.pending && await reconcileTransaction()) blockAdvanced = true;
                const head = await reconciliationHead(provider, latestBlockNumber);
                if (head.changed) {
                    if (wsProvider && head.websocketBehind) {
                        console.error(
                            `ALERT WebSocket head ${latestBlockNumber} behind HTTP head ${head.httpHead}; reconciling missed blocks`,
                        );
                    }
                    latestBlockNumber = head.httpHead;
                    blockAdvanced = true;
                }
                await syncRequests({
                    router,
                    state,
                    consumer,
                    latestBlock: BigInt(head.httpHead),
                    startId,
                    blockRange,
                    lookback,
                    headLag,
                    isStopping: () => stopping,
                });
                lastReconcile = Date.now();
            }
            if (blockAdvanced && state.requestIds().length) {
                blockAdvanced = false;
                const processingBlock = await provider.getBlock('latest');
                if (!processingBlock) throw new Error('Latest block unavailable');
                await relayOnce({
                    router,
                    state,
                    send,
                    now: BigInt(processingBlock.timestamp),
                    urls,
                    consumer,
                    relayer: wallet.address.toLowerCase(),
                    relayers,
                    failoverSeconds,
                    leaseSeconds,
                    isStopping: () => stopping,
                });
            }
            consecutivePollFailures = 0;
        } catch (error) {
            if (state.failed) throw error;
            console.error(`Poll failed (${error.code ?? error.name ?? 'error'})`);
            if (++consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                console.error(
                    `ALERT ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive poll failures; stopping so the orchestrator starts a fresh worker`,
                );
                fatalError = error instanceof Error ? error : new Error(String(error));
                stopping = true;
            }
        }
        if (!stopping) await waitForWake();
    }
    if (fatalError) throw fatalError;
} catch (error) {
    const detail = typeof error.shortMessage === 'string' ? `: ${error.shortMessage}` : '';
    console.error(
        `Relayer stopped (${error.code ?? error.name ?? 'error'}${detail}); inspect configuration, state and receipts`,
    );
    process.exitCode = 1;
} finally {
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (state) await state.close();
    if (wsRouter) await wsRouter.removeAllListeners();
    if (wsProvider) await wsProvider.destroy();
    if (provider) provider.destroy();
}
