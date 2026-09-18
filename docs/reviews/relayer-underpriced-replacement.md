# Underpriced transaction recovery review — 2026-09-18

## Change reviewed

Commit `2e50f80` allows an RPC-visible, underpriced transaction to enter the existing
bounded fee-replacement path. Previously, any transaction returned by
`eth_getTransactionByHash` caused reconciliation to wait, regardless of its price.

The replacement retains the nonce, destination, calldata, value, gas limit and
chain ID. Only the gas price increases. The additional maximum cost is persisted
before broadcast, earlier hashes remain tracked, and the existing request, total
and gas-price caps, lease checks, backoff and rebroadcast limit still apply.
An RPC-visible transaction priced adequately continues to wait.

## Independent review and validation

Kimi reviewed the committed source and tests in an isolated snapshot and found no
blocking correctness issues in this change. Its recommendation was to keep the
small fix and omit automatic cancellation for this underpricing case.

The primary agent ran **77 Node tests, all passing**. Relevant coverage includes:

- RPC-visible and missing underpriced transactions use the same replacement path.
- Signed transaction fields remain unchanged except for the gas price.
- Increased reservations are persisted before an ambiguous broadcast failure.
- An earlier hash can still resolve the pending transaction after restart.
- Request, total and gas-price caps prevent replacement without changing reservations.
- An adequately priced visible transaction waits without modifying state.
- Visible underpriced transactions respect lease ownership, backoff and attempt limits.

Kimi's review was static; it did not independently run those tests. Neither the
tests nor the review demonstrated same-nonce replacement acceptance by Robinhood
mainnet or the configured provider. This is a review of a bounded recovery attempt,
not a guarantee of inclusion or a complete nonce-gap recovery system.

One non-blocking cost is that visible transactions now require a gas quote before
the lease/backoff checks: two additional RPC calls per reconciliation pass. Quote
failures use the existing RPC-error/restart handling, including startup failures.

## Robinhood research

Robinhood documents FCFS sequencer ordering. Increasing fees does not move a
transaction ahead of others. Its soft-confirmation stage means the sequencer has
accepted, ordered and executed a transaction and returned a receipt, typically
sub-second. A provider returning a hash or transaction object is not that receipt.
See [Differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/)
and [Transaction finality](https://docs.robinhood.com/chain/transaction-finality/).

Upstream Nitro's prechecker rejects fees below the applicable base fee and
insufficient balance. The sequencing implementation uses bounded queues and checks
nonce equality. These are implementation evidence from upstream Nitro, not verified
Robinhood deployment settings. See
[transaction prechecker](https://github.com/OffchainLabs/nitro/blob/master/execution/gethexec/tx_pre_checker.go)
and [sequencer](https://github.com/OffchainLabs/nitro/blob/master/execution/gethexec/sequencer.go).

The rationale for our fee increase is **eligibility, not ordering priority**.
No Robinhood-specific EOA replacement/cancellation acceptance guarantee was found
in the documentation inspected. General Alchemy Wallet API retry documentation
concerns wallet calls/user operations and does not prove ordinary EOA transaction
replacement behavior on Robinhood.

## Why cancellation is omitted

A cancellation also needs an accepted same-nonce submission and an adequate fee.
There is no demonstrated need for it to address the reproduced underpricing gap.
It changes the action and requires additional winner/fee accounting: a successful
cancellation earns no fulfillment fee, whereas the current pending ledger assumes
fee-only replacements preserve the action and reimbursement.

Cancellation may remain an operator fallback for a distinct incident, but adding
automatic cancellation now is not justified by this review. Provider-specific
acceptance differences remain untested; do not assume cancellation and fulfillment
replacement necessarily have identical acceptance outcomes.

Insufficient funds, exhausted budgets, nonce gaps and unavailable RPCs remain real
blockers. Separate pre-existing handling of a request completed by another relayer
does not establish that the original wallet's pending nonce was consumed; this
review does not claim that all queue-stall cases are solved.

This review did not deploy a container or send mainnet transactions.
