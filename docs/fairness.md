# What can you verify?

OpenVRF is a drand-backed callback oracle. A valid beacon signature proves the
randomness belongs to the pinned evmnet round. The router additionally fixes one round and
one consumer for each request and never redraws the result. Consumer contracts decide how
to use that result and are outside the oracle's control.

## Run the independent checker

```sh
npm ci --ignore-scripts
npm run verify:example
```

This works offline after dependencies are installed. The [fixture](../examples/evmnet-round-1000.json)
uses real public round 1000 but **synthetic** chain/request/address inputs. It is not a
testnet receipt or evidence of an actual game. Its expected word was also computed using
Foundry's `cast abi-encode` and `cast keccak`, separately from the JavaScript derivation.

Expected status fields (the output also includes the recomputed random word):

```text
beaconSignature:       VALID
derivedRandomWord:     MATCH
onChainFulfillment:    NOT CHECKED (OFFLINE SYNTHETIC EXAMPLE)
requestTimingAssumption: REQUIRES FRESH CHAIN TIMESTAMP
consumerFairness:        OUT OF SCOPE
```

For an actual fulfilled request, substitute your own public deployment details:

```sh
node scripts/verify-request.mjs \
  --rpc "$RPC_URL" --router "$ROUTER_ADDRESS" \
  --request-id 1 --from-block "$DEPLOYMENT_BLOCK"
```

No wallet or private key is required, and no transactions are sent. The checker reads a
fixed block snapshot, finds request/fulfillment events in pages of 2,000 blocks, extracts
the signature from the fulfillment receipt, verifies it locally, and compares the word
with both storage and the fulfillment event. Start at or before the request block;
omitting `--from-block` scans from genesis. Some RPCs require smaller log ranges or archive
access; incomplete/unavailable evidence fails rather than passing. A pending request also
exits unsuccessfully because there is no fulfillment to check.

The checker uses the [drand JavaScript client](https://github.com/drand/drand-client)
with a pinned evmnet public key and scheme. It does **not** call the router's `proveRound`
as its signature check. This provides implementation diversity, not a specialist audit
or a guarantee that either dependency is bug-free.

`onChainFulfillment: MATCH` means the RPC-provided records agree. It is **not** a consensus
or storage-inclusion proof: a dishonest RPC or an arbitrary contract imitating the interface
can fabricate records. Independently verify deployed source/bytecode and compare trusted
RPCs. The snapshot hash is rechecked to detect a visible reorganization, but this does not
establish finality. `ROUTER REPORTS DELIVERED` is a callback status, not a consumer audit.
Exit code 0 means the selected oracle consistency checks passed.

## Derivation anyone can reproduce

```text
beaconRandomness = SHA256(signature)
randomWord = uint256(keccak256(abi.encode(
  evmnetChainHash, beaconRandomness, chainId, router, requestId, consumer
)))
```

Use Solidity ABI encoding, not packed encoding. Types in order are `bytes32, bytes32,
uint256, address, uint256, address`. Hashing binds a result to its request context; it does
not make an already public beacon secret again.

## Oracle fairness and its boundary

| Requirement | What supports it | Remaining boundary |
|---|---|---|
| Authentic beacon | Independent BLS verification against pinned evmnet key | Threshold and cryptographic assumptions; verifier correctness |
| Unknown when requested | Router permanently selects a future round at least two seconds after block time | Requires a sufficiently fresh chain timestamp so that round is not already public |
| No selective redraw | Router stores one result; callback retries reuse it | A consumer can ignore the result, but cannot make the router produce another for that request |
| Eventual delivery | Authorized relayers plus same-result retry | Relayer availability, chain, gas funding and consumer availability; no delivery deadline |

Drand's unpredictability/bias-resistance depends on its threshold network and cryptographic
assumptions. Its public endpoints can withhold or delay data but cannot forge a valid
signature under those assumptions. See the [official security model](https://docs.drand.love/docs/security-model/)
and [cryptography](https://docs.drand.love/docs/cryptography/).

The oracle's crucial sequence is: **record one immutable request and future round → beacon becomes
knowable → verify and deliver that request's one reproducible result**. A block timestamp orders
those steps on-chain, but its relationship to real time relies on the chain's timestamp behavior.
Waiting longer to deliver an already known result cannot fix a round that was already public when
requested. A reverted callback does not create a new lottery ticket because retries preserve the
original word.

Consumer behavior is a separate boundary. The oracle cannot enforce a game's eligibility, odds,
commitments, cancellation rules, payouts, or accounting. A broken consumer does not let the
relayer bias the oracle result, but it can still make the overall application unfair.

Before a production oracle-fairness claim, document the chain's ordering and timestamp trust
model, establish a defensible round-selection policy, and obtain specialist verifier review.
Each integrating application remains responsible for auditing its own use of the result.
Statistical randomness tests and live callback smoke tests cannot substitute for these steps. See [timing](timing-model.md)
and [security status](security-status.md).

## Reproduce the checks

```sh
npm test
npm run test:verify:e2e
```

The first includes offline valid/invalid proof and derivation checks. The second requires
Foundry (`forge`, `anvil`) and verifies a real local request, receipt and callback, without
using public-chain funds. The tests validate oracle behavior; production timing follows the
documented chain-timestamp trust model rather than a guarantee derived from finite samples.
