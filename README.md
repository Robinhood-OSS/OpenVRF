<div align="center">

<img src="assets/openvrf-logo.png" alt="OpenVRF" width="112">

# OpenVRF

### Verifiable randomness callbacks for EVM contracts

**Public randomness · On-chain verification · Push-based callbacks**

Request a random number from Solidity. OpenVRF binds the request to a future drand round,
verifies its threshold signature on-chain, derives a request-specific result, and calls your
contract back. The relayer delivers proofs—it cannot invent or replace the randomness.

OpenVRF is developed primarily for Robinhood Chain. Deployments on other EVM chains must verify
their timestamp model, BN254 precompile behavior, Multicall3 availability, and RPC limits.

**Verified beacon proofs · Same-result retries · Self-hosted callbacks · Optional request fees**

[Quick start](#quick-start) · [Integrate](#integrate-a-contract) ·
[How it works](#how-it-works) · [Verify a result](#verify-a-result-yourself) ·
[Security](docs/security-status.md)

</div>

![Drand beacon randomness flowing through on-chain proof verification to authenticated EVM callbacks](assets/openvrf-banner.png)

> [!NOTE]
> The previous second-future-round direct-payment revision was tested on Robinhood Chain testnet with genuine drand
> proofs, authenticated callbacks, and an exact request fee paid directly to the fulfilling wallet.
> That bounded manual smoke test used a fee equal to three times one live gas estimate; it demonstrates
> payment behavior, not a recommended production price. The continuous PostgreSQL relayer's restart,
> reconciliation, multiple-wallet, failover, and burst behavior is covered separately by local Docker
> tests. Public transactions are recorded in the [testnet evidence](docs/robinhood-testnet-evidence.md).
> An independent production audit is still recommended. Callback delivery is asynchronous and depends
> on drand publication, RPC availability, relayer availability, and block inclusion. See the documented
> [security model](docs/security-status.md) before deploying.

## One request, one verifiable result

```text
Consumer  →  requestRandomness(callbackGas)
Router    →  commits request ID + consumer + future drand round
Drand     →  publishes that round's threshold signature
Relayer   →  submits fulfill(requestId, signature)
Router    →  verifies, records, and derives the random word
Consumer  ←  rawFulfillRandomness(requestId, randomWord)
```

The request and callback happen in different transactions. A contract immediately receives a
request ID; the random word arrives later through an authenticated callback. EOAs cannot request
directly from the router.

## Why OpenVRF?

### The proof decides the result—not the relayer

The router accepts a valid signature for the request's exact drand round. A relayer cannot submit
an arbitrary number, substitute another round, change the consumer, or choose another result.
Only approved relayers may submit the proof. They are delivery services, not sources of
randomness: authorization limits fulfillment races and fee recipients, while proof verification
prevents a relayer from choosing the result. The off-chain relayer's spending caps protect its gas
wallet.

### Failed callbacks do not become redraws

The verified word is stored before callback delivery. If the consumer reverts or needs more gas,
an approved relayer can retry the callback with the **same word**. A retry cannot select a new round or produce a
more favourable outcome.

### Every result is reproducible

The read-only checker independently verifies the drand signature in JavaScript, recomputes the
request-specific word, and compares it with on-chain state, events, and the fulfillment receipt.
It requires no wallet and sends no transaction.

### Run the local delivery path yourself

The Node.js relayer is containerized and self-hosted. It validates proofs before paying gas and
persists retry limits, backoff, spending caps, and ambiguous transaction state across restarts.

### Small, inspectable contract surface

The router has no proxy, subscription, token, cancellation path, or operator-supplied entropy.
A standard owner controls consumer and relayer authorization, the exact request fee, and emergency
recovery; it cannot replace a request's consumer, round, proof, or result. Each request stores its
exact fee and pays it directly to the authorized relayer in the successful proof transaction.

Despite the name, OpenVRF is a **drand-backed callback oracle**, not a new private,
per-request VRF network. It consumes scheduled public beacon rounds rather than asking drand to
generate randomness on demand.

## Quick start

Requirements: **Foundry** (`forge`, `anvil`), **Node.js 22+**, **npm**, and **Docker**.

```sh
git submodule update --init
npm ci --ignore-scripts
forge test
npm test
docker build -t openvrf:local .
npm run test:e2e
```

This local end-to-end test deploys the real router and example consumer to disposable Anvil, submits ten
same-block requests, and starts two Docker relayers. It verifies genuine historical drand round 1000,
delivers every callback sequentially with distinct request-specific words, pays fees during
fulfillment, checks PostgreSQL budget renewal and signer locking, then restarts from durable state.
It uses no public-chain funds, does not test live drand publication or Robinhood RPC behavior, and
allocates an ephemeral local Anvil port.

## Integrate a contract

[ExampleConsumer.sol](src/ExampleConsumer.sol) contains the complete minimal integration:

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {RandomnessConsumer} from "./RandomnessConsumer.sol";
import {OpenVRF} from "./OpenVRF.sol";

contract ExampleConsumer is RandomnessConsumer {
    mapping(uint256 => uint256) public results;
    mapping(uint256 => bool) public received;

    constructor(OpenVRF router) RandomnessConsumer(router) {}

    function request() external payable returns (uint256) {
        return randomnessRouter.requestRandomness{value: msg.value}(100_000);
    }

    function _fulfillRandomness(uint256 id, uint256 word) internal override {
        results[id] = word;
        received[id] = true;
    }
}
```

Deploy the consumer with the router address, then call `request()`. Read the request ID from
`RandomnessRequested`. After fulfillment, `received(id)` is `true` and `results(id)` contains the
word. Check the boolean rather than treating zero as “not received.”

The `100_000` argument is callback gas, not payment or the number of words. The router permits
25,000–1,000,000 callback gas; proof verification and router bookkeeping require additional gas.

> [!IMPORTANT]
> This example exposes a public request function for demonstration. A real application must control
> admission, bind each request ID to an already-locked action, prevent outcome-dependent cancellation
> or redraws, and keep callback work bounded. `RandomnessConsumer` uses a constructor; proxy-based
> consumers need compatible initializer storage and authenticated callback handling.

## How it works

```mermaid
flowchart LR
    C[Consumer contract] -->|Request + callback gas| R[Randomness router]
    R -->|Commit ID, consumer, round| Q[(Request state)]
    Q -->|Read pending requests| L[Self-hosted relayer]
    D[Drand evmnet] -->|Signed public round| L
    L -->|Reserve gas budget| S[(Persistent ledger)]
    L -->|Submit signature| R
    R -->|Verify BLS + derive word| Q
    R -->|Authenticated callback| C
```

1. **Commit.** Store the caller, callback gas, request ID, and drand round scheduled 2–4 seconds after the request
   block timestamp.
2. **Observe.** Find pending requests and wait for their public beacon rounds.
3. **Validate.** Check endpoint responses before authorizing gas; invalid responses fall through to
   another endpoint.
4. **Verify.** Verify the pinned evmnet BLS key and exact requested round on-chain.
5. **Derive.** Bind the beacon randomness to the chain, router, request, and consumer.
6. **Deliver.** Attempt the authenticated callback; failures may only retry the stored result.

```text
beaconRandomness = SHA256(signature)

randomWord = uint256(keccak256(abi.encode(
  evmnetChainHash, beaconRandomness, chainId,
  routerAddress, requestId, consumerAddress
)))
```

These domains make results distinct across requests, consumers, routers, and chains. They do not
make a published beacon secret: after the round is available, every derived result is public.

## Verify a result yourself

Verify the public offline fixture after installing dependencies:

```sh
npm run verify:example
```

```text
beaconSignature: VALID
derivedRandomWord: MATCH
onChainFulfillment: NOT CHECKED (OFFLINE SYNTHETIC EXAMPLE)
requestTimingAssumption: REQUIRES FRESH CHAIN TIMESTAMP
consumerFairness: OUT OF SCOPE
```

The fixture uses a real drand round with synthetic request context. Check an actual fulfilled
request without a wallet or gas:

```sh
node scripts/verify-request.mjs \
  --rpc "$RPC_URL" --router "$ROUTER_ADDRESS" \
  --request-id 1 --from-block "$DEPLOYMENT_BLOCK"
```

A successful live check reports:

```text
beaconSignature:    VALID
derivedRandomWord:  MATCH
onChainFulfillment: MATCH
callbackDelivery:   ROUTER REPORTS DELIVERED
```

The checker reads one fixed chain snapshot, finds the request and fulfillment events, extracts the
drand signature from the fulfillment receipt, verifies that signature locally against the pinned
evmnet public key, reproduces the request-specific word, and compares it with contract storage and
the fulfillment event. It sends no transaction and requires no private key. For stronger evidence,
repeat the command with independent RPC providers and verify the deployed router bytecode.

```mermaid
flowchart TD
    B[Drand signature] --> V[Independent JavaScript verification]
    K[Pinned evmnet key] --> V
    V --> H[SHA-256 beacon randomness]
    H --> D[Recompute request-specific word]
    C[Chain + router + request + consumer] --> D
    D --> M[Compare state + events + receipt]
    M --> P[Oracle result is publicly reproducible]
    T[Fresh chain timestamp keeps selected round unpublished] -. Oracle assumption .-> P
    P --> A[Consumer receives the verified word]
    A -. Separate audit boundary .-> G[Game or application fairness]
```

The router controls the solid path: it permanently binds a request to one round and one consumer,
accepts only the valid proof, derives one reproducible word, and never redraws it. Its remaining
timing assumption is that the chain timestamp is fresh enough that the selected future round is still
unpublished when the request executes. What a consumer does with the word—including eligibility,
odds, cancellation, and payouts—is outside this oracle's control and must be assessed separately.
RPC records also depend on the selected chain view and verified deployed bytecode.

Read [fairness and independent verification](docs/fairness.md) for the full evidence model.

## Run your own relayer

Automatic callbacks require a funded gas wallet, chain RPC, and running relayer.

1. Deploy the router and consumer, then authorize both consumer and relayer on-chain.
2. Copy [.env.example](.env.example) to `.env` and set the HTTP RPC, WebSocket RPC, chain ID,
   router, and sponsored consumer.
3. Put a dedicated, minimally funded relayer key in `secrets/relayer-key`. Never reuse an admin or
   treasury key.
4. Start and monitor the container:

```sh
docker compose up -d --build
docker compose logs -f relayer
```

Stop it with `docker compose down`. Do not add `-v`; the volume preserves the spending ledger.
The bundled Compose service runs one signing wallet. For multiple wallets, define one relayer
service/container per key, point every service at the same PostgreSQL database, and give each the
same `RELAYER_ADDRESSES`, `RELAYER_SET_VERSION`, router, and consumer. The executable two-wallet
topology in [scripts/e2e.mjs](scripts/e2e.mjs) is the reference.

To run without Docker, install Node.js 22 or newer. The `.mjs` files are ordinary JavaScript;
that extension selects ES-module syntax and does not replace the Node runtime:

```sh
npm ci --ignore-scripts
set -a
source .env
set +a
docker compose up -d postgres
export RELAYER_KEY_FILE=./secrets/relayer-key
export DATABASE_URL=postgresql://openvrf:$POSTGRES_PASSWORD@127.0.0.1:${POSTGRES_PORT:-5432}/openvrf
node relayer/main.mjs
```

The process stops with an error if the configured consumer or relayer wallet is not authorized on
the deployed router. For multiple wallets, set `RELAYER_ADDRESSES` to the same ordered
comma-separated list on every instance. Request IDs are assigned round-robin (`1` to the first
address, `2` to the second, and so on); only the assigned wallet submits the initial proof or
retries that request when every operator follows the bundled relayer protocol. Assignment is not
enforced by the router: any on-chain-authorized relayer can call `fulfill` or `retryCallback`
directly. Every listed address must be authorized on-chain. Changing the order while requests are
unfinished can move assignments, so treat the list as immutable deployment configuration.
`RELAYER_FAILOVER_SECONDS` rotates an unfinished request to the next wallet after each timeout.
Before signing, the selected wallet takes a shared PostgreSQL request lease; a live holder renews it
while its transaction is unresolved, preventing boundary races. Persisted versioned configuration
includes the ordered list, failover interval, lease interval, and assignment algorithm. Activating a
newer version makes older processes stop on their next work-loop check. For membership changes,
stop every instance, increment `RELAYER_SET_VERSION`, update the identical ordered list, and restart.
If a primary dies after taking a request lease, its successor waits for `RELAYER_LEASE_SECONDS`
rather than racing a possibly broadcast transaction.

| Safety control | Default |
|---|---:|
| Live discovery | WebSocket block and request subscriptions |
| Backfill reconciliation | Every 30 seconds |
| Reconciliation head source | Independent HTTP latest-block read |
| Startup historical event page | 100,000 blocks |
| Recurring historical event page | 2,000 blocks |
| Startup Multicall3 batch | 500 request-state reads |
| Reconciliation lookback | 1,000 blocks every 30 seconds |
| Reconciliation head lag | Skip the newest 5 blocks; live listener owns them |
| Paid attempts per request | 3 |
| Retry backoff | 30 seconds, doubling to 1 hour |
| Maximum authorized cost per request | 0.001 ETH |
| Maximum unreimbursed operating spend | 0.01 ETH |
| Gas-price ceiling | 2 gwei |
| Receipt wait | 60 seconds, configurable; timeout enters pending reconciliation |
| Receipt confirmations | 2 |
| Automatic rebroadcasts / fee replacements | 5, with exponential backoff from 30 seconds |
| Cross-wallet request lease | 120 seconds |

Reservations count maximum authorized gas, not actual receipt fees, and unused gas is not returned
to the ledger budget. An uncertain transaction blocks new spending but does not stop the service:
reconciliation checks receipts (including earlier replacement hashes) and mempool presence, then
rebroadcasts while its nonce remains unused. An underpriced transaction absent from the mempool
may receive a same-nonce fee replacement within the gas-price and spending caps; its action stays
fixed and additional gas cost is reserved durably before broadcast. New submissions use the
greater of the RPC quote and base fee with 30% gas-price headroom. A confirmation-safe consumed nonce retires the impossible old
transaction so the request can retry. Reaching the rebroadcast limit enters persistent
`manual_intervention` without erasing recovery data or continuing to broadcast. Run one relayer
process per signing wallet. Alerts are logs only. See the
[operator runbook](docs/runbook.md) for key permissions, recovery, and safe start-ID changes.
All persisted operational timestamps use Unix epoch milliseconds: PostgreSQL columns are `BIGINT`,
and JSON state encodes the same integer values as decimal strings to avoid JavaScript precision loss.
EVM and drand timestamps remain Unix seconds as required by their protocols.

## Deploy to a testnet

Simulate a router deployment on Robinhood testnet (chain ID `46630`) using a locally provisioned
Foundry keystore account called `deployer`:

```sh
forge build
export OWNER_ADDRESS=0xYourMultisig
export RELAYER_ADDRESS=0xYourRelayer
export REQUEST_FEE_WEI=0
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --account deployer
```

Review the simulation, then add `--broadcast`. The script deploys only the router. Deploy the
consumer separately, then have the owner call `setConsumerAuthorization(consumer, true)`. The
initial relayer is authorized by the constructor, and the current owner is always an emergency
relayer. `REQUEST_FEE_WEI=0` makes approved consumers free; operators must fund relayer gas separately.
A nonzero value must be paid exactly with every request. The stored amount is transferred directly
to the relayer in the successful `fulfill` transaction, even when the consumer callback fails. A
later callback retry receives no fee. Successful paid fulfillments replenish the renewable operating
cap while lifetime authorized spending remains recorded. The testnet evidence's three-times-estimate
fee is a single functional test value, not a pricing recommendation. Production pricing must account
for callback gas, gas-price movement, unsuccessful attempts, RPC and service costs, and operating
margin.
`withdrawFees` remains an owner-only emergency recovery function, but it is capped at the balance
above the fees reserved for pending requests, so fulfillment backing cannot be withdrawn. Use a
multisig and never use it for routine relayer payment. This
repository provides no shared funded relayer or hosted endpoint.

## Evidence and limitations

| Layer | Current evidence |
|---|---|
| Router | 31 Solidity tests: real and invalid proofs, access control, direct proof-relayer payment, stored fees/emergency recovery, ownership, same-result retries, callback failure, reentrancy, domain separation, ordering, and 256 timing-fuzz runs |
| Relayer | Node tests: deterministic round-robin/failover assignment, renewable and lifetime accounting, stale-WebSocket recovery, event backfill/cursor recovery, optional Multicall3 startup pruning, listener head separation, state migration, high request IDs, endpoint fallback, persistence, retry/backoff, spending limits, and ambiguous receipts |
| Independent verifier | 3 Node tests: real signature, altered proofs, wrong rounds, and request-input tampering |
| Local integration | Two-wallet ten-request same-block split, distinct callbacks, direct fee payment, signer locking without premature version activation, stopped-primary takeover, active-version retirement, and PostgreSQL restart on disposable Anvil |
| Robinhood testnet | Previous second-future-round router runtime, genuine live drand proofs, zero-fee and paid requests, direct relayer payment, and authenticated callbacks through a bounded manual smoke runner |

### Output distribution check

10,000 actual local requests and callbacks (two consumers, reverse-order delivery) produce a
uniform-looking spread, not a bell curve. Ten roll bins: `[982,1021,993,1038,984,982,982,1042,1008,968]`;
roll chi-square 6.014 and raw-word chi-square 13.682 against the predeclared 5% threshold of
16.919 (9 df); roll serial correlation -0.0154.

![Distribution of 10,000 locally delivered random words](examples/distribution-local-10000.png)

This fixed beacon round tests request-specific derivation and concurrent callback isolation; it
does not certify cryptographic security. Full samples, methodology, and holdout datasets:
[distribution diagnostics](docs/distribution-check.md).

The [Robinhood Chain testnet evidence](docs/robinhood-testnet-evidence.md) links the deployment,
request, fulfillment, fee-setting, payment, and callback transactions for the previous second-future-round paid smoke
test. It also preserves a clearly separated historical first-future-round run.

What this evidence does **not** establish:

- Each request permanently selects a future drand round, 2–4 seconds after the request
  block timestamp. This is not a callback deadline. Unpredictability assumes the chain timestamp is
  sufficiently fresh that the round is not already public.
- The previous second-future-round paid test took approximately 10–11 seconds from request receipt to fulfillment receipt.
  This is one observation, not a latency guarantee. The selected beacon lead time is
  not the callback duration; drand publication, RPC availability, relayer processing, gas limits,
  and transaction inclusion add delay.
- The router and Solidity BLS verifier have extensive automated tests but no independent production
  audit or specialist cryptographic review.
- Delivery requires an authorized relayer to submit and fund the fulfillment transaction. Relayer
  availability, RPC failures, drand endpoints, spending caps, or consumer callback failures may
  delay delivery. Request fees reimburse successful proof submission but do not provide gas up front.
- The router consumer allowlist controls which contracts can request sponsored randomness. Each
  authorized consumer remains responsible for controlling which users can invoke its game functions.
- Event discovery uses a persistent cursor, bounded backfill, and Multicall3 startup pruning.
  PostgreSQL stores recovery and accounting state. A chain-and-signer lock prevents one wallet from
  writing nonces through multiple router/consumer services. Versioned shared configuration makes
  distinct wallets divide requests deterministically and rotate unfinished work after a timeout.
  High-throughput hosted operation still needs load testing.
- Verifying the oracle output does not prove that a game implemented its participants, odds,
  payouts, cancellation, or accounting correctly.

See the [timing model](docs/timing-model.md) and [security status](docs/security-status.md).

## Beacon provenance

OpenVRF consumes drand's existing **evmnet** beacon. It does not operate the League of Entropy
network or claim affiliation with drand, Gelato, Chainlink, or ORAO.

| Parameter | Pinned value |
|---|---|
| Beacon chain hash | `04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3` |
| Genesis timestamp | `1727521075` |
| Period | 3 seconds |
| Scheme | `bls-bn254-unchained-on-g1` |
| Verifier dependency | `randa-mu/bls-solidity` at `11af179a8287d978659aae07adb66aa60f64b8a6` |
| Access control dependency | OpenZeppelin Contracts `v5.7.0` |

References: [drand HTTP API documentation](https://docs.drand.love/developer/http-api/),
[evmnet metadata](https://api.drand.sh/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3/info),
[round 1000](https://api.drand.sh/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3/public/1000),
and [pinned verifier source](https://github.com/randa-mu/bls-solidity/tree/11af179a8287d978659aae07adb66aa60f64b8a6).

## Documentation

- [Fairness and independent verification](docs/fairness.md) — what the checker proves and does not prove
- [Architecture](docs/architecture.md) — components, trust boundaries, sequence, and state diagrams
- [Operator runbook](docs/runbook.md) — deployment, signer setup, limits, and recovery
- [Robinhood mainnet deployment](docs/mainnet-deployment.md) — includes a contract-only `npm run deploy:mainnet -- --broadcast` shortcut using `.env`
- [Security status](docs/security-status.md) — completed checks and remaining assurance gaps
- [Distribution diagnostics](docs/distribution-check.md) — reproducible uniformity checks over local and historical samples
- [Timing model](docs/timing-model.md) — commitment timing and provider-design comparisons
- [Robinhood testnet evidence](docs/robinhood-testnet-evidence.md) — public deployment, request, proof, and callback transactions
- [Executable Docker example](scripts/e2e.mjs) — real proof, callback, direct fee payment, and renewable-ledger workflow

## Project status and license

This is pre-release software. Reproducible reports should include the chain, source revision,
request ID, and public transaction hash. Never publish private keys, credential-bearing RPC URLs,
or sensitive vulnerability details in an issue.

OpenVRF is licensed under the [Apache License 2.0](LICENSE). Pinned dependencies and submodules
retain their respective upstream licenses, including the verifier's
[MIT license](lib/bls-solidity/LICENSE). Please read [CONTRIBUTING.md](CONTRIBUTING.md) before
submitting changes and report vulnerabilities through [SECURITY.md](SECURITY.md).
