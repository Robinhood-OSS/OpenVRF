# Contributing to OpenVRF

Contributions that improve correctness, reproducibility, interoperability, documentation, and
operational safety are welcome.

## Development setup

```sh
git submodule update --init
npm ci --ignore-scripts
forge test
npm test
npm run test:verify:e2e
```

The Docker end-to-end test additionally requires a running Docker daemon:

```sh
docker build -t openvrf:local .
npm run test:e2e
```

## Pull requests

- Keep changes focused and explain the security or operational assumptions they introduce.
- Add regression tests for behavioral changes.
- Run the relevant Solidity, Node.js, verifier, and container tests.
- Update public documentation when configuration or guarantees change.
- Do not commit generated build output, deployment records, private operational notes, credentials,
  wallet files, or credential-bearing RPC URLs.
- Preserve third-party licenses and pinned dependency provenance.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not the public issue tracker.

Unless explicitly stated otherwise, contributions intentionally submitted for inclusion are
licensed under the repository's [Apache License 2.0](LICENSE).
