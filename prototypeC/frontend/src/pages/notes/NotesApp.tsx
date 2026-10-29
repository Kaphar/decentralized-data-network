import { Component, createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import { resolveUrl, sealDm, openDm, signRecord, submitRecord } from '../../api';
import type { BaseRecord } from '../../types';

interface Note {
  id: string;
  author: string;
  ts: number;
  payload: Record<string, unknown>;
  ciphertext: string;
  nonce: string;
  ephemeral_pubkey: string;
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const resp = await fetch(resolveUrl(path), {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${txt}`);
  }
  return resp.json() as Promise<T>;
}

export const NotesApp: Component = () => {
  const [currentPubKey, setCurrentPubKey] = createSignal('');
  const [notes, setNotes] = createSignal<Note[]>([]);
  const [decryptedNotes, setDecryptedNotes] = createSignal<Map<string, string>>(new Map());
  const [noteText, setNoteText] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [decryptionDone, setDecryptionDone] = createSignal(false);
  const [creating, setCreating] = createSignal(false);

  async function loadIdentity() {
    try {
      const info = await api<{ pubkey: string; locked: boolean }>('/api/identity');
      setCurrentPubKey(info.pubkey);
      if (info.locked) {
        setError('Identity is locked — unlock first.');
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadNotes() {
    setLoading(true);
    try {
      const records = await api<{ posts: BaseRecord[] }>('/api/wall');
      const noteRecords = records.posts
        .filter((r) => r.type === 'post')
        .map((r): Note | null => {
          const p = r.payload as Record<string, unknown>;
          if (p.dapp !== 'notes') return null;
          const ciphertext = p.ciphertext as string;
          const nonce = p.nonce as string;
          const ephemeral_pubkey = p.ephemeral_pubkey as string;
          if (!ciphertext || !nonce || !ephemeral_pubkey) return null;
          return {
            id: r.id,
            author: r.author,
            ts: r.ts,
            payload: p,
            ciphertext,
            nonce,
            ephemeral_pubkey,
          };
        })
        .filter((n): n is Note => n !== null);
      setNotes(noteRecords);
      setDecryptedNotes(new Map());
      setDecryptionDone(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function decryptAllNotes() {
    const newMap = new Map<string, string>();
    for (const note of notes()) {
      try {
        const plaintext = await openDm(
          note.ciphertext,
          note.nonce,
          note.ephemeral_pubkey,
          note.author,
        );
        newMap.set(note.id, plaintext);
      } catch (e) {
        newMap.set(note.id, '[decryption failed]');
      }
    }
    setDecryptedNotes(newMap);
    setDecryptionDone(true);
  }

  async function createNote() {
    const text = noteText().trim();
    if (!text || !currentPubKey()) return;
    setCreating(true);
    setError(null);
    try {
      const sealed = await sealDm(currentPubKey(), currentPubKey(), text);
      const ts = Date.now();
      const payload = {
        dapp: 'notes',
        text: 'encrypted',
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        ephemeral_pubkey: sealed.ephemeral_pubkey,
      };
      const signed = await api<{
        id: string;
        author: string;
        sig: string;
        type: string;
      }>('/api/record/sign', {
        method: 'POST',
        body: JSON.stringify({
          type: 'post',
          author: currentPubKey(),
          prev: null,
          ts,
          payload,
        }),
      });
      await api('/api/record', {
        method: 'POST',
        body: JSON.stringify({
          id: signed.id,
          type: signed.type,
          author: signed.author,
          prev: null,
          ts,
          payload,
          sig: signed.sig,
        }),
      });
      setNoteText('');
      await loadNotes();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  createEffect(() => {
    loadIdentity();
    const iv = setInterval(loadIdentity, 10000);
    onCleanup(() => clearInterval(iv));
  });

  createEffect(() => {
    if (notes().length > 0 && !decryptionDone()) {
      decryptAllNotes();
    }
  });

  function fmtTs(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  function truncate(s: string, n = 12): string {
    if (!s) return '';
    return s.length <= n ? s : `${s.slice(0, n)}…${s.slice(-n)}`;
  }

  return (
    <div class="notes-app">
      <h3>Private Notes (encrypted client-side)</h3>
      <p class="text-muted" style={{ 'font-size': '0.8rem' }}>
        Notes are encrypted with X25519 + AES-GCM before leaving the browser.
        The node only ever sees ciphertext.
      </p>

      <Show when={error()}>
        <div class="error-banner">{error()}</div>
      </Show>

      <Show when={!loading()}>
        <div class="form-group">
          <textarea
            value={noteText()}
            oninput={(e) => setNoteText((e.target as HTMLTextAreaElement).value)}
            placeholder="Write a private note..."
            rows={4}
            style={{ 'width': '100%', 'margin-bottom': '0.5rem' }}
          />
          <button
            class="btn"
            onClick={createNote}
            disabled={creating() || !noteText().trim() || !currentPubKey()}
          >
            {creating() ? 'Saving…' : 'Save Encrypted Note'}
          </button>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="loading">Loading notes…</div>
      </Show>

      <Show when={!loading() && notes().length === 0 && !error()}>
        <p class="text-muted">No notes found. Create one above.</p>
      </Show>

      <Show when={!loading() && notes().length > 0}>
        <For each={notes()}>
          {(note) => {
            const decrypted = decryptedNotes().get(note.id) ?? '[decrypting…]';
            return (
              <div class="note-card">
                <div class="note-timestamp">{fmtTs(note.ts)}</div>
                <div class="note-text">{decrypted}</div>
                <div class="note-meta">
                  <span class="monospace">author: {truncate(note.author, 16)}</span>
                </div>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
};
