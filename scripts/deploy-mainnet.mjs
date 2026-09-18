import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, renameSync, copyFileSync, chmodSync, mkdirSync, statSync} from 'node:fs';
import {Contract, getAddress, JsonRpcProvider, ZeroAddress} from 'ethers';

// Run from the repository root with Node's --env-file=.env. Wallet keys remain in Foundry's keystore.
const broadcast = process.argv.includes('--broadcast');
if (process.argv.slice(2).some(arg => arg !== '--broadcast')) throw new Error('Usage: npm run deploy:mainnet -- [--broadcast]');
const required = name => {
  if (!process.env[name]) throw new Error(`Set ${name} in .env`);
  return process.env[name];
};
const address = name => {
  const value = getAddress(required(name));
  if (value === ZeroAddress) throw new Error(`${name} must not be zero`);
  return value;
};
const deployer = address('DEPLOYER_ADDRESS');
const owner = address('OWNER_ADDRESS');
const relayer = address('RELAYER_ADDRESS');
const consumerAddress = process.env.CONSUMER_ADDRESS ? getAddress(process.env.CONSUMER_ADDRESS) : ZeroAddress;
// Foundry envOr expects an absent variable rather than an empty address.
if (!process.env.CONSUMER_ADDRESS) delete process.env.CONSUMER_ADDRESS;
if (owner !== deployer) throw new Error('OWNER_ADDRESS must equal DEPLOYER_ADDRESS for consumer authorization. Transfer ownership later if needed.');
if (required('CHAIN_ID') !== '4663') throw new Error('This script requires Robinhood mainnet CHAIN_ID=4663');
const fee = BigInt(process.env.REQUEST_FEE_WEI ?? '0');
if (fee < 0n) throw new Error('REQUEST_FEE_WEI must be nonnegative');
const provider = new JsonRpcProvider(required('RPC_URL'));
try {
  if ((await provider.getNetwork()).chainId !== 4663n) throw new Error('RPC is not Robinhood mainnet');
  if (await provider.getBalance(deployer) === 0n) throw new Error('Fund the deployer with ETH first');
  if (consumerAddress !== ZeroAddress && await provider.getCode(consumerAddress) === '0x') {
    throw new Error('CONSUMER_ADDRESS must be an existing contract, or leave it empty');
  }
  const started = Date.now();
  const args = ['script', 'script/DeployConfigured.s.sol:DeployConfigured',
    '--rpc-url', process.env.RPC_URL, '--chain', '4663', '--sender', deployer,
    '--account', process.env.DEPLOYER_ACCOUNT || 'openvrf-mainnet-deployer'];
  if (broadcast) args.push('--broadcast', '--slow');
  console.log(broadcast ? 'Deploying only OpenVRF; ownership is retained.' : 'Simulation only. Add --broadcast to deploy.');
  if (consumerAddress !== ZeroAddress) {
    console.log(`Existing consumer to authorize: ${consumerAddress}. Authorization does not change its router binding.`);
  }
  const result = spawnSync('forge', args, {stdio: 'inherit', env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Foundry did not complete. Inspect broadcast/ before retrying: some transactions may already have mined.');
  if (!broadcast) process.exitCode = 0;
  else {
    const artifact = 'broadcast/DeployConfigured.s.sol/4663/run-latest.json';
    if (statSync(artifact).mtimeMs < started) throw new Error('Deployment artifact is stale');
    const data = JSON.parse(readFileSync(artifact, 'utf8'));
    const routerTx = data.transactions.find(tx => tx.transactionType === 'CREATE' && tx.contractName === 'OpenVRF');
    if (!routerTx) throw new Error(`Missing router deployment address in ${artifact}`);
    const routerAddress = getAddress(routerTx.contractAddress);
    const receipt = data.receipts.find(item => item.transactionHash.toLowerCase() === routerTx.hash.toLowerCase());
    if (!receipt) throw new Error('Missing router deployment receipt');
    const startBlock = Number(BigInt(receipt.blockNumber));
    const manifest = {chainId: 4663, routerAddress, consumerAddress, ownerAddress: owner,
      relayerAddress: relayer, requestFeeWei: String(fee), startBlock,
      routerTransactionHash: routerTx.hash};
    mkdirSync('deployments', {recursive: true, mode: 0o700});
    const manifestPath = `deployments/mainnet-${routerAddress}.json`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
    console.log(`ROUTER_ADDRESS=${routerAddress}\nSTART_BLOCK=${startBlock}\nSaved ${manifestPath}`);
    const router = new Contract(routerAddress, [
      'function owner() view returns (address)', 'function MIN_DELAY() view returns (uint256)',
      'function requestFee() view returns (uint256)',
      'function authorizedConsumers(address) view returns (bool)',
      'function authorizedRelayers(address) view returns (bool)',
    ], provider);
    const checks = await Promise.all([router.owner(), router.MIN_DELAY(), router.requestFee(),
      consumerAddress === ZeroAddress ? true : router.authorizedConsumers(consumerAddress), router.authorizedRelayers(relayer)]);
    if (getAddress(checks[0]) !== owner || checks[1] !== 2n || checks[2] !== fee ||
        !checks[3] || !checks[4]) {
      throw new Error(`Post-deployment verification failed. Addresses saved in ${manifestPath}; do not deploy again blindly.`);
    }
    const env = readFileSync('.env', 'utf8');
    const updates = {ROUTER_ADDRESS: routerAddress, START_BLOCK: startBlock};
    const lines = env.split('\n').filter(line => !Object.keys(updates).some(key => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)));
    const backup = `.env.before-deploy-${Date.now()}`;
    copyFileSync('.env', backup);
    chmodSync(backup, 0o600);
    const temporary = '.env.deploy.tmp';
    writeFileSync(temporary, lines.join('\n').trimEnd() + '\n' + Object.entries(updates).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {mode: 0o600});
    chmodSync(temporary, 0o600);
    renameSync(temporary, '.env');
    console.log('Verified owner, 2–4-second beacon timing, fee and configured authorizations. Updated local .env.');
    console.log('Update ROUTER_ADDRESS and START_BLOCK on your server, then recreate its relayer container.');
  }
} finally {
  provider.destroy();
}
