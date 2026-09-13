# Security policy

OpenVRF is beta software and has not received an independent production audit. Do not treat the
repository, example consumer, or bundled relayer as approval to secure real funds.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature from the repository's **Security** tab.
Do not disclose an unpatched vulnerability in a public issue, pull request, discussion, or chat.

If private vulnerability reporting is unavailable, contact a verified project maintainer through
the organization channel before sharing technical details. Include the affected revision, impact,
reproduction steps, and a minimal proof of concept. Never include private keys or funded-wallet
credentials.

Maintainers should acknowledge a report within seven days. Investigation and remediation timelines
depend on severity and reproducibility. Public disclosure should be coordinated after a fix or
mitigation is available.

## Scope

Reports concerning the OpenVRF contracts, verifier integration, callback boundary, relayer,
independent verification scripts, and container configuration are in scope. Vulnerabilities in
third-party dependencies should also be reported to their maintainers when appropriate.

The documented chain timestamp model, asynchronous callback latency, and consumer-controlled game
logic are known trust boundaries, not vulnerabilities by themselves. A concrete way to violate the
documented guarantees remains in scope.
