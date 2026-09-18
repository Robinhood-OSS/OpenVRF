import {mkdir, readFile, open, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';

const unixMillis = value => {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('Invalid Unix timestamp');
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Unix timestamp');
  return BigInt(value);
};
const postgresUnixMillis = 'floor(extract(epoch from clock_timestamp()) * 1000)::bigint';

// Costs are conservative reservations, not receipts: unused gas is never refunded.
export async function openRelayState(path, scope, limits, startBlock = 0n, coordinationScope = scope,
  assignment = null) {
  if (!Number.isSafeInteger(limits.maxAttempts) || limits.maxAttempts < 1 || limits.maxAttempts > 100 ||
      !Number.isSafeInteger(limits.backoffMs) || limits.backoffMs < 1 ||
      limits.requestWei <= 0n || limits.totalWei <= 0n || startBlock < 0n) throw new Error('Invalid relay limits');
  const postgres = /^postgres(?:ql)?:\/\//.test(path);
  let lock;
  let client;
  const samePolicy = policy => policy?.algorithm === assignment?.policy.algorithm &&
    policy?.failoverSeconds === assignment?.policy.failoverSeconds &&
    policy?.leaseSeconds === assignment?.policy.leaseSeconds &&
    JSON.stringify(policy?.relayers) === JSON.stringify(assignment?.policy.relayers);
  if (postgres) {
    const {Client} = await import('pg');
    client = new Client({connectionString: path});
    try {
      await client.connect();
      const schemaLock = 'openvrf:schema:v1';
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [schemaLock]);
      try {
        await client.query(`CREATE TABLE IF NOT EXISTS openvrf_relayer_state (
          scope text PRIMARY KEY,
          data jsonb NOT NULL,
          updated_at bigint NOT NULL DEFAULT ${postgresUnixMillis}
        )`);
        if (assignment) {
          await client.query(`CREATE TABLE IF NOT EXISTS openvrf_relayer_assignment (
            scope text PRIMARY KEY,
            version numeric NOT NULL,
            policy jsonb NOT NULL,
            updated_at bigint NOT NULL DEFAULT ${postgresUnixMillis}
          )`);
          await client.query(`CREATE TABLE IF NOT EXISTS openvrf_relayer_lease (
            scope text NOT NULL,
            request_id numeric NOT NULL,
            holder text NOT NULL,
            lease_until bigint NOT NULL,
            PRIMARY KEY (scope, request_id)
          )`);
        }
        await client.query(`DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'openvrf_relayer_state'
            AND column_name = 'updated_at' AND data_type = 'timestamp with time zone') THEN
            ALTER TABLE openvrf_relayer_state ALTER COLUMN updated_at DROP DEFAULT;
            ALTER TABLE openvrf_relayer_state ALTER COLUMN updated_at TYPE bigint
              USING floor(extract(epoch from updated_at) * 1000)::bigint;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'openvrf_relayer_assignment'
            AND column_name = 'updated_at' AND data_type = 'timestamp with time zone') THEN
            ALTER TABLE openvrf_relayer_assignment ALTER COLUMN updated_at DROP DEFAULT;
            ALTER TABLE openvrf_relayer_assignment ALTER COLUMN updated_at TYPE bigint
              USING floor(extract(epoch from updated_at) * 1000)::bigint;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'openvrf_relayer_lease'
            AND column_name = 'lease_until' AND data_type = 'timestamp with time zone') THEN
            ALTER TABLE openvrf_relayer_lease ALTER COLUMN lease_until TYPE bigint
              USING floor(extract(epoch from lease_until) * 1000)::bigint;
          END IF;
        END $$`);
        await client.query(`ALTER TABLE openvrf_relayer_state ALTER COLUMN updated_at
          SET DEFAULT ${postgresUnixMillis}`);
        if (assignment) await client.query(`ALTER TABLE openvrf_relayer_assignment ALTER COLUMN updated_at
          SET DEFAULT ${postgresUnixMillis}`);
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [schemaLock]);
      }
      const acquired = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [coordinationScope]);
      if (!acquired.rows[0].locked) throw new Error('Relayer scope is already locked');
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  } else {
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    lock = `${path}.lock`;
    // The holder records its PID inside the lock directory so a SIGKILLed process does not
    // block every later start. A live or unverifiable holder keeps the fail-closed error.
    for (;;) {
      try {
        await mkdir(lock, {mode: 0o700});
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number((await readFile(join(lock, 'pid'), 'utf8').catch(() => '')).trim());
        let stale = false;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (probe) { stale = probe.code === 'ESRCH'; }
        }
        if (!stale) throw error;
        await rm(lock, {recursive: true, force: true});
      }
    }
    await writeFile(join(lock, 'pid'), `${process.pid}\n`, {mode: 0o600});
  }
  try {
    let data;
    if (postgres) {
      const result = await client.query('SELECT data FROM openvrf_relayer_state WHERE scope = $1', [scope]);
      data = result.rows[0]?.data;
    } else {
      try { data = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!data) {
      data = {version: 6, scope, authorizedWei: '0', reimbursedWei: '0', retiredWei: '0', requests: {}, pending: null,
        firstBlock: String(startBlock), nextBlock: String(startBlock), pendingIds: {}};
    }
    const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
    // Preserve spending history while upgrading pre-indexer state. Events are safely backfilled.
    if (data.version === 1 && data.scope === scope) {
      Object.assign(data, {version: 2, retiredWei: '0', firstBlock: String(startBlock),
        nextBlock: String(startBlock), pendingIds: {}});
    }
    // Version 2 stored only a transaction hash. Keep it readable, but mark it as a legacy
    // pending item that requires receipt discovery or manual operator reconciliation.
    if (data.version === 2 && data.scope === scope) {
      data.version = 3;
      if (data.pending) Object.assign(data.pending,
        {signedTransaction: null, nonce: null, submittedAt: 0, lastBroadcastAt: 0});
    }
    if (data.version === 3 && data.scope === scope) {
      data.version = 4;
      data.reimbursedWei = '0';
      if (data.pending) data.pending.reimbursementWei = '0';
    }
    if (data.version === 4 && data.scope === scope) {
      data.version = 5;
      if (data.pending) Object.assign(data.pending,
        {rebroadcastCount: 0, nextRebroadcastAt: 0, manualIntervention: false, manualReason: null});
    }
    if (data.version === 5 && data.scope === scope) {
      const legacyTimestamp = value => {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid legacy timestamp');
        return String(value);
      };
      data.version = 6;
      for (const entry of Object.values(data.requests)) entry.nextAttemptAt = legacyTimestamp(entry.nextAttemptAt);
      if (data.pending) {
        data.pending.submittedAt = legacyTimestamp(data.pending.submittedAt);
        data.pending.lastBroadcastAt = legacyTimestamp(data.pending.lastBroadcastAt);
        data.pending.nextRebroadcastAt = legacyTimestamp(data.pending.nextRebroadcastAt);
      }
    }
    // Legacy ledgers could carry a non-numeric 'fee-claim' operation; no current code creates
    // one. Retire a settled reservation into lifetime spending, and keep an unresolved one under
    // manual intervention — re-keyed so pending IDs stay uniformly numeric — for receipt monitoring.
    if (data.version === 6 && data.scope === scope && data.requests?.['fee-claim']) {
      const legacy = data.requests['fee-claim'];
      delete data.requests['fee-claim'];
      if (data.pending?.id === 'fee-claim') {
        const syntheticId = String(Number.MAX_SAFE_INTEGER);
        data.requests[syntheticId] = legacy;
        data.pending.id = syntheticId;
        data.pending.manualIntervention = true;
        data.pending.manualReason = 'legacy fee-claim operation';
      } else {
        data.retiredWei = String(BigInt(data.retiredWei) + BigInt(legacy.authorizedWei));
      }
    }
    if (data.version !== 6 || data.scope !== scope || !decimal(data.authorizedWei) ||
        !decimal(data.reimbursedWei) || BigInt(data.reimbursedWei) > BigInt(data.authorizedWei) ||
        !decimal(data.retiredWei) ||
        !decimal(data.firstBlock) || !decimal(data.nextBlock) || BigInt(data.nextBlock) < BigInt(data.firstBlock) ||
        !data.pendingIds || typeof data.pendingIds !== 'object' || Array.isArray(data.pendingIds) ||
        !data.requests || typeof data.requests !== 'object' || Array.isArray(data.requests)) throw new Error('Invalid state');
    for (const [id, present] of Object.entries(data.pendingIds)) {
      if (!/^[1-9][0-9]*$/.test(id) || present !== true) throw new Error('Invalid indexed request state');
    }
    let total = BigInt(data.retiredWei);
    for (const [id, entry] of Object.entries(data.requests)) {
      if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(entry.attempts) || entry.attempts < 1 ||
          !decimal(entry.authorizedWei) || !decimal(entry.nextAttemptAt)) throw new Error('Invalid request state');
      total += BigInt(entry.authorizedWei);
    }
    if (total !== BigInt(data.authorizedWei) || (data.pending !== null &&
        (!data.pending || !/^0x[0-9a-f]{64}$/i.test(data.pending.hash) || !data.requests[data.pending.id] ||
        (data.pending.signedTransaction !== null && !/^0x[0-9a-f]+$/i.test(data.pending.signedTransaction)) ||
        (data.pending.nonce !== null && !decimal(data.pending.nonce)) ||
        (data.pending.previousHashes !== undefined && (!Array.isArray(data.pending.previousHashes) ||
          data.pending.previousHashes.some(hash => !/^0x[0-9a-f]{64}$/i.test(hash)))) ||
        !decimal(data.pending.reimbursementWei ?? '') ||
        !decimal(data.pending.submittedAt) || !decimal(data.pending.lastBroadcastAt) ||
        !Number.isSafeInteger(data.pending.rebroadcastCount) || data.pending.rebroadcastCount < 0 ||
        !decimal(data.pending.nextRebroadcastAt) ||
        typeof data.pending.manualIntervention !== 'boolean' ||
        (data.pending.manualIntervention
          ? typeof data.pending.manualReason !== 'string' || data.pending.manualReason.length < 1 ||
            data.pending.manualReason.length > 200
          : data.pending.manualReason !== null)))) throw new Error('Invalid pending state');
    // Activate a new relayer set only after this process owns its signer lock and has
    // successfully loaded and validated its durable state.
    if (postgres && assignment) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [assignment.scope]);
        const configured = await client.query(
          'SELECT version::text, policy FROM openvrf_relayer_assignment WHERE scope = $1 FOR UPDATE',
          [assignment.scope]);
        const active = configured.rows[0];
        const version = BigInt(assignment.version);
        if (!active) {
          await client.query(`INSERT INTO openvrf_relayer_assignment (scope, version, policy)
            VALUES ($1, $2, $3::jsonb)`, [assignment.scope, assignment.version, JSON.stringify(assignment.policy)]);
        } else if (version < BigInt(active.version) ||
            (version === BigInt(active.version) && !samePolicy(active.policy))) {
          throw new Error('Relayer assignment disagrees with active durable configuration');
        } else if (version > BigInt(active.version)) {
          await client.query(`UPDATE openvrf_relayer_assignment
            SET version = $2, policy = $3::jsonb, updated_at = ${postgresUnixMillis} WHERE scope = $1`,
          [assignment.scope, assignment.version, JSON.stringify(assignment.policy)]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    const state = {
      data, failed: false,
      async save() {
        try {
          if (postgres) {
          await client.query(`INSERT INTO openvrf_relayer_state (scope, data, updated_at)
              VALUES ($1, $2::jsonb, ${postgresUnixMillis})
              ON CONFLICT (scope) DO UPDATE SET data = EXCLUDED.data, updated_at = ${postgresUnixMillis}`,
            [scope, JSON.stringify(data)]);
          } else {
            const temporary = `${path}.${randomUUID()}.tmp`;
            const file = await open(temporary, 'wx', 0o600);
            try { await file.writeFile(JSON.stringify(data)); await file.sync(); } finally { await file.close(); }
            await rename(temporary, path);
            const directory = await open(dirname(path), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
          }
        } catch (error) { state.failed = true; throw error; }
      },
      async assignmentActive() {
        if (!postgres || !assignment) return true;
        const result = await client.query(
          'SELECT version::text, policy FROM openvrf_relayer_assignment WHERE scope = $1',
          [assignment.scope]);
        return result.rows[0]?.version === assignment.version && samePolicy(result.rows[0]?.policy);
      },
      async acquireRequest(id, holder, leaseSeconds) {
        if (!postgres || !assignment) return true;
        const result = await client.query(`INSERT INTO openvrf_relayer_lease
          (scope, request_id, holder, lease_until)
          VALUES ($1, $2, $3, ${postgresUnixMillis} + $4::bigint * 1000)
          ON CONFLICT (scope, request_id) DO UPDATE
          SET holder = EXCLUDED.holder, lease_until = EXCLUDED.lease_until
          WHERE openvrf_relayer_lease.lease_until <= ${postgresUnixMillis}
             OR openvrf_relayer_lease.holder = EXCLUDED.holder
          RETURNING holder`, [assignment.scope, String(id), holder, Number(leaseSeconds)]);
        return result.rows[0]?.holder === holder;
      },
      async releaseRequest(id, holder = null) {
        if (postgres && assignment) {
          await client.query(`DELETE FROM openvrf_relayer_lease
            WHERE scope = $1 AND request_id = $2 AND ($3::text IS NULL OR holder = $3)`,
          [assignment.scope, String(id), holder]);
        }
      },
      reason(id, now = BigInt(Date.now())) {
        const entry = data.requests[id];
        if (state.failed) return 'state write failed';
        if (data.pending) return 'unresolved transaction';
        if (BigInt(data.authorizedWei) - BigInt(data.reimbursedWei) >= limits.totalWei) return 'total spending cap';
        if (entry?.attempts >= limits.maxAttempts) return 'attempt limit';
        if (BigInt(entry?.authorizedWei ?? '0') >= limits.requestWei) return 'request spending cap';
        if (entry && BigInt(entry.nextAttemptAt) > unixMillis(now)) return 'backoff';
        return null;
      },
      requestIds() {
        return Object.keys(data.pendingIds).map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      },
      async indexed(ids, nextBlock) {
        if (nextBlock < BigInt(data.firstBlock)) throw new Error('Invalid index cursor');
        for (const id of ids) {
          if (id < 1n) throw new Error('Invalid request ID');
          data.pendingIds[String(id)] = true;
        }
        data.nextBlock = String(nextBlock);
        await state.save();
      },
      async discovered(ids) {
        for (const id of ids) {
          if (id < 1n) throw new Error('Invalid request ID');
          data.pendingIds[String(id)] = true;
        }
        await state.save();
      },
      async delivered(id) {
        await state.deliveredMany([id]);
      },
      async deliveredMany(ids) {
        for (const id of ids) {
          const key = String(id);
          if (data.pending?.id === key) throw new Error('Cannot retire unresolved transaction');
          delete data.pendingIds[key];
          const entry = data.requests[key];
          if (entry) {
            data.retiredWei = String(BigInt(data.retiredWei) + BigInt(entry.authorizedWei));
            delete data.requests[key];
          }
        }
        for (const id of ids) await state.releaseRequest(id);
        await state.save();
      },
      async retireOperation(id) {
        const key = String(id);
        if (data.pending?.id === key) throw new Error('Cannot retire unresolved transaction');
        const entry = data.requests[key];
        if (entry) {
          data.retiredWei = String(BigInt(data.retiredWei) + BigInt(entry.authorizedWei));
          delete data.requests[key];
          await state.save();
        }
      },
      async reserve(id, cost, pending, now = BigInt(Date.now()), reimbursementWei = 0n) {
        const nowMs = unixMillis(now);
        const reason = state.reason(id, now);
        if (reason && !(reason === 'total spending cap' && reimbursementWei > 0n)) return reason;
        if (cost <= 0n || typeof reimbursementWei !== 'bigint' || reimbursementWei < 0n ||
            !pending || !/^0x[0-9a-f]{64}$/i.test(pending.hash) ||
            !/^0x[0-9a-f]+$/i.test(pending.signedTransaction) || pending.nonce < 0n) throw new Error('Invalid reservation');
        const entry = data.requests[id] ?? {attempts: 0, authorizedWei: '0', nextAttemptAt: '0'};
        const operatingWei = BigInt(data.authorizedWei) - BigInt(data.reimbursedWei);
        const projectedWei = operatingWei + cost > reimbursementWei
          ? operatingWei + cost - reimbursementWei : 0n;
        if (projectedWei > limits.totalWei) return 'total spending cap';
        if (BigInt(entry.authorizedWei) + cost > limits.requestWei) return 'request spending cap';
        entry.nextAttemptAt = String(nowMs + BigInt(Math.min(3600000, limits.backoffMs * 2 ** entry.attempts)));
        entry.attempts++;
        entry.authorizedWei = String(BigInt(entry.authorizedWei) + cost);
        data.requests[id] = entry;
        data.authorizedWei = String(BigInt(data.authorizedWei) + cost);
        data.pending = {id: String(id), hash: pending.hash, signedTransaction: pending.signedTransaction,
          nonce: String(pending.nonce), submittedAt: String(nowMs), lastBroadcastAt: '0',
          reimbursementWei: String(reimbursementWei), rebroadcastCount: 0,
          nextRebroadcastAt: '0', manualIntervention: false, manualReason: null};
        await state.save();
        return null;
      },
      async replacePending(hash, replacement, additionalCost) {
        if (data.pending?.hash !== hash) throw new Error('Pending hash mismatch');
        if (!/^0x[0-9a-f]{64}$/i.test(replacement.hash) ||
            !/^0x[0-9a-f]+$/i.test(replacement.signedTransaction) || additionalCost <= 0n) {
          throw new Error('Invalid replacement');
        }
        const entry = data.requests[data.pending.id];
        if (BigInt(entry.authorizedWei) + additionalCost > limits.requestWei) return 'replacement request spending cap';
        const projected = BigInt(data.authorizedWei) - BigInt(data.reimbursedWei) + additionalCost;
        if (projected - BigInt(data.pending.reimbursementWei ?? '0') > limits.totalWei) return 'replacement total spending cap';
        entry.authorizedWei = String(BigInt(entry.authorizedWei) + additionalCost);
        data.authorizedWei = String(BigInt(data.authorizedWei) + additionalCost);
        data.pending.previousHashes = [...(data.pending.previousHashes ?? []), hash];
        data.pending.hash = replacement.hash;
        data.pending.signedTransaction = replacement.signedTransaction;
        await state.save();
        return null;
      },
      async broadcasted(hash, now = BigInt(Date.now())) {
        if (data.pending?.hash !== hash) throw new Error('Pending hash mismatch');
        data.pending.lastBroadcastAt = String(unixMillis(now));
        await state.save();
      },
      async rebroadcasting(hash, nextRebroadcastAt, now = BigInt(Date.now())) {
        if (data.pending?.hash !== hash) throw new Error('Pending hash mismatch');
        data.pending.rebroadcastCount++;
        data.pending.lastBroadcastAt = String(unixMillis(now));
        data.pending.nextRebroadcastAt = String(unixMillis(nextRebroadcastAt));
        await state.save();
      },
      async requireManualIntervention(hash, reason) {
        if (data.pending?.hash !== hash) throw new Error('Pending hash mismatch');
        data.pending.manualIntervention = true;
        data.pending.manualReason = reason;
        await state.save();
      },
      async confirmed(hash, status = 1) {
        if (data.pending?.hash !== hash) throw new Error('Pending hash mismatch');
        if (status === 1) {
          const reimbursement = BigInt(data.pending.reimbursementWei ?? '0');
          const remaining = BigInt(data.authorizedWei) - BigInt(data.reimbursedWei);
          data.reimbursedWei = String(BigInt(data.reimbursedWei) + (reimbursement < remaining ? reimbursement : remaining));
        }
        data.pending = null;
        await state.save();
      },
      async close() {
        if (postgres) {
          try {
            await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [coordinationScope]);
          } finally {
            await client.end();
          }
        } else await rm(lock, {recursive: true, force: true});
      },
    };
    await state.save();
    return state;
  } catch (error) {
    if (postgres) await client.end().catch(() => {});
    else await rm(lock, {recursive: true, force: true});
    throw error;
  }
}
