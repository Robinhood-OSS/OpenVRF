import {keccak256} from 'ethers';

export function boundedSender({wallet, provider, state, maxGasPrice, receiptTimeoutMs = 60000,
  confirmations = 2}) {
  return async (id, transaction, gasFloor, reimbursementWei = 0n) => {
    const gasPrice = BigInt(await provider.send('eth_gasPrice', []));
    if (gasPrice <= 0n || gasPrice > maxGasPrice) return {paused: 'gas price cap'};
    if (BigInt(transaction.value ?? 0) !== 0n) throw new Error('Unexpected transaction value');
    const estimate = await provider.estimateGas({...transaction, from: wallet.address});
    const buffered = estimate * 13n / 10n + 30000n;
    const gasLimit = buffered > gasFloor ? buffered : gasFloor;
    const populated = await wallet.populateTransaction({...transaction, gasLimit, gasPrice, type: 0});
    const signed = await wallet.signTransaction(populated);
    const hash = keccak256(signed);
    const paused = await state.reserve(id, gasLimit * gasPrice,
      {hash, signedTransaction: signed, nonce: BigInt(populated.nonce)}, BigInt(Date.now()), reimbursementWei);
    if (paused) return {paused};
    // Broadcast errors are ambiguous: the RPC may have accepted the transaction before the
    // connection failed. Keep the exact signed bytes so reconciliation can safely rebroadcast it.
    try {
      await provider.broadcastTransaction(signed);
      await state.broadcasted(hash);
    } catch {
      return {hash, pending: true};
    }
    const receipt = await provider.waitForTransaction(hash, confirmations, receiptTimeoutMs).catch(() => null);
    if (!receipt) return {hash, pending: true};
    await state.confirmed(hash, receipt.status);
    return {hash, status: receipt.status};
  };
}

// Unresolved transaction
// |
// +-- Receipt found
// |   +-- Enough confirmations: confirm and continue
// |   +-- Not enough confirmations: wait
// +-- Request already completed
// |   +-- Mark superseded and continue
// +-- Confirmed nonce > stored nonce
// |   +-- Mark replaced, clear pending, retry request if needed
// +-- Nonce still unused
//     +-- Attempts remaining: identical rebroadcast plus backoff
//     +-- Limit reached: manual_intervention, stop broadcasting
//
// Resolve one uncertain submission without ever creating a second transaction. If the transaction
// vanished and its nonce is still unused, rebroadcasting identical signed bytes is idempotent.
export async function reconcilePending({wallet, provider, state, receiptTimeoutMs = 60000,
  confirmations = 2, allowBroadcast = true, isObsolete = async () => false,
  maxRebroadcasts = 5, rebroadcastBackoffMs = 30000, now = BigInt(Date.now())}) {
  const nowMs = typeof now === 'bigint' ? now : BigInt(now);
  const pending = state.data.pending;
  if (!pending) return {resolved: true};
  const receipt = await provider.getTransactionReceipt(pending.hash);
  if (receipt) {
    const observed = (await provider.getBlockNumber()) - receipt.blockNumber + 1;
    if (observed >= confirmations) {
      await state.confirmed(pending.hash, receipt.status);
      return {resolved: true, hash: pending.hash, status: receipt.status};
    }
    return {resolved: false, hash: pending.hash, reason: 'confirming', confirmations: observed};
  }
  // Sequencer RPCs may report a submitted transaction as pending even without exposing a
  // public peer-to-peer mempool. Retire it if another relayer already completed the request.
  if (await isObsolete(pending)) {
    await state.confirmed(pending.hash, 0);
    return {resolved: true, hash: pending.hash, status: 'superseded'};
  }
  let minedNonce;
  let nonce;
  if (pending.nonce !== null) {
    const head = await provider.getBlockNumber();
    const confirmedBlock = Math.max(0, head - confirmations + 1);
    minedNonce = BigInt(await provider.getTransactionCount(wallet.address, confirmedBlock));
    nonce = BigInt(pending.nonce);
    if (minedNonce > nonce) {
      await state.confirmed(pending.hash, 0);
      return {resolved: true, hash: pending.hash, status: 'replaced'};
    }
  }
  if (pending.manualIntervention) {
    return {resolved: false, hash: pending.hash, reason: `manual intervention: ${pending.manualReason}`};
  }
  if (await provider.getTransaction(pending.hash)) return {resolved: false, hash: pending.hash, reason: 'mempool'};
  if (!allowBroadcast) return {resolved: false, hash: pending.hash, reason: 'lease held by successor'};
  if (!pending.signedTransaction || pending.nonce === null) {
    return {resolved: false, hash: pending.hash, reason: 'legacy pending state'};
  }
  if (minedNonce < nonce) {
    await state.requireManualIntervention(pending.hash, 'confirmed nonce is below stored nonce');
    return {resolved: false, hash: pending.hash, reason: 'manual intervention: nonce gap'};
  }
  if (BigInt(pending.nextRebroadcastAt) > nowMs) {
    return {resolved: false, hash: pending.hash, reason: 'rebroadcast backoff'};
  }
  if (pending.rebroadcastCount >= maxRebroadcasts) {
    await state.requireManualIntervention(pending.hash, 'rebroadcast limit reached');
    return {resolved: false, hash: pending.hash, reason: 'manual intervention: rebroadcast limit reached'};
  }
  const delay = BigInt(Math.min(3600000, rebroadcastBackoffMs * 2 ** pending.rebroadcastCount));
  await state.rebroadcasting(pending.hash, nowMs + delay, nowMs);
  try {
    await provider.broadcastTransaction(pending.signedTransaction);
  } catch {
    return {resolved: false, hash: pending.hash, reason: 'rebroadcast rejected'};
  }
  const result = await provider.waitForTransaction(pending.hash, confirmations, receiptTimeoutMs).catch(() => null);
  if (!result) return {resolved: false, hash: pending.hash, reason: 'receipt pending'};
  await state.confirmed(pending.hash, result.status);
  return {resolved: true, hash: pending.hash, status: result.status};
}
