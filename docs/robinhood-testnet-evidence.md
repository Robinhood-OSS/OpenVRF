# Robinhood Chain testnet evidence

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
