import { createSignal, createEffect, onCleanup, Show } from 'solid-js';
import { PostList } from './components/PostList';
import { PostForm } from './components/PostForm';
import { Chat } from './components/Chat';
import { IdentityBadge } from './components/IdentityBadge';
import { PeerManager } from './components/PeerManager';
import { Network } from './components/Network';
import { KeyBackup } from './components/KeyBackup';
import { fetchWall, fetchIdentity, uploadBlob, signRecord, submitRecord, subscribeEvents } from './api';
import type { BaseRecord, IdentityInfo, WsEvent } from './types';

export default function App() {
  const [records, setRecords] = createSignal<BaseRecord[]>([]);
  const [identity, setIdentity] = createSignal<IdentityInfo | null>(null);
  const [initialLoad, setInitialLoad] = createSignal(true);
  const [refreshing, setRefreshing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [activeTab, setActiveTab] = createSignal('wall');
  const [wsConnected, setWsConnected] = createSignal(false);

  async function loadWall(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      const posts = await fetchWall();
      setRecords(posts);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      if (refresh) setRefreshing(false);
      setInitialLoad(false);
    }
  }

  async function loadIdentity() {
    try {
      const info = await fetchIdentity();
      setIdentity(info);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handlePostSubmit(text: string, mediaCids: { cid: string; mime: string; size: number }[]) {
    if (!identity()) return;
    const ts = Date.now();
    const payload = JSON.stringify({ text, media: mediaCids });
    try {
      const signed = await signRecord('post', identity()!.pubkey, null, ts, JSON.parse(payload));
      const result =       await submitRecord(signed);
      await loadWall();
    } catch (e) {

      setError(String(e));
    }
  }

  async function handleBlobUpload(file: File) {
    try {
      const cid = await uploadBlob(file);
      return cid;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }

  async function handleSync() {
    try {
      const resp = await fetch('/api/sync', { method: 'POST' });
      const data = await resp.json();
      await loadWall(true);
      return data.added;
    } catch (e) {
      setError(String(e));
      return 0;
    }
  }

  createEffect(() => {
    loadIdentity();
    loadWall();

    // Subscribe to live WebSocket events for real-time updates.
    const cleanup = subscribeEvents(
      (event: WsEvent) => {
        setWsConnected(true);
        if (event.type === 'gossip' || event.type === 'record') {
          const record = event.record;
          setRecords((prev) => {
            if (prev.some((r) => r.id === record.id)) return prev;
            return [...prev, record];
          });
        }
      },
      undefined,
      () => setWsConnected(false),
    );

    // Fallback: poll every 5s in case WS is unavailable.
    const interval = setInterval(() => {
      if (!wsConnected()) {
        loadWall(true);
      }
    }, 5000);

    onCleanup(() => {
      clearInterval(interval);
      cleanup();
    });
  });

  return (
    <div class="app-container">
      <header class="app-header">
        <h1>Decentralized Data Network</h1>
        {identity() ? <IdentityBadge pubkey={identity()!.pubkey} /> : null}
      </header>

      {error() ? <div class="error-banner">{error()}</div> : null}
      <Show when={wsConnected()}>
        <div class="ws-status">Live updates connected</div>
      </Show>

      <nav class="tabs">
        <a
          href="#"
          class={activeTab() === 'wall' ? 'active' : ''}
          onclick={() => setActiveTab('wall')}
        >
          Wall
        </a>
        <a href="#" class={activeTab() === 'network' ? 'active' : ''} onclick={() => setActiveTab('network')}>
          Network
        </a>
        <a href="#" class={activeTab() === 'chat' ? 'active' : ''} onclick={() => setActiveTab('chat')}>
          Chat
        </a>
        <a href="#" class={activeTab() === 'peers' ? 'active' : ''} onclick={() => setActiveTab('peers')}>
          Peers
        </a>
        <a href="#" class={activeTab() === 'backup' ? 'active' : ''} onclick={() => setActiveTab('backup')}>
          Backup
        </a>
      </nav>

      <main class="main-content">
        <Show when={activeTab() === 'network'}>
          <Network />
        </Show>

        <Show when={activeTab() === 'wall'}>
          <aside class="sidebar">
            <PostForm
              onSubmit={handlePostSubmit}
              onBlobUpload={handleBlobUpload}
            />
            <PeerManager onSync={handleSync} />
          </aside>
          <section class="feed">
            {initialLoad() ? (
              <div class="loading">Loading...</div>
            ) : (
              <>
                {refreshing() ? <div class="refresh-indicator">Updating...</div> : null}
                <PostList records={records()} />
              </>
            )}
          </section>
        </Show>

        <Show when={activeTab() === 'chat'}>
          <Chat records={records()} currentPubKey={identity()?.pubkey ?? ''} />
        </Show>

        <Show when={activeTab() === 'peers'}>
          <aside class="sidebar">
            <PeerManager onSync={handleSync} />
          </aside>
          <section class="feed">
            <PostList records={records()} />
          </section>
        </Show>

        <Show when={activeTab() === 'backup'}>
          <KeyBackup />
        </Show>
      </main>

      <footer class="app-footer">
        <p>DDN Prototype B — Phase 1 (libp2p P2P + WebSocket)</p>
      </footer>
    </div>
  );
}
