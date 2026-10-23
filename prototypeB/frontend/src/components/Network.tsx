import { Component, createSignal, createEffect, For, Show } from 'solid-js';
import { fetchNetworkStatus, connectToPeer } from '../api';
import type { NetworkStatus } from '../types';

export const Network: Component = () => {
  const [status, setStatus] = createSignal<NetworkStatus | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [connecting, setConnecting] = createSignal(false);
  const [connectError, setConnectError] = createSignal<string | null>(null);
  const [connectInput, setConnectInput] = createSignal('');

  const loadStatus = async () => {
    try {
      const data = await fetchNetworkStatus();
      setStatus(data);
      setConnectError(null);
    } catch (e) {
      setConnectError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    const addr = connectInput().trim();
    if (!addr) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await connectToPeer(addr);
      await loadStatus();
    } catch (e) {
      setConnectError(String(e));
    } finally {
      setConnecting(false);
      setConnectInput('');
    }
  };

  createEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  });

  const copyPeerId = () => {
    const id = status()?.peer_id;
    if (id) {
      navigator.clipboard.writeText(id);
    }
  };

  return (
    <div class="network-view">
      <h3>Network Status</h3>

      {loading() ? (
        <div class="loading">Loading network info...</div>
      ) : status() ? (
        <>
          <div class="info-row">
            <span class="label">P2P Enabled:</span>
            <span class={status()!.enabled ? 'text-ok' : 'text-warn'}>
              {status()!.enabled ? 'Yes' : 'No'}
            </span>
          </div>

          {status()!.peer_id && (
            <div class="info-row">
              <span class="label">Peer ID:</span>
              <span class="monospace" title={status()!.peer_id}>
                <button class="btn btn-tiny" onclick={copyPeerId}>
                  {status()!.peer_id!.slice(0, 12)}...{status()!.peer_id!.slice(-12)}
                </button>
              </span>
            </div>
          )}

          {status()!.listen_addrs && status()!.listen_addrs!.length > 0 && (
            <div class="info-row">
              <span class="label">Listen Addresses:</span>
              <ul class="addr-list">
                <li class="monospace">{status()!.listen_addrs![0]}</li>
              </ul>
            </div>
          )}

          {status()!.topic && (
            <div class="info-row">
              <span class="label">Topic:</span>
              <span class="monospace">{status()!.topic}</span>
            </div>
          )}

          <div class="info-row">
            <span class="label">Connected Peers:</span>
            <span>{status()!.connected_peers?.length ?? 0}</span>
            {status()!.connected_peers && status()!.connected_peers!.length > 0 && (
              <ul class="peer-sublist">
                <For each={status()!.connected_peers}>
                  {(p) => <li class="monospace">{p}</li>}
                </For>
              </ul>
            )}
          </div>

          {status()!.reason && (
            <div class="info-row">
              <span class="label">Note:</span>
              <span class="text-warn">{status()!.reason}</span>
            </div>
          )}

          {status()!.manual_peers && status()!.manual_peers!.length > 0 && (
            <div class="info-row">
              <span class="label">Manual Peers:</span>
              <ul class="peer-sublist">
                <For each={status()!.manual_peers}>
                  {(p) => <li>{p}</li>}
                </For>
              </ul>
            </div>
          )}
        </>
      ) : (
        <div class="error-banner">Failed to load network status</div>
      )}

      <div class="form-group">
        <input
          type="text"
          value={connectInput()}
          oninput={(e) => setConnectInput((e.target as HTMLInputElement).value)}
          placeholder="/ip4/127.0.0.1/tcp/4001/p2p/12D3KooW..."
        />
        <button
          class="btn btn-secondary"
          onclick={handleConnect}
          disabled={connecting() || !connectInput()?.trim()}
        >
          {connecting() ? 'Connecting...' : 'Connect'}
        </button>
      </div>

      <Show when={connectError()}>
        <div class="error-banner">{connectError()}</div>
      </Show>
    </div>
  );
};
