# Deployment and operator runbook

OpenVRF is developed primarily for Robinhood Chain: testnet chain ID `46630` and mainnet chain ID
`4663`. Before using another EVM chain, verify its timestamp model, BN254 precompile behavior,
canonical Multicall3 deployment, RPC limits, and gas costs. Do not copy Robinhood timing assumptions
to another network.

## Local validation

Requirements: Foundry, Node.js 22+, npm, and Docker with Compose. From the repository root:

```sh
git submodule update --init
npm ci --ignore-scripts
forge test
npm test
docker build -t openvrf:local .
npm run test:e2e
```

The Docker test sends ten same-block requests through disposable Anvil and a genuine historical
beacon proof. It requires sequential delivery of every callback, distinct request-specific words,
direct fee payment, two-wallet assignment, PostgreSQL signer locking without premature version
activation, stopped-primary takeover, active-version retirement, and restart recovery. It removes its temporary
containers/key and stops Anvil afterward. It does not spend public-chain funds.
Anvil uses an ephemeral host port for Docker access.

## Deploy a router and consumer

For PowerPot's multiple campaigns on one router, run one relayer with
`RELAY_ALL_CONSUMERS=true`. It discovers all router request events, including campaigns
authorized after startup; no per-campaign relayer is needed. Consumer authorization remains
enforced by the router. Leave the flag false and set `CONSUMER_ADDRESS` only when intentionally
restricting a worker to one campaign.

When switching an existing worker to router-wide mode, stop the old worker first and reconcile
any pending transaction before switching. The new scope backfills from `START_BLOCK`, so set it
to the router deployment block. The existing signer-wide PostgreSQL lock prevents a second
worker with the same signer from racing nonces; do not bypass it or use separate databases for
the same signer. Existing request leases, retry limits and spending limits still apply. Use the
same router-wide scope and relayer list for all wallets in a multi-wallet deployment.

Use a dedicated funded testnet deployer and a local Foundry keystore. For Robinhood testnet
(chain ID 46630), simulate first:

```sh
forge build
export OWNER_ADDRESS=0xYourMultisig
export RELAYER_ADDRESS=0xYourRelayer
export REQUEST_FEE_WEI=0
forge script script/Deploy.s.sol:Deploy --rpc-url https://rpc.testnet.chain.robinhood.com --account deployer
```

Review the simulation; repeat with `--broadcast` only when ready to submit. The script deploys
the router, not a consumer. Deploy `src/ExampleConsumer.sol:ExampleConsumer` with the resulting
router address as its constructor argument, or integrate a consumer of your own. The owner must
then call `setConsumerAuthorization(consumer, true)` before it can request randomness.
The constructor authorizes one relayer. Before starting multiple wallets, the owner must call
`setRelayerAuthorization(address, true)` for every additional address and verify each mapping value.

Keep contract addresses, transaction receipts, funding-wallet details, and environment-specific
notes in ignored local records. Check the chain ID, deployed runtime, consumer/router binding,
and receipt status before configuring the service. Never blindly repeat a deployment after a
timeout; first reconcile the original transaction.

The router is not upgradeable. Use a multisig owner and a minimally funded hot relayer; the current
owner is also implicitly authorized for emergency fulfillment. Standard ownership transfer is
immediate, so verify the recipient carefully. Set the exact request fee to zero for a free
private/self-hosted deployment, or to a nonzero amount for proof delivery. In zero-fee mode, fund the
relayer wallet separately. The successful `fulfill` transaction pays the stored fee directly to its
authorized sender even if the consumer callback fails; later retries receive no fee. Fees reimburse
proof delivery and do not fund the relayer up front.
The bundled signer is an EOA and accepts native-token payment. If an owner multisig or contract wallet
is used for emergency fulfillment, verify that it accepts native tokens; a reverting receiver makes
a paid fulfillment revert atomically without changing the committed request.
The example consumer permits public user calls, so it remains unsuitable for unattended
sponsorship without application-level admission control.

Verify multisig ownership with real administration rather than production test state. First check
that `owner()` equals the exact multisig address. Then have the multisig submit
`setRequestFee(requestFee())`: setting the current value is harmless, but its successful receipt
proves the multisig can execute an owner-only call. Confirm the sender, destination, chain ID,
status and calldata. A dedicated counter would prove less while permanently enlarging the contract.
Use `withdrawFees(recipient, amount)` only to recover native tokens in excess of the fees reserved
for pending requests; withdrawing reserved fees reverts. This authority is intentionally retained for
dead-contract recovery, so protect it with the multisig and do not use it for routine relayer reimbursement.

## Continuous relayer: controlled test use only

To operate the service, configure `.env` from
`.env.example` with HTTP and WebSocket RPC endpoints plus the exact chain, router and consumer, and provision a dedicated signer in
`secrets/relayer-key`. The container's non-root user must be able to read that one file. Do not
mount unrelated keys or a production treasury/admin key. Keep the key file at mode 0600; the
relayer prints a non-fatal startup warning if it is group- or world-readable.

```sh
docker compose up -d --build
docker compose logs -f relayer
docker compose down
```

This Compose file intentionally runs one signer. A multi-wallet deployment needs one relayer
service/container per private key, all connected to the same PostgreSQL database and configured with
the same ordered wallet list, set version, router, and consumer. See `scripts/e2e.mjs` for an
executable two-wallet example; do not scale the single service because that only duplicates one key.

For direct execution with Node.js 22+, `.mjs` files need no compilation or special runner:

```sh
npm ci --ignore-scripts
docker compose up -d postgres
set -a
source .env
set +a
export RELAYER_KEY_FILE=./secrets/relayer-key
export DATABASE_URL=postgresql://openvrf:$POSTGRES_PASSWORD@127.0.0.1:${POSTGRES_PORT:-5432}/openvrf
node relayer/main.mjs
```

The relayer validates at startup that `CONSUMER_ADDRESS` is an authorized consumer and that its
signing wallet is either the router owner or an authorized relayer. It exits instead of spending
gas when either check fails.

Fund this signer sparingly and monitor its `ALERT` logs. Defaults are three paid attempts per
request (initial submission plus at most two retries), 30-second exponential backoff capped at
one hour, 0.001 ETH maximum authorized gas cost per request, a 0.01 ETH renewable operating cap,
and a 2 gwei gas-price ceiling. Startup recovery reads up to 100,000 blocks per RPC query. Regular
event discovery reads at most 2,000 blocks per query and rechecks a 1,000-block window during
30-second reconciliation, stopping five blocks behind the head. Live requests and blocks arrive
by WebSocket subscription; missed events become eligible for reconciliation after that five-block
lag. At startup, Multicall3 checks discovered request state in batches of 500 and removes completed
requests before individual processing; failure leaves them queued for authoritative individual reads.
A queued ID whose on-chain record no longer exists (its event was reorganized out) is dropped rather
than retried, in single-consumer and router-wide mode alike.
Set `START_BLOCK` to the router deployment block; block `0` is safe
but performs unnecessary initial backfill. These values are configurable in `.env.example` and are not
estimates of current chain fees. Reservations count maximum cost, not actual receipt fees;
unused gas is deliberately NOT refunded to the budget. Successful paid fulfillments reduce operating
spend by at most the stored request fee while preserving cumulative `authorizedWei` for audit history.
`RECEIPT_TIMEOUT_SECONDS` controls only how long one receipt wait blocks; expiry preserves the
signed transaction and switches it to reconciliation instead of crashing the service. Callback
retries raise the callback gas allowance by 50%, capped at 1,000,000 gas.
`RECEIPT_CONFIRMATIONS` defaults to two; increase it if the target chain's reorganization risk
requires slower but stronger local bookkeeping.

At startup, the relayer reads the current HTTP head and backfills before processing live work. Each
30-second reconciliation reads the HTTP head again. If it is ahead of the last WebSocket block, the
service logs an alert, advances pending processing, and backfills through five blocks behind that
HTTP head. A silently stalled WebSocket therefore degrades to delayed HTTP recovery instead of
silently stopping fulfillment.

Docker stores PostgreSQL data in the `postgres_data` named volume. Back up the database alongside
the signer. Never use `docker compose down -v`, delete rows, restore an older database snapshot, or
run the same signer on the same chain against an independent database to bypass its lock or
limits. Increasing configured cap values requires explicit operator review of spending
and pending work; successful paid fulfillments renew capacity automatically under the existing cap.

PostgreSQL advisory locking permits one process per chain-and-signer scope. A stopped process
or lost database session releases the lock so another instance of that signer can take over.
Different whitelisted wallets may run concurrently. Configure the identical ordered
`RELAYER_ADDRESSES` list and `RELAYER_SET_VERSION` on every instance. The primary wallet is selected
round-robin; if it does not finish within `RELAYER_FAILOVER_SECONDS`, responsibility rotates to the
next wallet while the request remains queued everywhere. Before signing, a wallet obtains a shared
request lease and renews it while its transaction remains unresolved. `RELAYER_LEASE_SECONDS` must
cover the receipt timeout plus reconciliation interval. If a process dies after acquiring a lease,
cross-wallet takeover waits for that lease to expire. PostgreSQL rejects inconsistent assignment
policies for the same version, and a newer active version makes old processes exit. For membership
changes, stop every instance, increment the version, update the list, and restart them together.
On startup and every reconciliation, a pending transaction with a mined
receipt is finalized in the ledger. If it remains in the mempool, the relayer waits. If it is absent
and the stored nonce is still unused, the relayer rebroadcasts the exact signed bytes, producing the
same hash. `MAX_REBROADCASTS` bounds those submissions and `REBROADCAST_BACKOFF_SECONDS` controls
their persisted exponential backoff. If a confirmation-safe chain nonce has already consumed the
stored nonce, the impossible old transaction is marked replaced and the request can retry. A nonce
gap, legacy ledger without signed bytes, or exhausted rebroadcast limit enters persistent manual
intervention: receipt monitoring continues, but automatic broadcasting stops and the alert is not
repeated every reconciliation cycle.
Preserve its reservation and attempt count even if an operator establishes it was never mined.
Database timestamps and JSON recovery timestamps are Unix epoch milliseconds represented as
`BIGINT` or decimal strings. Do not convert them to local time or floating-point values in state.

To recover from manual intervention, first compare the stored hash, signed bytes, nonce, on-chain
request state, confirmed account nonce, and receipts using an independent RPC. Either rebroadcast
the exact stored signed bytes manually, or deliberately submit a same-nonce replacement from the
same wallet. Do not modify PostgreSQL. Once the original receipt reaches the configured confirmation
depth, or the replacement consumes the nonce at that depth, normal reconciliation clears the block
and retries the unfinished request when its attempt/backoff policy permits.

The configurable receipt deadline is not chain finality assurance. `uncaughtException` and
`unhandledRejection` handlers only trigger a nonzero, orderly shutdown; ordinary RPC errors are
handled at their call sites. A global handler is not permission to continue after an unknown error.
Five consecutive poll failures — for example a lost PostgreSQL connection, which the driver never
re-establishes on its own — likewise stop the worker nonzero so the orchestrator starts a fresh
process; isolated transient failures only log.
Do not leave it sponsoring the publicly callable example consumer unattended.
`START_REQUEST_ID` only filters IDs discovered from events. Leave it at `1` unless all earlier
relevant requests are delivered or intentionally abandoned. Never move `START_BLOCK` forward in
an existing database state to skip pending work; its persisted cursor remains authoritative.

| Symptom | Safe operator response |
|---|---|
| Beacon unavailable | Check provider health and the fixed target round; wait without changing the request |
| Proof rejection | Stop repeated paid attempts; validate source/key/round and use a healthy endpoint |
| Callback fails | Stop automatic spending, repair consumer cause or review gas allowance, then deliver same word |
| Manual intervention | Inspect receipt, confirmed nonce, request state, and stored signed bytes; do not delete PostgreSQL state or start another signer process |
| Low wallet balance | Stop service or top up testnet gas; preserve pending requests |
| RPC/chain mismatch | Stop and correct configuration; never disable chain validation |

The router allows an authorized relayer to call `retryCallback(id, gasLimit)` for failed delivery, with a
nondecreasing allowance up to 1,000,000. A retry is not a new randomness request.
For production, a small callback should store the result and leave payouts to separate calls.

## Keys and repository hygiene

Private keys are credentials even on testnets. Keep them in owner-restricted files, outside
tracked source. Do not print keys, signed transactions, or credential-bearing RPC URLs in logs.
Only mount the dedicated relayer key into the container; back it up privately.

Git ignores secrets, local environment files, private notes, deployment records, broadcast reports,
and generated build outputs. Ignore rules do not remove already committed data: inspect the staged
diff and scan history before publishing. A public-chain address is not a secret, but associating
an operator's wallet with a project is a separate disclosure decision. Backups containing prior
private history must stay outside the public repository.
