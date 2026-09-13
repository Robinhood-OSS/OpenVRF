# Robinhood Chain testnet evidence

## Current direct-payment revision — 2026-09-13

The exact current router runtime was deployed with a zero initial fee, then exercised with a
zero-fee calibration request. The calibration's live `eth_estimateGas` result was multiplied by the
observed gas price and by three to set the paid request fee:

| Measurement | Value |
|---|---:|
| Estimated fulfillment gas | 465,881 |
| Observed gas price | 10,000,000 wei |
| Pricing multiplier | 3x |
| Exact request fee | 13,976,430,000,000 wei (`0.00001397643 ETH`) |
| Actual paid-fulfillment gas used | 336,317 |
| Actual paid-fulfillment gas cost | 3,363,170,000,000 wei (`0.00000336317 ETH`) |
| Relayer gross payment | 13,976,430,000,000 wei |

The paid fulfillment emitted `RelayerFeePaid` for the fulfilling wallet and exact stored fee,
cleared the request's fee to zero, stored the verified random word, and completed the authenticated
consumer callback. Both selected beacon rounds were 4–6 seconds after their request blocks.

| Component | Address |
|---|---|
| Current router | [`0x29FF07D37ad8920f52f09A91A19979fBb841f6eb`](https://explorer.testnet.chain.robinhood.com/address/0x29FF07D37ad8920f52f09A91A19979fBb841f6eb) |
| Example consumer | [`0xedDb97471443279aaB5E7D2a7468F2274D3f57cf`](https://explorer.testnet.chain.robinhood.com/address/0xedDb97471443279aaB5E7D2a7468F2274D3f57cf) |

| Step | Block | Gas used | Transaction |
|---|---:|---:|---|
| Deploy current router | 118,774,144 | 3,004,013 | [`0x35f22a…6c0f3`](https://explorer.testnet.chain.robinhood.com/tx/0x35f22acdbfb629fbc13482d20ef5ef77ec27b94eef42c1f8aad57facf936c0f3) |
| Deploy example consumer | 118,774,211 | 246,509 | [`0x8330a4…05e25`](https://explorer.testnet.chain.robinhood.com/tx/0x8330a485d88e4db3540c8a94e823fea67d9fb2590d36620d7e4091ffae805e25) |
| Authorize consumer | 118,774,280 | 52,910 | [`0x9afec0…6c5a`](https://explorer.testnet.chain.robinhood.com/tx/0x9afec0db117ed5e188fedc8b4784abb08b54f7647885926ba846aae85e5f6c5a) |
| Zero-fee calibration request | 118,774,333 | 68,766 | [`0x7ce336…4443`](https://explorer.testnet.chain.robinhood.com/tx/0x7ce33670b18f063e89eb7a495b0a439232751cf7273caf028217b791a95e4443) |
| Calibration fulfillment/callback | 118,774,443 | 329,491 | [`0xe7a21b…13f9`](https://explorer.testnet.chain.robinhood.com/tx/0xe7a21bd6ddf0ad83d8c2741d4dd4b1ad38b4634092cb5aceb4b18e91966c13f9) |
| Set request fee | 118,774,518 | 51,311 | [`0xfd511a…ff5`](https://explorer.testnet.chain.robinhood.com/tx/0xfd511a1144807086595bdd03711cb2b68a33704436cf5222ebe19c89d5b44ff5) |
| Paid request | 118,774,573 | 95,564 | [`0xee7d79…fdce6`](https://explorer.testnet.chain.robinhood.com/tx/0xee7d797a63e86019404d0eb6b52360d3510c85ff6b601b66e120660c8abfdce6) |
| Paid fulfillment/callback | 118,774,638 | 336,317 | [`0x52a389…fd3a`](https://explorer.testnet.chain.robinhood.com/tx/0x52a389f70ca45f2bd3747797b165011430e40790257af1df974e9ca0c7c7fd3a) |

The test report finished with status `PASS`. This was a bounded manual smoke runner, not the
continuous PostgreSQL relayer service or a latency benchmark.

## Historical first-future-round revision — 2026-09-07

This public record preserves a successful historical OpenVRF smoke test on Robinhood Chain
testnet (chain ID `46630`) on 2026-09-07. It covers deployment, three requests, genuine drand
proof verification, and three successful consumer callbacks.

The deployed router used the earlier first-future-round policy (approximately 1–3 seconds) and
predates the current direct-payment request ABI. These transactions prove that the core
drand-to-proof-to-callback path worked on Robinhood Chain; they are not deployment evidence for
the exact current source revision and are not production addresses.

| Component | Address |
|---|---|
| Router | [`0x80EEbBfb55f0fc1E917A720FAb86aC644BeA46da`](https://explorer.testnet.chain.robinhood.com/address/0x80EEbBfb55f0fc1E917A720FAb86aC644BeA46da) |
| Demo consumer | [`0x2e9A801F026363971Ed3B87A29D07A0F00ba04FB`](https://explorer.testnet.chain.robinhood.com/address/0x2e9A801F026363971Ed3B87A29D07A0F00ba04FB) |

## Transaction sequence

| Step | Block | Gas used | Transaction |
|---|---:|---:|---|
| Deploy router | 114758941 | 2,524,554 | [`0xe5b905…412da`](https://explorer.testnet.chain.robinhood.com/tx/0xe5b905722d1505f21cab47b8b5c2f8aed306decabec70173360c6a6de13412da) |
| Deploy demo consumer | 114758994 | 246,419 | [`0x8d1cc9…2b60`](https://explorer.testnet.chain.robinhood.com/tx/0x8d1cc9179fda4e742e1489d0a9e6409595475f8e5c7b293d8e0f38ff95f62b60) |
| Request 1 | 114759060 | 63,435 | [`0xacdd4e…b99c`](https://explorer.testnet.chain.robinhood.com/tx/0xacdd4e226dc58d230126fb59747d5072683f2580a40f55f5dbc7445c5067b99c) |
| Request 2 | 114759138 | 63,435 | [`0xe31e81…7215`](https://explorer.testnet.chain.robinhood.com/tx/0xe31e81fd8bc1837f4f6b32f3f9849910b2d03d5c6c6cbd096c50177df8877215) |
| Request 3 | 114759207 | 63,435 | [`0x285a87…c3e`](https://explorer.testnet.chain.robinhood.com/tx/0x285a87949c980dd9d4fd695c4babc70feb9a6dfc10be4ca362efe2c380ff9c3e) |
| Fulfill and callback 1 | 114759285 | 328,112 | [`0xaa09c6…09ed1`](https://explorer.testnet.chain.robinhood.com/tx/0xaa09c6ae7b22f305b5ec414e5e369c3a77648f92aaf61a6e2f5a76d06c609ed1) |
| Fulfill and callback 2 | 114759370 | 323,035 | [`0x4e0366…12a3`](https://explorer.testnet.chain.robinhood.com/tx/0x4e036629d764df5bbcf3c8e42f7d0d2a3f695f8781ef212a8a23e2a246a312a3) |
| Fulfill and callback 3 | 114759457 | 328,112 | [`0xbf32d9…3f49`](https://explorer.testnet.chain.robinhood.com/tx/0xbf32d9f059e7b621dd1a089bdd7f5152eca7c03e087ca9386c6eb1e3fe5c3f49) |

## Callback results

| Request | Drand round | Random word | Delivered |
|---:|---:|---:|:---:|
| 1 | 20,417,448 | `69994339350445642261325161242752631898940100614716109027719640879439419852698` | Yes |
| 2 | 20,417,451 | `24712570914557102098038745301113892985033965249041824039205650221867633076926` | Yes |
| 3 | 20,417,453 | `7356526544770726034472896881200520785177366808668867497515726808790809047127` | Yes |

The eight receipts all have status `1`. Router and consumer state agreed for all three results.
Use the repository's independent verifier for current deployments rather than trusting this
historical record alone.
