# Reproducible distribution diagnostics

## 10,000 local requests — 2026-09-17

`node scripts/distribution-local.mjs examples/distribution-local-10000.json 10000`
completed 10,000 actual local requests and callbacks. All were pending before
reverse delivery across two consumers; BLS proof, derivation, consumer isolation,
request IDs and nonce uniqueness checks passed. The earlier abandoned attempt
stalled during receipt waiting before any result analysis. Bounded receipt
polling fixed that transport issue; no outcomes were discarded to improve statistics.

Analysis uses `(randomWord % 1000000) + 1`, not an oracle odds denominator.
Ten roll bins: `[982,1021,993,1038,984,982,982,1042,1008,968]`.
Roll chi-square 6.014, raw-word chi-square 13.682 (9 df, 5% diagnostic threshold
16.919); roll serial correlation -0.0153759. These samples look consistent with
uniform distribution, not bell-shaped. They do not certify cryptographic security.
This fixed genuine beacon round tests request-specific derivation and concurrent
callback isolation, not 10,000 independent beacon rounds or public-chain draws.

Full samples: `examples/distribution-local-10000.json`. Plot: matching `.svg` and
`.png`; regenerate SVG with `scripts/distribution-graph.mjs`.

## Earlier 1,000-sample checks (retained evidence)

Run from the repository root after `forge build`:

```sh
node scripts/distribution-local.mjs examples/distribution-local-1000.json
node scripts/distribution-historical.mjs examples/distribution-historical-1000.json
START_ROUND=2000 node scripts/distribution-historical.mjs examples/distribution-historical-holdout-1000.json
```

The local script creates disposable Anvil contracts, sends 1,000 actual requests alternating
between two consumers, verifies every request is pending before any callback, then fulfills in
reverse order using a genuine public drand round-1000 proof. Every callback must match its
consumer's storage and independently reproduced request-specific ABI derivation; the other
consumer must not receive it. Request IDs, transaction nonces and resulting words must be unique.
The Anvil process is shut down afterward. No public-chain transaction or persistent key is used.

This fixed beacon round tests callback isolation and domain-separated outputs, not 1,000
independent beacon observations. The separate read-only historical script retrieves rounds
1000–1999 with four concurrent requests and verifies every BLS signature locally before deriving
words using explicitly synthetic contract context. Those are not 1,000 deployed callbacks.

Both retain all 1,000 samples with input proof/context in JSON. Ten equal-width bins are used
for normalized unsigned 256-bit values and one-based modulo-1,000,000 rolls. Uniformity—not a
bell curve—is the target. Pearson chi-square has 9 degrees of freedom; the predeclared 5%
critical value is 16.919. Mean and lag-one serial correlation are descriptive only. There are
two separate tests per dataset, without a claim of family-wise correction. Finite diagnostics
cannot establish cryptographic unpredictability, independence, fairness or security.

The historical dataset is replayable offline from its preserved signatures and context. The
local dataset is reproducible using the publicly known deterministic Anvil account, identical
deployment ordering, fixed block timestamps and the pinned compiled contract artifacts.

Historical run (1,000 samples, rounds 1000–1999): unsigned-word bins were
`114, 100, 91, 98, 99, 84, 108, 109, 100, 97` (chi-square 6.92). Modulo-roll bins were
`112, 92, 99, 90, 95, 101, 121, 98, 100, 92` (chi-square 8.44). Neither test rejected
uniformity at the stated 5% threshold. This does not establish randomness security.

Exploratory inspection of the underlying beacon values (not request-derived words) produced
bins `112, 79, 94, 91, 93, 86, 113, 115, 111, 106`, chi-square 14.98, mean 0.51788977637
and lag-one correlation 0.07950730509. The lag is elevated—approximately 2.5 standard errors
under a rough IID approximation—and must not be hidden or interpreted as independence passing.
The request-derived words had lag-one correlation 0.01071912420. These additional statistics
are exploratory/descriptive, not a predeclared independent-security test; no rerun or cherry-pick
was performed to obtain a passing result.

Local actual-contract run: all 1,000 requests were verified pending before any callback, then
all were delivered to the correct consumer in reverse order. All 2,000 request/callback
transaction nonces and all 1,000 output words were distinct. Raw-word bins were
`95, 95, 106, 82, 108, 105, 95, 108, 113, 93` (chi-square 8.06, mean 0.50750835506,
lag-one 0.01309451511). Roll bins were `106, 102, 103, 107, 97, 90, 95, 98, 90, 112`
(chi-square 4.80, mean 0.49363423500, lag-one -0.01963010867).

One bounded follow-up holdout of exactly 1,000 distinct rounds 2000–2999 was declared after
the elevated exploratory beacon lag was observed. It is a separate dataset, not a replacement
for the original result, and is not repeatedly sampled until a desired result appears.

Holdout beacon bins: `100, 98, 100, 99, 105, 106, 105, 86, 103, 98`; chi-square 3.00,
mean 0.49748331258, lag-one correlation 0.00515149047. Request-derived words had
chi-square 10.00 and lag-one -0.00493820201; modulo rolls had chi-square 3.76 and
lag-one 0.00558876136. This independent holdout did not reproduce the first dataset's elevated
beacon lag. The original elevated observation remains reported; neither result is proof of
independence or cryptographic security.
