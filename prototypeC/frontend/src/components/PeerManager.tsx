import { Component, createSignal, createEffect, For, Show } from 'solid-js';
import { addPeer, fetchPeers, syncPeers } from '../api';
import type { PeerListResponse } from '../types';

export interface PeerManagerProps {
  onSync: () => void;
}

export const PeerManager: Component<PeerManagerProps> = (props) => {
  const [peerUrl, setPeerUrl] = createSignal('');
  const [peers, setPeers] = createSignal<string[]>([]);
  const [syncResult, setSyncResult] = createSignal<number | null>(null);
  const [loading, setLoading] = createSignal(false);

  const loadPeers = async () => {
    try {
      const data: PeerListResponse = await fetchPeers();
      setPeers(data.peers);
    } catch (e) {
      console.error('Failed to load peers:', e);
    }
  };

  const handleAddPeer = async () => {
    if (!peerUrl().trim()) return;
    try {
      await addPeer(peerUrl());
      setPeerUrl('');
      loadPeers();
    } catch (e) {
      console.error('Failed to add peer:', e);
    }
  };

  const handleSync = async () => {
    setLoading(true);
    setSyncResult(null);
    try {
      const result = await syncPeers();
      setSyncResult(result.added);
      props.onSync();
    } catch (e) {
      console.error('Failed to sync:', e);
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    loadPeers();
  });

  return (
    <div class="peer-manager">
      <h3 style={{ "font-size": "0.9rem", "color": "#aaa", "margin-bottom": "0.5rem" }}>Peers</h3>

      <div class="input-row">
        <input
          type="url"
          value={peerUrl()}
          oninput={(e) => setPeerUrl((e.target as HTMLInputElement).value)}
          placeholder="http://localhost:3000"
        />
        <button class="btn btn-secondary" onclick={handleAddPeer} disabled={!peerUrl().trim()}>
          Add
        </button>
      </div>

      <ul class="peer-list" style={{ "margin-top": "0.75rem" }}>
        <For each={peers()} fallback={<li style={{ "color": "#666", "font-style": "italic" }}>No peers added</li>}>
          {(p) => (
            <li>
              <span class="peer-badge">{p}</span>
            </li>
          )}
        </For>
      </ul>

      <button class="btn btn-primary" onclick={handleSync} disabled={loading()} style={{ "margin-top": "0.75rem" }}>
        {loading() ? 'Syncing...' : 'Sync'}
      </button>

      <Show when={syncResult() !== null}>
        <p style={{ "font-size": "0.8rem", "color": "#888", "margin-top": "0.5rem" }}>
          Added {syncResult()} record(s)
        </p>
      </Show>
    </div>
  );
};

