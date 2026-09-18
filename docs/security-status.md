# Security and test status

**Not approved for real funds.** Functional tests are evidence of behavior, not proof that no
vulnerability exists. This project and its verifier dependency have not received an independent
specialist cryptographic audit.

## Reproducible evidence and remaining gaps

| Area | Evidence in this repository | Still required |
|---|---|---|
| Callback | Two-wallet ten-request Docker burst, stopped-primary failover, plus historical Robinhood testnet delivery; sequential consumer/router results agree | Application-specific callback and settlement review |
| Router correctness | 31 Solidity tests, including access control, direct proof-relayer payment, stored fees/emergency recovery, 256 timing-fuzz cases and first-future-round boundaries | More complete state-machine and edge-condition coverage |
| Verifier interoperability | Genuine public evmnet signature fixtures verified offline | Broad independent reference/differential vectors and specialist review |
| Relayer | Node tests cover deterministic assignment/failover, renewable accounting, stale-WebSocket recovery, event cursor/queue, state migration, caps/backoff, validated fallback and durable transaction reconciliation | Operational monitoring, request admission control and multi-wallet soak testing |
| Timing | First-future-round arithmetic tests; prior second-future-round Robinhood Chain testnet delivery | Operate under the documented sequencer ordering/timestamp trust model; monitor timestamp freshness |

Run `forge test`, `npm test`, and the Docker end-to-end workflow in the [runbook](runbook.md).
The [fairness checker](fairness.md) adds three offline Node tests for independent JavaScript
signature verification and request-word derivation. `npm run test:verify:e2e` checks a real
local request/receipt/callback and rejects pending, missing, or incomplete-range evidence.
These checks do not independently prove the chain's timestamp or ordering; those are deployment trust assumptions.
Local historical fixtures do not benchmark live callback latency or establish deployment safety.
No operator-specific addresses, funding-wallet records, or receipts are distributed as test fixtures.

## Timing trust model

The current source selects the first future beacon round after `block.timestamp`, scheduled
1–3 seconds later. This narrower margin requires the request to be committed before the
selected beacon becomes public; it is not a finality guarantee. The prior second-future-round
direct-payment runtime (4–6 seconds of scheduled lead time) was deployed
and exercised on Robinhood Chain testnet with genuine drand fulfillment, callback delivery, and a
nonzero request fee paid directly to the fulfilling relayer on 2026-09-13. A separate historical
revision exercised restart recovery on testnet, while the continuous relayer's restart,
multi-wallet, failover, and burst behavior is covered by the local Docker integration suite.
No production deployment is recorded in this repository. Deployment accepts
Robinhood Chain's sequencer ordering and block timestamp
as the commitment clock. This is the same fundamental trust placed in the chain for contract state;
it is an explicit fast-mode trust assumption rather than an unresolved router mechanism.

A receipt observed after scheduled beacon publication does not by itself establish whether the
beacon was already knowable at transaction inclusion. Similarly, a recent-looking latest block
does not prove a worst-case timestamp bound. RPC delay and timestamp granularity affect observations.

[Robinhood documents](https://docs.robinhood.com/chain/transaction-finality/) soft confirmation,
Ethereum batch posting, and subsequent Ethereum finality. Before posting, ordering relies on
the sequencer. Generic [Arbitrum timestamp bounds](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/block-numbers-and-time)
must not be substituted for verified target-chain configuration.

Operators should monitor abnormal timestamp lag. Waiting longer in the relayer cannot make a
published round unpredictable again. Applications requiring Ethereum-finalized commitments need a
different, slower round policy; that is not the mode implemented here.

## Relayer controls implemented; operational limits remain

The continuous service now validates candidates through a read-only on-chain verifier call,
falling back on rejection. Paid attempts and exponential backoff persist across restarts.
The per-request cap is hard; the total cap limits unreimbursed operating spend. Maximum authorized
gas cost is reserved durably before broadcast. Unused gas is not refunded, while successful paid
fulfillments replenish operating allowance without erasing gross lifetime authorization. An unresolved submission blocks new spending while the
service checks receipts and mempool state. Identical rebroadcasts use persisted exponential backoff
and stop at a configured limit. A confirmation-safe consumed nonce retires the impossible old
transaction; ambiguous recovery enters manual intervention without erasing evidence. Caps do not authorize changing a target
round or discarding an unfavorable result.

PostgreSQL state remains scoped to chain, signer, router, and consumer, while its session-level
advisory lock is scoped to chain and signer. This prevents one wallet from writing concurrent nonces
through separate services. Distinct authorized wallets use a shared versioned list; unfinished work
rotates to a successor after a timeout, while a renewable shared request lease protects in-flight
transactions. The durable policy includes algorithm, list, failover interval, lease interval, and
one active version. All instances must use that policy.
Log alerts require external monitoring;
there is no paging integration. Event backfill uses bounded ranges and persists its cursor. After
optional Multicall3 startup pruning, individual reads are limited to unresolved queued IDs. Completed request accounting is
compacted into an aggregate. This removes the known O(total request IDs) polling path, but sustained
high-throughput operation still requires load and soak testing.

Only authorized relayers can fulfill or retry, preventing unauthorized public races against the
operator's pending fulfillment. The bundled service schedules one intended wallet per timeout
window, but assignment is not enforced on-chain. A slow transaction may overlap the next window,
and any authorized wallet can bypass the software; the first valid proof transaction is paid. The current owner remains
an emergency relayer. Only authorized consumers
can create requests; removing one blocks new requests without invalidating existing commitments.
An authorized consumer can still expose unrestricted user requests. Caps bound this relayer's
authorized spending but do not prevent exhaustion of the allowed budget or guarantee delivery.
Legitimate game actions must gate sponsorship before unattended production use. Read-only proof
validation depends on RPC honesty/availability; mandatory on-chain validation is unchanged.
Receipt confirmation depth defaults to two and is configurable; it is operational bookkeeping, not
an established finality policy.

The first valid proof submission pays the request's stored fee directly to that authorized relayer,
even if its callback fails. A later retry receives no fee. Fees of pending requests are reserved: the
owner's emergency withdrawal is capped at the balance above `reservedFees` and shares the delivery
reentrancy lock, so it cannot make a pending fulfillment fail. This recovery authority exists for
tokens forced into the router, not as a routine payment path.
Paid fulfillment also requires the authorized sender to accept native tokens. The bundled relayer is
an EOA; contract-wallet relayers must test their receive behavior before authorization.

The owner can change admission and future request fees, but cannot change an existing request's
round, consumer, proof, result, or stored fee accounting. Compromise of the owner or all authorized relayers
can censor delivery, but owner compromise cannot withdraw fees reserved for pending requests. Standard
OpenZeppelin ownership is used without a two-step handover; operators must verify transfer recipients
and should use a multisig.

## Verifier assurance

The BLS verifier is the Solidity cryptographic gate that answers: “was this exact randomness signed
by drand for this exact round?” Its dependency is pinned at `11af179a8287d978659aae07adb66aa60f64b8a6`; its README explicitly labels
it experimental/unaudited. The parent test command does not run its full upstream suite.
Positive reference fixtures come from drand's public API and are checked offline by Solidity;
they are interoperability checks, not a second independent cryptographic implementation.

“Differential vectors” means giving known valid and deliberately broken signatures to both this
verifier and a separate trusted implementation, then requiring identical accept/reject results.
“Specialist review” means a cryptography-and-EVM expert manually checks curve arithmetic, the
pairing call, byte encoding and round binding. Ordinary application tests cannot prove that math.

Review checked fixed key/DST and round binding, exact signature length, pairing success requirements,
and generated inverse/square-root exponents. Remaining work includes full reference-based arithmetic
and serialization coverage, target-chain precompile conformance, and specialist review.

Two existing test names overstate coverage: the same-request reentrancy case is rejected before
the cross-request delivery lock; the large-return case checks preserved fulfillment but not a
successful large-data return. These gaps remain open and are not represented as newly fixed.

## Consumer integration requirements

The example consumer is a demonstration, not an audited game. Each application must establish
authenticated callbacks, fixed request-to-action mapping, locked participants/inputs, same-result
recovery, correct settlement and accounting, and explicit emergency rules. Proxy integrations
need initializer-based router storage and a separate storage-layout review.

A valid randomness proof cannot establish fairness if an application allows outcome-dependent
cancellation, replacement draws, or changes to eligible inputs after the result becomes knowable.

## Reproducibility

Solc 0.8.28, optimizer 200, Paris EVM, the verifier gitlink, and the multi-architecture Node and
PostgreSQL image digests are pinned. Foundry itself is not yet pinned. Before release, record an immutable source commit,
tool versions, image digest, deployment parameters, runtime hashes and complete test evidence.
