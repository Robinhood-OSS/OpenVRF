import {spawnSync} from 'node:child_process';
import {parseEnv} from 'node:util';
import {readFileSync, writeFileSync, renameSync, copyFileSync, chmodSync, mkdirSync, statSync} from 'node:fs';
import {Contract, getAddress, JsonRpcProvider, ZeroAddress} from 'ethers';

// Run from the repository root with Node's --env-file=.env. Wallet keys remain in Foundry's keystore.
// Prefer the current file over stale variables exported by a previous shell session.
Object.assign(process.env, parseEnv(readFileSync('.env', 'utf8')));
const broadcast = process.argv.includes('--broadcast');
if (process.argv.slice(2).filter(arg => arg !== '--').some(arg => arg !== '--broadcast')) throw new Error('Usage: pnpm run deploy:mainnet:example -- [--broadcast]');
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
const routerAddress = address('ROUTER_ADDRESS');
if (required('CHAIN_ID') !== '4663') throw new Error('This script requires Robinhood mainnet CHAIN_ID=4663');
const provider = new JsonRpcProvider(required('RPC_URL'));
try {
  if ((await provider.getNetwork()).chainId !== 4663n) throw new Error('RPC is not Robinhood mainnet');
  if (await provider.getBalance(deployer) === 0n) throw new Error('Fund the deployer with ETH first');
  if (await provider.getCode(routerAddress) === '0x') throw new Error('ROUTER_ADDRESS must be an existing contract');
  const router = new Contract(routerAddress, [
    'function owner() view returns (address)',
    'function authorizedConsumers(address) view returns (bool)',
  ], provider);
  if (getAddress(await router.owner()) !== deployer) throw new Error('DEPLOYER_ADDRESS must own the existing router to whitelist the new consumer');
  const started = Date.now();
  const args = ['script', 'script/DeployWithExample.s.sol:DeployWithExample',
    '--rpc-url', process.env.RPC_URL, '--chain', '4663', '--sender', deployer,
    '--account', process.env.DEPLOYER_ACCOUNT || 'openvrf-mainnet-deployer'];
  if (broadcast) args.push('--broadcast', '--slow');
  console.log(broadcast ? `Deploying only ExampleConsumer against existing router ${routerAddress}; no router deployment.` : 'Simulation only. Add --broadcast to deploy.');
  const result = spawnSync('forge', args, {stdio: 'inherit', env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Foundry did not complete. Inspect broadcast/ before retrying: some transactions may already have mined.');
  if (!broadcast) process.exitCode = 0;
  else {
    const artifact = 'broadcast/DeployWithExample.s.sol/4663/run-latest.json';
    if (statSync(artifact).mtimeMs < started) throw new Error('Deployment artifact is stale');
    const data = JSON.parse(readFileSync(artifact, 'utf8'));
    const creates = data.transactions.filter(tx => tx.transactionType === 'CREATE');
    if (creates.length !== 1 || creates[0].contractName !== 'ExampleConsumer') {
      throw new Error('Unexpected deployment transactions. Inspect broadcast records before retrying.');
    }
    const consumerTx = data.transactions.find(tx => tx.transactionType === 'CREATE' && tx.contractName === 'ExampleConsumer');
    if (!consumerTx) throw new Error(`Missing consumer deployment address in ${artifact}`);
    const consumerAddress = getAddress(consumerTx.contractAddress);
    const receipt = data.receipts.find(item => item.transactionHash.toLowerCase() === consumerTx.hash.toLowerCase());
    if (!receipt || BigInt(receipt.status) !== 1n) throw new Error('Missing successful consumer deployment receipt');
    const manifest = {chainId: 4663, routerAddress, consumerAddress,
      consumerTransactionHash: consumerTx.hash, consumerDeploymentBlock: Number(BigInt(receipt.blockNumber))};
    mkdirSync('deployments', {recursive: true, mode: 0o700});
    const manifestPath = `deployments/example-${consumerAddress}.json`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
    console.log(`Existing ROUTER_ADDRESS=${routerAddress}\nCONSUMER_ADDRESS=${consumerAddress}\nSaved ${manifestPath}`);
    const consumer = new Contract(consumerAddress, ['function randomnessRouter() view returns (address)'], provider);
    const checks = await Promise.all([router.authorizedConsumers(consumerAddress), consumer.randomnessRouter()]);
    if (!checks[0] || getAddress(checks[1]) !== routerAddress) {
      throw new Error(`Consumer verification failed. Addresses saved in ${manifestPath}; do not deploy again blindly.`);
    }
    const env = readFileSync('.env', 'utf8');
    const updates = {CONSUMER_ADDRESS: consumerAddress};
    const lines = env.split('\n').filter(line => !Object.keys(updates).some(key => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)));
    const backup = `.env.before-deploy-${Date.now()}`;
    copyFileSync('.env', backup);
    chmodSync(backup, 0o600);
    const temporary = '.env.deploy.tmp';
    writeFileSync(temporary, lines.join('\n').trimEnd() + '\n' + Object.entries(updates).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {mode: 0o600});
    chmodSync(temporary, 0o600);
    renameSync(temporary, '.env');
    console.log('Verified consumer router binding and authorization. Updated only CONSUMER_ADDRESS in local .env.');
    for (const [contractAddress, contractName, constructorArgs] of [
      [consumerAddress, 'ExampleConsumer', ['constructor(address)', routerAddress]],
    ]) {
      const encoded = spawnSync('cast', ['abi-encode', ...constructorArgs], {encoding: 'utf8'});
      if (encoded.status !== 0 || encoded.error) throw new Error('Constructor encoding failed; deployment already completed.');
      writeFileSync(`deployments/${contractName}.constructor-args.txt`, encoded.stdout.trim() + '\n', {mode: 0o600});
      const json = spawnSync('forge', ['verify-contract', contractAddress, `src/${contractName}.sol:${contractName}`,
        '--chain', '4663', '--show-standard-json-input'], {encoding: 'utf8', maxBuffer: 20 * 1024 * 1024});
      if (json.status !== 0 || json.error) throw new Error('Verification JSON generation failed; deployment and .env update already completed.');
      JSON.parse(json.stdout);
      const jsonPath = `deployments/${contractName}.standard-input.json`;
      writeFileSync(jsonPath, json.stdout, {mode: 0o600});
      console.log(`Verification input: ${jsonPath}`);
    }
    console.log('Router and START_BLOCK are unchanged. If RELAY_ALL_CONSUMERS is not true on your server, update CONSUMER_ADDRESS and recreate its relayer container.');
  }
} finally {
  provider.destroy();
}
