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

## Contract-only deployment shortcut

If your server is already configured, use the script below from the repository root.
It deploys only the current `OpenVRF` router, optionally authorizes the existing
`CONSUMER_ADDRESS`, and verifies the initial relayer authorization supplied by the
router constructor. It retains ownership and updates the local `.env` router address
and deployment block. It does not deploy a consumer.

Set these entries in your existing `.env` (owner and deployer must be the same wallet):

```dotenv
CHAIN_ID=4663
DEPLOYER_ACCOUNT=openvrf-mainnet-deployer
DEPLOYER_ADDRESS=0xYOUR_DEPLOYER_WALLET_ADDRESS
OWNER_ADDRESS=0xYOUR_DEPLOYER_WALLET_ADDRESS
RELAYER_ADDRESS=0xYOUR_EXISTING_RELAYER_WALLET_ADDRESS
REQUEST_FEE_WEI=0
# Optional existing consumer contract to whitelist; leave empty to skip.
CONSUMER_ADDRESS=
```

Keep your configured `RPC_URL`. With Node.js 22+ and Foundry installed:

```sh
npm ci
# Simulation: no transactions are sent.
npm run deploy:mainnet
# Deployment: unlock the existing Foundry keystore when prompted.
npm run deploy:mainnet -- --broadcast
```

The deployment prints `ROUTER_ADDRESS` and `START_BLOCK` and saves
`deployments/mainnet-<router-address>.json`. The local `.env` is backed up before those
two entries are updated. Use the saved deployment address if later verification
fails; inspect `broadcast/DeployConfigured.s.sol/4663/` before retrying a failed broadcast.
This is a fresh deployment on every broadcast run, not a resumable migration command.

The script authorizes `RELAYER_ADDRESS`; it does not configure a multi-wallet
`RELAYER_ADDRESSES` list. Authorize any additional relayers separately as owner.
It does not drain old requests or disable the previous router: finish those requests
before switching your service (see section 3 below). Update just the two printed
entries on your server and recreate the relayer container; the script does not access
the server. Explorer verification remains a separate step in section 6.

Whitelisting an existing consumer does not update its router binding. In particular,
your old `ExampleConsumer` has an immutable router and will keep calling the old router.
Testing the new router with `ExampleConsumer` requires a separate new consumer deployment
(section 7), which this shortcut intentionally does not perform. Its `request()` is public;
disable that consumer after testing if you do not want to sponsor arbitrary callers.

## 1. Prepare on your Mac

Open the local repository root. Foundry, Node.js 22+, Python 3 and your existing
Foundry account `openvrf-mainnet-deployer` must be available.

```sh
cd /path/to/openvrf
forge build
forge test
npm test
rg 'MIN_DELAY =' src/OpenVRF.sol
```

Expected source setting:

```solidity
uint256 public constant MIN_DELAY = 2;
```

If dependencies are not installed yet:

```sh
git submodule update --init --recursive
npm ci --ignore-scripts
```

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

DEPLOYER_ADDRESS=0xYOUR_DEPLOYER_WALLET_ADDRESS
OWNER_ADDRESS=0xYOUR_DEPLOYER_WALLET_ADDRESS
RELAYER_ADDRESS=0xYOUR_EXISTING_RELAYER_WALLET_ADDRESS
REQUEST_FEE_WEI=0

OLD_ROUTER_ADDRESS=0xYOUR_OLD_ROUTER_ADDRESS
OLD_CONSUMER_ADDRESS=0xYOUR_OLD_EXAMPLE_CONSUMER_ADDRESS
```

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

## 4. Deploy the new router from your Mac

The script reads `OWNER_ADDRESS`, `RELAYER_ADDRESS` and `REQUEST_FEE_WEI` from the
loaded environment. The constructor authorizes the initial relayer automatically.

Simulate first:

```sh
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --account openvrf-mainnet-deployer \
  --sender "$DEPLOYER_ADDRESS"
```

Review the simulation, then submit:

```sh
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --account openvrf-mainnet-deployer \
  --sender "$DEPLOYER_ADDRESS" \
  --broadcast
```

Enter the existing encrypted keystore password when prompted. If submission
times out, inspect the original transaction before repeating deployment.

Display the address, transaction hash and deployment block from this broadcast:

```sh
python3 - <<'PY'
import json
from pathlib import Path

path = Path("broadcast/Deploy.s.sol/4663/run-latest.json")
data = json.loads(path.read_text())
for tx in data["transactions"]:
    if tx.get("contractName") != "OpenVRF":
        continue
    print("ROUTER_ADDRESS=" + tx["contractAddress"])
    print("ROUTER_DEPLOY_TX=" + tx["hash"])
    for receipt in data.get("receipts", []):
        if receipt.get("transactionHash", "").lower() == tx["hash"].lower():
            block = receipt["blockNumber"]
            block = int(block, 16) if isinstance(block, str) and block.startswith("0x") else int(block)
            print("START_BLOCK=" + str(block))
PY
```

Use the record from this deployment, not an older broadcast.

## 5. Record and validate the new router

Edit the local `.env`:

```sh
nano .env
```

Replace the router/block entries and add its deployment transaction:

```dotenv
ROUTER_ADDRESS=0xNEW_ROUTER_ADDRESS
ROUTER_DEPLOY_TX=0xNEW_ROUTER_DEPLOYMENT_TRANSACTION_HASH
START_BLOCK=NEW_ROUTER_DEPLOYMENT_BLOCK
```

Reload and inspect:

```sh
set -a
source ./.env
set +a

cast receipt "$ROUTER_DEPLOY_TX" --rpc-url "$RPC_URL"
cast call "$ROUTER_ADDRESS" "MIN_DELAY()(uint256)" --rpc-url "$RPC_URL"
cast call "$ROUTER_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL"
cast call "$ROUTER_ADDRESS" \
  "authorizedRelayers(address)(bool)" "$RELAYER_ADDRESS" --rpc-url "$RPC_URL"
cast call "$ROUTER_ADDRESS" "requestFee()(uint256)" --rpc-url "$RPC_URL"
```

Expect a successful receipt, `MIN_DELAY = 2`, your initial owner, relayer
authorization `true`, and your configured request fee.

## 6. Verify the router source

Use the original constructor values from this deployment, even if administration
changes later.

```sh
forge verify-contract \
  "$ROUTER_ADDRESS" src/OpenVRF.sol:OpenVRF \
  --chain "$CHAIN_ID" \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --skip-is-verified-check \
  --constructor-args "$(cast abi-encode \
    'constructor(address,address,uint256)' \
    "$OWNER_ADDRESS" "$RELAYER_ADDRESS" "$REQUEST_FEE_WEI")" \
  --watch
```

If Cloudflare returns challenge HTML, generate Standard JSON for browser verification:

```sh
mkdir -p deployments
forge verify-contract \
  "$ROUTER_ADDRESS" src/OpenVRF.sol:OpenVRF \
  --chain "$CHAIN_ID" \
  --show-standard-json-input \
  > deployments/OpenVRF.standard-input.json

python3 -m json.tool deployments/OpenVRF.standard-input.json > /dev/null
```

Open the new address at `https://robinhoodchain.blockscout.com/address/NEW_ROUTER_ADDRESS`.
Choose **Verify & Publish → Solidity Standard JSON Input**. Upload the generated
file, choose compiler `v0.8.28+commit.7893614a`, and select
`src/OpenVRF.sol:OpenVRF` / `OpenVRF` if requested. Supply the encoded original
constructor arguments if requested. The JSON includes dependencies and compiler settings.

## 7. Deploy and authorize a new demonstration consumer

```sh
forge create src/ExampleConsumer.sol:ExampleConsumer \
  --rpc-url "$RPC_URL" \
  --account openvrf-mainnet-deployer \
  --broadcast \
  --constructor-args "$ROUTER_ADDRESS"
```

Put the `Deployed to` address into the local `.env`:

```dotenv
CONSUMER_ADDRESS=0xNEW_EXAMPLE_CONSUMER_ADDRESS
```

Reload, check the router binding, authorize the consumer and confirm authorization:

```sh
set -a
source ./.env
set +a

cast call "$CONSUMER_ADDRESS" "randomnessRouter()(address)" --rpc-url "$RPC_URL"

cast send "$ROUTER_ADDRESS" \
  "setConsumerAuthorization(address,bool)" "$CONSUMER_ADDRESS" true \
  --rpc-url "$RPC_URL" \
  --account openvrf-mainnet-deployer

cast call "$ROUTER_ADDRESS" \
  "authorizedConsumers(address)(bool)" "$CONSUMER_ADDRESS" --rpc-url "$RPC_URL"
```

The binding must equal the new router and authorization must be `true`.
This consumer exposes public requests and is for a bounded smoke test. Production
PowerPot consumers need application-specific admission control, request/action binding
and their own deployment or router configuration procedure.

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
In router-wide mode, `CONSUMER_ADDRESS` is not needed by the service; it is still
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
