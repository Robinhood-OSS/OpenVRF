# Robinhood mainnet deployment and router migration

This guide deploys the OpenVRF router with a two-second minimum beacon lead and a demonstration consumer,
then switches an existing Docker Compose relayer to the new router. It reuses the
existing deployer keystore, relayer wallet, GHCR image and PostgreSQL container.

The router selects a drand round scheduled **2–4 seconds after the request block
timestamp**. This is the beacon lead time, not a callback deadline. The shorter
margin still requires commitment before the selected beacon becomes public.
Functional tests do not establish production security; see [security status](security-status.md).

The deployed router is not upgradeable. This source change requires a **new router**.
`ExampleConsumer` also needs redeployment because its router address is immutable.
Production consumers require their own compatible deployment or configuration procedure.

Run each command block separately. Replace uppercase placeholder values before running
commands. Never enter a private key as a command argument or put credentials in Git.
Do not publish environment files, private keys or deployment broadcast records.

## Deployment flow

Deploy OpenVRF first with `pnpm run deploy:mainnet`. Then deploy only ExampleConsumer
against that existing router with `pnpm run deploy:mainnet:example`.
**The example script never deploys OpenVRF.** Ownership is retained throughout.
Neither script sends a randomness request or accesses the server.

## 1. Prepare on your Mac

Open the local repository root. Foundry, Node.js 22+, Python 3 and your existing
Foundry account `openvrf-mainnet-deployer` must be available.

```sh
cd /Users/lucas/Code/openvrf
git submodule update --init --recursive
pnpm install
forge build
forge test
pnpm test
rg 'MIN_DELAY =' src/OpenVRF.sol
```

Expected source setting:

```solidity
uint256 public constant MIN_DELAY = 2;
```

Keep `package-lock.json`: the Docker image still uses `npm ci`. Local pnpm use
does not require changing the image or package manager used in Docker.

## 2. Configure the local .env

Keep your existing `.env`. If starting fresh, copy `.env.example` first and fill
the required fields. Deployment fields are additional entries; they are not all
present in `.env.example`.

```sh
cp -p .env .env.before-router-change
chmod 600 .env .env.before-router-change
nano .env
```

Set or add the following entries without duplicates. Use your existing public
wallet addresses and record the old contracts before replacing them later.

```dotenv
RPC_URL=https://YOUR_PRODUCTION_MAINNET_HTTP_RPC
WS_URL=wss://YOUR_PRODUCTION_MAINNET_WEBSOCKET_RPC
CHAIN_ID=4663

DEPLOYER_ACCOUNT=openvrf-mainnet-deployer
DEPLOYER_ADDRESS=0xYOUR_DEPLOYER_WALLET_ADDRESS
OWNER_ADDRESS=0xYOUR_DEPLOYER_WALLET_ADDRESS
RELAYER_ADDRESS=0xYOUR_EXISTING_RELAYER_WALLET_ADDRESS
REQUEST_FEE_WEI=0

OLD_ROUTER_ADDRESS=0xYOUR_OLD_ROUTER_ADDRESS
OLD_CONSUMER_ADDRESS=0xYOUR_OLD_EXAMPLE_CONSUMER_ADDRESS
```

Set `OWNER_ADDRESS` to the same address as `DEPLOYER_ADDRESS`; the script needs
owner authority to whitelist the newly deployed consumer. The script loads `.env`
automatically with Node.js; no `export` is required for deployment.

Retain ownership if you need to add future PowerPot consumers. The owner may be
transferred to a multisig later. Do not renounce ownership or use a burn address
if you need whitelist administration.

Robinhood mainnet uses chain ID **4663** and **ETH** for gas. Use a production RPC
provider for the service. The public HTTP endpoint is
`https://rpc.mainnet.chain.robinhood.com`; it is rate-limited and not recommended
for production. The sequencer feed is not a WebSocket JSON-RPC endpoint.
See [official network details](https://docs.robinhood.com/chain/connecting/).

Load `.env` in the current terminal. Repeat this after every local edit or in a
new terminal. Only source an environment file you control: `source` executes shell syntax.

```sh
set -a
source ./.env
set +a

cast chain-id --rpc-url "$RPC_URL"
cast balance "$DEPLOYER_ADDRESS" --ether --rpc-url "$RPC_URL"
cast balance "$RELAYER_ADDRESS" --ether --rpc-url "$RPC_URL"
```

The chain ID must be 4663. Both wallets need ETH on Robinhood Chain. The relayer
needs funds upfront even when requests charge a fee; zero-fee requests are fully
sponsored by the relayer.

## 3. Stop new requests on the old router and drain its queue

Keep the old relayer running while old requests finish. Stop new requests from
every application using the old router.

Check the old router's owner:

```sh
cast call "$OLD_ROUTER_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL"
```

If your deployer is still the owner, disable the old demonstration consumer:

```sh
cast send "$OLD_ROUTER_ADDRESS" \
  "setConsumerAuthorization(address,bool)" "$OLD_CONSUMER_ADDRESS" false \
  --rpc-url "$RPC_URL" \
  --account openvrf-mainnet-deployer
```

If ownership was transferred, have the current owner perform authorization changes.
If ownership was renounced, pause admission at the applications instead.
Removing consumer authorization does not invalidate its existing requests.

Connect to the server using your configured SSH alias:

```sh
ssh openvrf
cd /root/openvrf
```

The existing server directory is assumed to be `/root/openvrf`; adjust it if yours differs.
Check queue state without printing signed transaction bytes:

```sh
docker compose exec -T postgres psql -U openvrf -d openvrf <<'SQL'
SELECT
  scope,
  data->'pending' IS DISTINCT FROM 'null'::jsonb AS has_pending_transaction,
  data->'pendingIds' AS pending_request_ids
FROM openvrf_relayer_state;
SQL
```

For the active old-router scope, wait for `has_pending_transaction = f` and
`pending_request_ids = {}`. Also confirm the old applications' outstanding callbacks
are complete; do not rely on a filtered queue if the service tracked only one consumer.

```sh
docker compose logs --tail=50 relayer
```

Return to your Mac terminal for deployment. Do not delete PostgreSQL rows or its
volume to clear pending work.

## 4. Deploy only OpenVRF from your Mac

For a new router, clear the local `CONSUMER_ADDRESS` first; the old example is bound
to the old router and should not be whitelisted on this new router.

```sh
pnpm run deploy:mainnet
# After reviewing the simulation, deploy only OpenVRF:
pnpm run deploy:mainnet -- --broadcast
```

Enter the Foundry keystore password when prompted. The constructor authorizes
`RELAYER_ADDRESS`. The script checks owner, fee, `MIN_DELAY=2`, and authorization,
saves `deployments/mainnet-<router-address>.json`, backs up `.env`, and updates
`ROUTER_ADDRESS` and `START_BLOCK`. It retains ownership.

**If OpenVRF is already deployed, skip this step.** Use its address in `.env`.
Each router broadcast invocation deploys a fresh router. Inspect
`broadcast/DeployConfigured.s.sol/4663/run-latest.json` before retrying a failed run:
transactions may already have mined.

## 5. Deploy only ExampleConsumer against the existing router

Check that the local `.env` contains the router you want to use. This script requires
`DEPLOYER_ADDRESS` to be the existing router's owner so it can whitelist the consumer.
It loads `.env` automatically and uses the existing Foundry account. Both deployment
scripts explicitly prefer the current `.env` contents over previously exported shell
variables, so an old `source .env` session cannot override the configured router.

```sh
pnpm run deploy:mainnet:example
# After reviewing the simulation, deploy only the consumer and whitelist it:
pnpm run deploy:mainnet:example -- --broadcast
```

This creates **one ExampleConsumer**, pointing to `ROUTER_ADDRESS`, and calls
`setConsumerAuthorization(newConsumer, true)` on that existing router. It verifies
the consumer's router binding and authorization, saves
`deployments/example-<consumer-address>.json`, backs up `.env`, and updates **only
`CONSUMER_ADDRESS`**. `ROUTER_ADDRESS` and `START_BLOCK` remain unchanged. It does
not change the relayer whitelist or deploy another OpenVRF.

If a usable ExampleConsumer is already deployed against your chosen router, skip
this deployment too and use its address. Each consumer broadcast invocation creates
a fresh consumer. On failure, inspect
`broadcast/DeployWithExample.s.sol/4663/run-latest.json` before retrying.

Reload the updated values for subsequent `cast` commands:

```sh
set -a
source ./.env
set +a
```

## 6. Verify the contracts in the explorer

The consumer script automatically generates:

- `deployments/ExampleConsumer.standard-input.json`
- `deployments/ExampleConsumer.constructor-args.txt`

The router-only script saves a deployment record, not explorer input. Generate the
router's verification files separately using the original constructor values:

```sh
mkdir -p deployments
forge verify-contract "$ROUTER_ADDRESS" src/OpenVRF.sol:OpenVRF \
  --chain 4663 --show-standard-json-input \
  > deployments/OpenVRF.standard-input.json

cast abi-encode 'constructor(address,address,uint256)' \
  "$OWNER_ADDRESS" "$RELAYER_ADDRESS" "${REQUEST_FEE_WEI:-0}" \
  > deployments/OpenVRF.constructor-args.txt

python3 -m json.tool deployments/OpenVRF.standard-input.json > /dev/null
python3 -m json.tool deployments/ExampleConsumer.standard-input.json > /dev/null
```

Use the router deployment manifest's original owner, relayer, and fee if these
settings have changed. For each new address, open
`https://robinhoodchain.blockscout.com/address/ADDRESS`, choose **Verify & Publish →
Solidity Standard JSON Input**, and upload the matching `.standard-input.json`.
Select compiler `v0.8.28+commit.7893614a` and the matching contract:

- Router: `src/OpenVRF.sol:OpenVRF`.
- Consumer: `src/ExampleConsumer.sol:ExampleConsumer`.

If constructor arguments are requested, copy the corresponding `.constructor-args.txt`.
Verification inputs contain source dependencies and compiler settings; the scripts
do not submit explorer verification. Keep the files for this deployment, as later
runs reuse the verification file names.

If consumer verification generation failed after deployment, regenerate without
sending any deployment transactions:

```sh
forge verify-contract "$CONSUMER_ADDRESS" src/ExampleConsumer.sol:ExampleConsumer \
  --chain 4663 --show-standard-json-input \
  > deployments/ExampleConsumer.standard-input.json
cast abi-encode 'constructor(address)' "$ROUTER_ADDRESS" \
  > deployments/ExampleConsumer.constructor-args.txt
```

## 7. Confirm the consumer and relayer

```sh
cast call "$CONSUMER_ADDRESS" "randomnessRouter()(address)" --rpc-url "$RPC_URL"
cast call "$ROUTER_ADDRESS" \
  "authorizedConsumers(address)(bool)" "$CONSUMER_ADDRESS" --rpc-url "$RPC_URL"
cast call "$ROUTER_ADDRESS" \
  "authorizedRelayers(address)(bool)" "$RELAYER_ADDRESS" --rpc-url "$RPC_URL"
```

Expect your chosen router address and `true` for both authorizations. The router
script authorizes only `RELAYER_ADDRESS`; authorize any additional relayer wallets
separately. The example's `request()` is public; disable it after the bounded test
if you do not want to sponsor arbitrary callers.

## 8. Switch the existing server

After the old queue is clear, on the server:

```sh
cd /root/openvrf
docker compose stop relayer
cp -p .env .env.before-router-change
chmod 600 .env .env.before-router-change
nano .env
```

Update these entries in the server's existing environment file:

```dotenv
CHAIN_ID=4663
ROUTER_ADDRESS=0xNEW_ROUTER_ADDRESS
START_BLOCK=NEW_ROUTER_DEPLOYMENT_BLOCK
START_REQUEST_ID=1
RELAY_ALL_CONSUMERS=true
CONSUMER_ADDRESS=
```

Keep the existing database password, RPC endpoints, relayer settings and key.
Do not overwrite the server configuration with the whole Mac `.env`.
If you keep `RELAY_ALL_CONSUMERS=false` instead, set the server
`CONSUMER_ADDRESS` to the newly printed consumer address. In router-wide mode,
`CONSUMER_ADDRESS` is not needed by the service; it is still
useful locally as the destination of manual test calls.

The existing `docker-compose.yml` must reference the prebuilt image, with no `build:`:

```yaml
services:
  relayer:
    image: ghcr.io/openvrf/openvrf-relayer:latest
```

This is a snippet, not a replacement for the full Compose file. Keep all its other settings.
No image rebuild or push is needed for this contract-only change.
The existing key is mounted as a Compose secret at `/run/secrets/relayer_key`.
Compose constructs the container's database URL automatically.

Ensure the dedicated key remains restricted and readable by the image's UID 1000:

```sh
chmod 700 secrets
chown 1000:1000 secrets/relayer-key
chmod 600 secrets/relayer-key

docker compose up -d --no-deps --no-build --force-recreate relayer
docker compose ps
docker compose logs --tail=50 -f relayer
```

Use `sudo` for ownership changes if not running as root. Ctrl+C exits the log
viewer without stopping containers. PostgreSQL remains running and retains the
old records; the new router has a separate state scope. Never run
`docker compose down -v` or delete rows to bypass recovery or spending controls.

## 9. Test from your Mac

In the local repository terminal:

```sh
set -a
source ./.env
set +a

cast send "$CONSUMER_ADDRESS" "request()" \
  --value "$REQUEST_FEE_WEI" \
  --rpc-url "$RPC_URL" \
  --account openvrf-mainnet-deployer
```

Read the request ID from `RandomnessRequested`. The first request on this router
should be 1. Replace `1` below if another request was created first.

```sh
cast call "$ROUTER_ADDRESS" \
  "requests(uint256)(address,uint64,uint32,bool,bool,uint256,uint256)" \
  1 --rpc-url "$RPC_URL"

cast call "$CONSUMER_ADDRESS" "received(uint256)(bool)" \
  1 --rpc-url "$RPC_URL"

node scripts/verify-request.mjs \
  --rpc "$RPC_URL" \
  --router "$ROUTER_ADDRESS" \
  --request-id 1 \
  --from-block "$START_BLOCK"
```

After delivery, expect `fulfilled = true`, `delivered = true`, and
`received = true`, plus a matching independent verification report. The request
and fulfillment block timestamps measure on-chain inclusion-to-inclusion latency.
Gas cost is each receipt's `gasUsed × effectiveGasPrice`; the caller's request
fee is additional and is paid to the fulfilling relayer on successful proof submission.

## 10. Final administration

Disable the publicly callable demonstration consumer after the bounded test:

```sh
cast send "$ROUTER_ADDRESS" \
  "setConsumerAuthorization(address,bool)" "$CONSUMER_ADDRESS" false \
  --rpc-url "$RPC_URL" \
  --account openvrf-mainnet-deployer
```

Authorize each real application consumer after connecting it to the new router:

```sh
cast send "$ROUTER_ADDRESS" \
  "setConsumerAuthorization(address,bool)" 0xYOUR_PRODUCTION_CONSUMER true \
  --rpc-url "$RPC_URL" \
  --account openvrf-mainnet-deployer
```

Test the real application's request and callback before reopening admission.
New router request IDs restart at 1: integrations and records must identify requests
by router address as well as request ID.

Keep ownership to manage future consumers, relayers and fees. Optionally transfer
it to a multisig you control, after confirming the recipient and its ability to
execute router administration:

```sh
cast send "$ROUTER_ADDRESS" \
  "transferOwnership(address)" 0xYOUR_MULTISIG_ADDRESS \
  --rpc-url "$RPC_URL" \
  --account openvrf-mainnet-deployer

cast call "$ROUTER_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL"
```

Ownership transfer takes effect immediately. After transfer, owner-only commands
must be submitted by the new owner. Confirm actual owner control with a harmless
owner-only operation as described in the [operator runbook](runbook.md).
Renunciation or transfer to a burn address would permanently prevent whitelist
changes. Ownership never enables upgrades of this router.
