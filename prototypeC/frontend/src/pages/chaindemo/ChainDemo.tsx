import { Component, createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import { fetchIdentity, signRecord, submitRecord, fetchLatestBlock, fetchValidators, fetchBlock, anchorRecord } from '../../api';
import type { ChainBlock } from '../../types';

function truncate(s: string, n = 12): string {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n)}…${s.slice(-n)}`;
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

export const ChainDemo: Component = () => {
  const [latestBlock, setLatestBlock] = createSignal<ChainBlock | null>(null);
  const [validators, setValidators] = createSignal<string[]>([]);
  const [allBlocks, setAllBlocks] = createSignal<ChainBlock[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [loadingHistory, setLoadingHistory] = createSignal(false);

  const loadLatest = async () => {
    try {
      const data = await fetchLatestBlock();
      setLatestBlock(data);
    } catch (e) {
      setError(String(e));
    }
  };

  const loadValidators = async () => {
    try {
      const data = await fetchValidators();
      setValidators(data);
    } catch (e) {
      setError(String(e));
    }
  };

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const latest = await fetchLatestBlock();
      const height = latest.header.height;
      const blocks: ChainBlock[] = [];
      for (let h = height; h >= 0; h--) {
        const data = await fetchBlock(h);
        if (data) blocks.push(data);
      }
      setAllBlocks(blocks);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingHistory(false);
    }
  };

  createEffect(() => {
    loadLatest();
    loadValidators();
    const iv = setInterval(loadLatest, 5000);
    onCleanup(() => clearInterval(iv));
  });

  const submitAnchor = async () => {
    setLoading(true);
    setError(null);
    try {
      const identity = await fetchIdentity();
      if (identity.locked) throw new Error('Identity is locked — unlock first.');

      const ts = Date.now();
      const payload = { text: 'Direct blockchain anchor test', dapp: 'blockchain-demo' };
      const signed = await signRecord('post', identity.pubkey, null, ts, payload);

      const submitted = await submitRecord(signed);

      if (!signed.sig) throw new Error('Signed record has no signature');

      const result = await anchorRecord({
        author: signed.author,
        record_cid: submitted.id,
        ts: Math.floor(ts / 1000),
        sig: signed.sig,
      });

      setError(`✓ Anchored record ${truncate(submitted.id)} into the chain. ${result.status}`);
      setTimeout(() => {
        loadLatest();
      }, 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="chain-demo">
      <h3>Blockchain Anchor Chain (Standalone)</h3>
      <p class="text-muted">
        This tab interacts with the anchor chain directly. Each anchor tx stores a
        reference (CID) to a DDN record; the full message lives in the CAS wall, the
        block only proves it existed at this height.
      </p>

      <Show when={error()}>
        <div class="error-banner">{error()}</div>
      </Show>

      <div class="chain-section">
        <h4>Latest Block</h4>
        <Show when={latestBlock()} fallback={<div class="loading">Loading…</div>}>
          {(b) => (
            <div class="block-info-grid">
              <div class="grid-row"><span class="label">Height</span><span class="value">{b().header.height}</span></div>
              <div class="grid-row"><span class="label">Hash</span><span class="value monospace">{b().header.hash}</span></div>
              <div class="grid-row"><span class="label">Parent</span><span class="value monospace">{b().header.parent_hash}</span></div>
              <div class="grid-row"><span class="label">Proposer</span><span class="value monospace">{truncate(b().header.proposer, 16)}</span></div>
              <div class="grid-row"><span class="label">Timestamp</span><span class="value">{fmtTs(b().header.timestamp)}</span></div>
              <div class="grid-row"><span class="label">Merkle Root</span><span class="value monospace">{b().header.merkle_root}</span></div>
              <div class="grid-row"><span class="label">Nonce</span><span class="value">{b().header.nonce}</span></div>
              <div class="grid-row"><span class="label">Tx count</span><span class="value">{b().txs.length}</span></div>
            </div>
          )}
        </Show>
      </div>

      <div class="chain-section">
        <Show when={true}>
          <button class="btn" onClick={submitAnchor} disabled={loading()}>
            {loading() ? 'Anchoring…' : 'Anchor a New Message to the Chain'}
          </button>
        </Show>
      </div>

      <div class="chain-section">
        <div class="form-row">
          <button class="btn btn-secondary" onClick={loadHistory} disabled={loadingHistory()}>
            {loadingHistory() ? 'Loading…' : 'Load Full Chain History'}
          </button>
        </div>
        <Show when={allBlocks().length > 0}>
          <For each={allBlocks()}>
            {(block) => (
              <div class="block-info" style={{ 'margin-bottom': '0.5rem' }}>
                <div><strong>Block {block.header.height}</strong> · <span class="monospace">{truncate(block.header.hash, 14)}</span></div>
                <div class="text-muted" style={{ 'font-size': '0.8rem' }}>
                  {fmtTs(block.header.timestamp)} · proposer {truncate(block.header.proposer, 16)} · {block.txs.length} tx(s)
                </div>
                <For each={block.txs}>
                  {(tx) => (
                    <div class="tx-item-compact">
                      ⏺ cid={truncate(tx.record_cid, 16)} author={truncate(tx.author, 12)} ts={tx.ts}
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="chain-section">
        <h4>Validators</h4>
        <For each={validators()} fallback={<div>No validators</div>}>
          {(v) => <div class="validator-item">{truncate(v, 24)}</div>}
        </For>
      </div>
    </div>
  );
};
