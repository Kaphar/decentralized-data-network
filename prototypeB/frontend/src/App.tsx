import { createSignal, createEffect, onCleanup } from 'solid-js';
import { PostList } from './components/PostList';
import { PostForm } from './components/PostForm';
import { Chat } from './components/Chat';
import { IdentityBadge } from './components/IdentityBadge';
import { PeerManager } from './components/PeerManager';
import { fetchWall, fetchIdentity, uploadBlob, signRecord, submitRecord } from './api';
import type { BaseRecord, IdentityInfo, BlobUploadResponse, SignedRecordResponse } from './types';

export default function App() {
  const [records, setRecords] = createSignal<BaseRecord[]>([]);
  const [identity, setIdentity] = createSignal<IdentityInfo | null>(null);
  const [initialLoad, setInitialLoad] = createSignal(true);
  const [refreshing, setRefreshing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

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
    const interval = setInterval(() => loadWall(true), 5000);
    onCleanup(() => clearInterval(interval));
  });

  return (
    <div class="app-container">
      <header class="app-header">
        <h1>Decentralized Data Network</h1>
        {identity() ? <IdentityBadge pubkey={identity()!.pubkey} /> : null}
      </header>

      {error() ? <div class="error-banner">{error()}</div> : null}

      <nav class="tabs">
        <a href="#" class="active">Wall</a>
        <a href="#">Chat</a>
        <a href="#">Peers</a>
      </nav>

      <main class="main-content">
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
      </main>

      <footer class="app-footer">
        <p>DDN Prototype B — Phase 0 (local dev node)</p>
      </footer>
    </div>
  );
}
