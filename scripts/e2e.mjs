// Exercise the actual Docker entrypoint against disposable Anvil contracts and a real drand proof.
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createServer} from 'node:net';
import {ContractFactory, JsonRpcProvider, Wallet, parseEther, toBeHex} from 'ethers';

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const selected = server.address().port;
    server.close(error => error ? reject(error) : resolve(selected));
  });
});
const burstSize = 10;
const roundTime = 1727521075 + 999 * 3;
const name = `openvrf-e2e-${process.pid}`;
const relayerNames = [`${name}-a`, `${name}-b`];
const postgresName = `${name}-postgres`;
const networkName = `${name}-network`;
const dir = await mkdtemp(join(tmpdir(), 'openvrf-e2e-'));
const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, {staticNetwork: true, cacheTimeout: -1});
const anvil = spawn('anvil', ['--host', '0.0.0.0', '--port', String(port), '--timestamp', String(roundTime - 100), '--silent'], {stdio: 'ignore'});
let started = false;
try {
  anvil.on('error', error => { console.error(error.message); });
  for (let i = 0; i < 50; i++) {
    if (anvil.exitCode !== null) throw new Error('Anvil failed to start on its allocated port');
    try { await provider.getBlockNumber(); started = true; break; } catch { await sleep(100); }
  }
  if (!started) throw new Error('Anvil did not start');
  const wallet = Wallet.createRandom().connect(provider);
  const secondWallet = Wallet.createRandom().connect(provider);
  const requester = Wallet.createRandom().connect(provider);
  await provider.send('anvil_setBalance', [wallet.address, toBeHex(parseEther('10'))]);
  await provider.send('anvil_setBalance', [secondWallet.address, toBeHex(parseEther('10'))]);
  await provider.send('anvil_setBalance', [requester.address, toBeHex(parseEther('10'))]);
  const artifact = async name => JSON.parse(await readFile(`out/${name}.sol/${name}.json`, 'utf8'));
  const routerArtifact = await artifact('OpenVRF');
  const requestFee = parseEther('0.001');
  const router = await new ContractFactory(routerArtifact.abi, routerArtifact.bytecode.object, wallet)
    .deploy(wallet.address, wallet.address, requestFee);
  await router.waitForDeployment();
  const consumerArtifact = await artifact('ExampleConsumer');
  const consumer = await new ContractFactory(consumerArtifact.abi, consumerArtifact.bytecode.object, wallet).deploy(await router.getAddress());
  await consumer.waitForDeployment();
  await (await router.setConsumerAuthorization(await consumer.getAddress(), true)).wait();
  await (await router.setRelayerAuthorization(secondWallet.address, true)).wait();
  const keyFiles = [join(dir, 'key-a'), join(dir, 'key-b')];
  // Random, disposable Anvil-only key. Docker's non-root user needs read access to this mount.
  await writeFile(keyFiles[0], wallet.privateKey, {mode: 0o644});
  await writeFile(keyFiles[1], secondWallet.privateKey, {mode: 0o644});
  execFileSync('docker', ['network', 'create', networkName], {stdio: 'pipe'});
  execFileSync('docker', ['run', '-d', '--name', postgresName, '--network', networkName,
    '-e', 'POSTGRES_DB=openvrf', '-e', 'POSTGRES_USER=openvrf', '-e', 'POSTGRES_PASSWORD=test-only',
    'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'], {stdio: 'pipe'});
  for (let i = 0; i < 30; i++) {
    try {
      execFileSync('docker', ['exec', postgresName, 'pg_isready', '-U', 'openvrf', '-d', 'openvrf'],
        {stdio: 'ignore'});
      break;
    } catch {
      if (i === 29) throw new Error('PostgreSQL did not become ready');
      await sleep(1000);
    }
  }
  execFileSync('docker', ['exec', postgresName, 'psql', '-U', 'openvrf', '-d', 'openvrf', '-c',
    'CREATE DATABASE openvrf_legacy'], {stdio: 'ignore'});
  execFileSync('docker', ['exec', postgresName, 'psql', '-U', 'openvrf', '-d', 'openvrf_legacy', '-c', `
    CREATE TABLE openvrf_relayer_state (
      scope text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE openvrf_relayer_assignment (
      scope text PRIMARY KEY, version numeric NOT NULL, policy jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE openvrf_relayer_lease (
      scope text NOT NULL, request_id numeric NOT NULL, holder text NOT NULL,
      lease_until timestamptz NOT NULL, PRIMARY KEY (scope, request_id));
    INSERT INTO openvrf_relayer_state VALUES (
      'legacy-untouched',
      '{"version":6,"scope":"legacy-untouched","authorizedWei":"0","reimbursedWei":"0","retiredWei":"0","requests":{},"pending":null,"firstBlock":"0","nextBlock":"0","pendingIds":{}}',
      to_timestamp(1000.123));
    INSERT INTO openvrf_relayer_lease VALUES ('legacy-assignment', 1, '0x1', to_timestamp(2000.456));
  `], {stdio: 'ignore'});
  const migrateLegacyState = `
    import {openRelayState} from './relayer/state.mjs';
    const state = await openRelayState(
      'postgresql://openvrf:test-only@${postgresName}:5432/openvrf_legacy',
      'legacy-scope',
      {maxAttempts: 3, backoffMs: 30000, requestWei: 1000n, totalWei: 10000n},
      0n,
      'legacy-signer',
      {scope: 'legacy-assignment', version: '1', policy: {
        algorithm: 'request-id-round-robin-v1', relayers: ['0x1'],
        failoverSeconds: '60', leaseSeconds: '120'}},
    );
    await state.close();
  `;
  execFileSync('docker', ['run', '--rm', '--network', networkName, '--entrypoint', 'node',
    'openvrf:local', '--input-type=module', '--eval', migrateLegacyState], {stdio: 'ignore'});
  const migratedTimes = execFileSync('docker', ['exec', postgresName, 'psql', '-U', 'openvrf',
    '-d', 'openvrf_legacy', '-tAc', `SELECT
      (SELECT updated_at FROM openvrf_relayer_state WHERE scope = 'legacy-untouched') || ',' ||
      (SELECT lease_until FROM openvrf_relayer_lease WHERE scope = 'legacy-assignment' AND request_id = 1) || ',' ||
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name LIKE 'openvrf_relayer_%' AND column_name IN ('updated_at', 'lease_until')
        AND data_type = 'bigint')`], {encoding: 'utf8'}).trim();
  if (migratedTimes !== '1000123,2000456,3') throw new Error(`Unexpected legacy timestamp migration: ${migratedTimes}`);
  const relayerEnvironment = [
    `RPC_URL=http://host.docker.internal:${port}`,
    `WS_URL=ws://host.docker.internal:${port}`,
    'CHAIN_ID=31337', `ROUTER_ADDRESS=${await router.getAddress()}`,
    `CONSUMER_ADDRESS=${await consumer.getAddress()}`,
    `RELAYER_ADDRESSES=${wallet.address},${secondWallet.address}`,
    'RELAYER_SET_VERSION=1', 'RELAYER_FAILOVER_SECONDS=3',
    'RELAYER_LEASE_SECONDS=120',
    // Disposable Anvil does not mine continuously, so no recent-block lag is needed here.
    'RECONCILE_HEAD_LAG_BLOCKS=0',
    `DATABASE_URL=postgresql://openvrf:test-only@${postgresName}:5432/openvrf`,
    'MAX_GAS_PRICE_GWEI=100', 'MAX_REQUEST_SPEND_ETH=0.1', 'MAX_TOTAL_SPEND_ETH=1',
    'RECEIPT_CONFIRMATIONS=1', 'RELAYER_KEY_FILE=/run/secrets/relayer_key',
  ];
  for (let index = 0; index < relayerNames.length; index++) {
    execFileSync('docker', ['run', '-d', '--name', relayerNames[index],
      '--network', networkName,
      '--add-host', 'host.docker.internal:host-gateway',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '-v', `${keyFiles[index]}:/run/secrets/relayer_key:ro`,
      ...relayerEnvironment.flatMap(value => ['-e', value]), 'openvrf:local'], {stdio: 'pipe'});
  }
  await sleep(1000);
  const coordinationScope = `31337:${wallet.address}`.toLowerCase();
  const competingLock = execFileSync('docker', ['exec', postgresName, 'psql', '-U', 'openvrf',
    '-d', 'openvrf', '-tAc', `SELECT pg_try_advisory_lock(hashtextextended('${coordinationScope}', 0))`],
  {encoding: 'utf8'}).trim();
  if (competingLock !== 'f') throw new Error('PostgreSQL did not enforce single active relayer scope');
  try {
    execFileSync('docker', ['run', '--rm', '--network', networkName,
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${keyFiles[0]}:/run/secrets/relayer_key:ro`,
      ...relayerEnvironment.map(value => value === 'RELAYER_SET_VERSION=1'
        ? 'RELAYER_SET_VERSION=2' : value).flatMap(value => ['-e', value]),
      'openvrf:local'], {stdio: 'ignore'});
    throw new Error('Competing higher-version relayer unexpectedly started');
  } catch (error) {
    if (error.message === 'Competing higher-version relayer unexpectedly started') throw error;
  }
  const activeVersion = execFileSync('docker', ['exec', postgresName, 'psql', '-U', 'openvrf',
    '-d', 'openvrf', '-tAc', 'SELECT version FROM openvrf_relayer_assignment'], {encoding: 'utf8'}).trim();
  if (activeVersion !== '1') throw new Error('Failed startup incorrectly activated a newer relayer set');
  await provider.send('evm_setNextBlockTimestamp', [roundTime - 1]);
  await provider.send('evm_setAutomine', [false]);
  const firstNonce = await provider.getTransactionCount(requester.address);
  const requestTransaction = await consumer.connect(requester).request.populateTransaction({value: requestFee});
  const submitted = [];
  for (let index = 0; index < burstSize; index++) {
    submitted.push(await requester.sendTransaction({...requestTransaction, nonce: firstNonce + index}));
  }
  await provider.send('evm_mine', []);
  await provider.send('evm_setAutomine', [true]);
  await Promise.all(submitted.map(transaction => transaction.wait()));
  for (let id = 1; id <= burstSize; id++) {
    if ((await router.requests(id)).round !== 1000n) throw new Error(`Unexpected fixture round for ${id}`);
  }
  await provider.send('evm_setNextBlockTimestamp', [roundTime]);
  await provider.send('evm_mine', []);
  let delivered = false;
  for (let i = 0; i < 120; i++) {
    // Anvil has no interval mining here; produce the empty blocks a live chain would.
    await provider.send('evm_mine', []);
    const allReceived = (await Promise.all(
      Array.from({length: burstSize}, (_, index) => consumer.received(index + 1)),
    )).every(Boolean);
    if (allReceived) {
      const settledLedgers = Number(execFileSync('docker', ['exec', postgresName, 'psql', '-U', 'openvrf',
        '-d', 'openvrf', '-tAc', `SELECT count(*) FROM openvrf_relayer_state
          WHERE data->'pending' = 'null'::jsonb
          AND data->'pendingIds' = '{}'::jsonb
          AND (data->>'reimbursedWei')::numeric > 0`], {encoding: 'utf8'}).trim());
      if (settledLedgers === 2 &&
          await provider.getBalance(await router.getAddress()) === 0n) {
        delivered = true;
        break;
      }
    }
    await sleep(1000);
  }
  for (const relayerName of relayerNames) console.log(execFileSync('docker', ['logs', relayerName], {encoding: 'utf8'}));
  if (!delivered) throw new Error('Docker relayer did not deliver burst within 120 seconds');
  const bigintTimestampColumns = Number(execFileSync('docker', ['exec', postgresName, 'psql', '-U', 'openvrf',
    '-d', 'openvrf', '-tAc', `SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema()
      AND (table_name, column_name) IN (
        ('openvrf_relayer_state', 'updated_at'),
        ('openvrf_relayer_assignment', 'updated_at'),
        ('openvrf_relayer_lease', 'lease_until')
      ) AND data_type = 'bigint'`], {encoding: 'utf8'}).trim());
  if (bigintTimestampColumns !== 3) throw new Error('Relayer timestamps are not stored as PostgreSQL BIGINT');
  const words = [];
  for (let id = 1; id <= burstSize; id++) {
    const request = await router.requests(id);
    if (!request.fulfilled || !request.delivered || request.randomWord !== await consumer.results(id)) {
      throw new Error(`Consumer result ${id} disagrees with router`);
    }
    words.push(request.randomWord);
  }
  if (new Set(words.map(String)).size !== burstSize) throw new Error('Burst results were not request-specific');
  if (await provider.getBalance(await router.getAddress()) !== 0n) throw new Error('Relayer fee was not paid directly');

  // Stop request 11's primary wallet and prove the next wallet takes over after one chain-time window.
  execFileSync('docker', ['stop', relayerNames[0]], {stdio: 'ignore'});
  const failoverRequest = await consumer.connect(requester).request({value: requestFee});
  await failoverRequest.wait();
  const failoverId = BigInt(burstSize + 1);
  const failoverRound = (await router.requests(failoverId)).round;
  const failoverReadyAt = 1727521075n + (failoverRound - 1n) * 3n;
  await provider.send('evm_setNextBlockTimestamp', [Number(failoverReadyAt + 3n)]);
  await provider.send('evm_mine', []);
  let failedOver = false;
  for (let i = 0; i < 60; i++) {
    if (await consumer.received(failoverId)) { failedOver = true; break; }
    await sleep(1000);
  }
  if (!failedOver) throw new Error('Secondary relayer did not take over the stopped primary slot');
  for (const relayerName of relayerNames) execFileSync('docker', ['restart', relayerName], {stdio: 'ignore'});
  let restarted = false;
  for (let i = 0; i < 15; i++) {
    const ready = relayerNames.every(relayerName => {
      const running = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', relayerName],
        {encoding: 'utf8'}).trim() === 'true';
      const restartLogs = execFileSync('docker', ['logs', relayerName], {encoding: 'utf8'});
      return running && restartLogs.split('WebSocket listener active').length >= 3;
    });
    if (ready) {
      restarted = true;
      break;
    }
    await sleep(1000);
  }
  if (!restarted) throw new Error('Relayer did not restart from PostgreSQL state');
  execFileSync('docker', ['exec', postgresName, 'psql', '-U', 'openvrf', '-d', 'openvrf', '-c',
    'UPDATE openvrf_relayer_assignment SET version = 2'], {stdio: 'ignore'});
  await provider.send('evm_mine', []);
  let retired = false;
  for (let i = 0; i < 15; i++) {
    retired = relayerNames.every(relayerName => execFileSync('docker',
      ['inspect', '-f', '{{.State.Running}}', relayerName], {encoding: 'utf8'}).trim() === 'false');
    if (retired) break;
    await sleep(1000);
  }
  if (!retired) throw new Error('Older relayer-set processes remained active after version change');
  console.log(`PASS: two Docker relayers split ${burstSize} same-block requests, produced distinct results, received fees during fulfillment, renewed PostgreSQL budgets, enforced signer locks without premature version activation, failed over a stopped primary wallet, restarted from durable state, and retired the old active version.`);
} finally {
  for (const relayerName of relayerNames) {
    try { execFileSync('docker', ['rm', '-f', relayerName], {stdio: 'ignore'}); } catch {}
  }
  try { execFileSync('docker', ['rm', '-f', postgresName], {stdio: 'ignore'}); } catch {}
  try { execFileSync('docker', ['network', 'rm', networkName], {stdio: 'ignore'}); } catch {}
  provider.destroy();
  anvil.kill('SIGTERM');
  await rm(dir, {recursive: true, force: true});
}
