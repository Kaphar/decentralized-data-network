import { createSignal, createEffect, onCleanup, Show } from 'solid-js';
import { PostList } from './components/PostList';
import { PostForm } from './components/PostForm';
import { Chat } from './components/Chat';
import { IdentityBadge } from './components/IdentityBadge';
import type { IdentityAction } from './components/IdentityBadge';
import { PeerManager } from './components/PeerManager';
import { Network } from './components/Network';
import { KeyBackup } from './components/KeyBackup';
import { IdentityManager } from './components/IdentityManager';
import type { IdentityAction as ManagerAction } from './components/IdentityManager';
import { Moderation } from './components/Moderation';
import { Communities } from './components/Communities';
import { FileTransfer } from './components/FileTransfer';
import {
  fetchWall,
  fetchIdentity,
  uploadBlob,
  signRecord,
  submitRecord,
  subscribeEvents,
  fetchModerationList,
  generateMediaKeypair,
  sendMediaOffer,
  sendMediaAccept,
  sendWebrtcSignal,
  postReaction,
  unlockIdentity,
  deleteIdentity,
  setApiBase,
  getApiBase,
  type MediaKeypair,
} from './api';
import type { BaseRecord, IdentityInfo, WsEvent, WsWebrtcSignalEvent, MediaRef } from './types';

export interface MediaOfferInfo {
  id: string;
  author: string;
  file_name: string;
  size_bytes: number;
  ephemeral_pubkey: string;
}

export type TransferState =
  | 'idle'
  | 'connecting'
  | 'waiting_for_answer'
  | 'transferring'
  | 'complete'
  | 'error';

export interface WebRTCSender {
  pc: RTCPeerConnection;
  file: File;
  dc: RTCDataChannel;
  keypair: MediaKeypair;
  offerId: string;
  answerReceived: boolean;
}

export interface WebRTCReceiver {
  pc: RTCPeerConnection;
  offer: MediaOfferInfo;
  keypair: MediaKeypair;
  state: TransferState;
  progress: number;
  error: string | null;
  blobUrl: string | null;
  answerSignaled: boolean;
}

const WEBRTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const CHUNK_SIZE = 64 * 1024;

function extractOfferFromRecord(record: BaseRecord): MediaOfferInfo | null {
  if (record.type !== 'media_offer') return null;
  const p = record.payload as Record<string, unknown>;
  if (typeof p !== 'object' || p === null) return null;
  return {
    id: record.id,
    author: record.author,
    file_name: p.file_name as string ?? 'unknown',
    size_bytes: (p.size_bytes as number) ?? 0,
    ephemeral_pubkey: p.ephemeral_pubkey as string ?? '',
  };
}

export default function App() {
  const [records, setRecords] = createSignal<BaseRecord[]>([]);
  const [identity, setIdentity] = createSignal<IdentityInfo | null>(null);
  const [initialLoad, setInitialLoad] = createSignal(true);
  const [refreshing, setRefreshing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [activeTab, setActiveTab] = createSignal('wall');
  const [settingsAction, setSettingsAction] = createSignal<ManagerAction>('export');
  const [wsConnected, setWsConnected] = createSignal(false);
  const [hiddenCids, setHiddenCids] = createSignal<string[]>([]);
  const [signalEvents, setSignalEvents] = createSignal<WsWebrtcSignalEvent[]>([]);
  const [useWebRTC, setUseWebRTC] = createSignal(true);
  const [nodeUrl, setNodeUrl] = createSignal(getApiBase() || '');

  const [webRTCSenders, setWebRTCSenders] = createSignal<Map<string, WebRTCSender>>(new Map());
  const [receivers, setReceivers] = createSignal<Map<string, WebRTCReceiver>>(new Map());

  const processedSignals = new Set<string>();

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

  async function handleUnlock(password: string) {
    try {
      const result = await unlockIdentity(password);
      setIdentity((prev) => prev ? { ...prev, locked: result.locked } : null);
      setError(null);
      await loadWall(true);
      await loadModerationStatus();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleReaction(targetCid: string, emoji: string) {
    if (!identity() || identity()!.locked) return;
    try {
      await postReaction(targetCid, emoji, identity()!.pubkey);
      await loadWall(true);
    } catch (e) {
      setError(String(e));
    }
  }

  function handleNodeUrlChange(url: string) {
    setNodeUrl(url);
    setApiBase(url);
    loadIdentity();
    loadWall(true);
    loadModerationStatus();
  }

  async function handleIdentityAction(action: IdentityAction) {
    switch (action) {
      case 'unlock':
      case 'export':
      case 'switch':
        setActiveTab('settings');
        setSettingsAction(action === 'switch' ? 'import' : 'export');
        break;
      case 'create': {
        if (!confirm('Create a new identity? This permanently replaces the current identity. A new one will be generated on next restart.')) return;
        try {
          await deleteIdentity();
          setError('Identity removed. Restart the node to generate a new identity.');
          setTimeout(() => setError(null), 5000);
          loadIdentity();
        } catch (e) {
          setError(String(e));
        }
        break;
      }
      case 'remove': {
        if (!confirm('Remove identity? A new one will be generated on next restart.')) return;
        try {
          await deleteIdentity();
          setError('Identity removed. Restart the node to generate a new identity.');
          setTimeout(() => setError(null), 5000);
          loadIdentity();
        } catch (e) {
          setError(String(e));
        }
        break;
      }
    }
  }

  async function loadModerationStatus() {
    try {
      const mod = await fetchModerationList();
      const allHidden = new Set<string>([
        ...mod.blocked_cids,
        ...mod.hidden_cids,
        ...Object.values(mod.communities ?? {}).flatMap((c) => [
          ...c.blocked_cids,
          ...c.hidden_cids,
        ]),
      ]);
      setHiddenCids([...allHidden]);
    } catch (e) {
      console.error('Failed to fetch moderation status:', e);
    }
  }

  async function handlePostSubmit(text: string, mediaCids: MediaRef[]) {
    const result = await handleSignAndSubmit(text, mediaCids);
    if (result !== null) {
      await loadWall();
    }
    return result;
  }

  async function handleSignAndSubmit(text: string, mediaCids: MediaRef[]): Promise<BaseRecord | null> {
    if (!identity()) return null;
    const ts = Date.now();
    const payload = JSON.stringify({ text, media: mediaCids });
    try {
      const signed = await signRecord('post', identity()!.pubkey, null, ts, JSON.parse(payload));
      await submitRecord(signed);
      return signed;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }

  async function handleMediaOffer(file: File): Promise<string | null> {
    try {
      const keypair = await generateMediaKeypair();
      const result = await sendMediaOffer(
        identity()!.pubkey,
        file.name,
        file.size,
        keypair.pubkey,
      );
      const offerId = result.id;

      const pc = new RTCPeerConnection(WEBRTC_CONFIG);

      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          sendWebrtcSignal({
            type: 'candidate',
            role: 'sender',
            target: identity()!.pubkey,
            session_id: offerId,
            data: JSON.stringify(evt.candidate),
          }).catch((e) => console.error('[webrtc] signal send failed:', e));
        }
      };

      const dc = pc.createDataChannel('ddn-file-transfer');

      dc.onopen = () => {
        console.log('[webrtc] sender data channel open');
        let offset = 0;

        const sendNext = () => {
          if (offset >= file.size) {
            dc.close();
            return;
          }
          const end = Math.min(offset + CHUNK_SIZE, file.size);
          dc.send(file.slice(offset, end));
          offset = end;
          setTimeout(sendNext, 0);
        };
        sendNext();
      };

      dc.onclose = () => {
        console.log('[webrtc] sender data channel closed');
      };

      const offer_sdp = await pc.createOffer();
      await pc.setLocalDescription(offer_sdp);

      if (pc.localDescription) {
        sendWebrtcSignal({
          type: 'offer',
          role: 'sender',
          target: identity()!.pubkey,
          session_id: offerId,
          data: JSON.stringify(pc.localDescription),
        }).catch((e) => console.error('[webrtc] offer send failed:', e));
      }

      setWebRTCSenders((prev) => {
        const copy = new Map(prev);
        copy.set(offerId, { pc, file, dc, keypair, offerId, answerReceived: false });
        return copy;
      });

      return offerId;
    } catch (e) {
      setError(String(e));
      return null;
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

  async function startReceive(offer: MediaOfferInfo) {
    try {
      const keypair = await generateMediaKeypair();
      await sendMediaAccept(offer.id, keypair.pubkey);

      const pc = new RTCPeerConnection(WEBRTC_CONFIG);

      const chunks: BlobPart[] = [];

      pc.ondatachannel = (evt) => {
        const dc = evt.channel;
        console.log('[webrtc] receiver data channel opened');

        dc.onmessage = (msg) => {
          chunks.push(msg.data);
          const receivedSize = chunks.reduce((sum, c) => {
            if (typeof c === 'string') return sum + c.length;
            if (c instanceof Blob) return sum + c.size;
            if (c instanceof ArrayBuffer) return sum + c.byteLength;
            return sum + (c as any).byteLength;
          }, 0);
          const progress = Math.min(100, (receivedSize / offer.size_bytes) * 100);

          setReceivers((prev) => {
            const copy = new Map(prev);
            const r = copy.get(offer.id);
            if (r) {
              r.state = 'transferring';
              r.progress = progress;
              copy.set(offer.id, r);
            }
            return copy;
          });
        };

        dc.onclose = () => {
          const blob = new Blob(chunks);
          const url = URL.createObjectURL(blob);
          console.log('[webrtc] transfer complete');

          setReceivers((prev) => {
            const copy = new Map(prev);
            const r = copy.get(offer.id);
            if (r) {
              r.state = 'complete';
              r.progress = 100;
              r.blobUrl = url;
              r.error = null;
              copy.set(offer.id, r);
            }
            return copy;
          });
        };

        dc.onerror = (evt) => {
          console.error('[webrtc] data channel error', evt);
          setReceivers((prev) => {
            const copy = new Map(prev);
            const r = copy.get(offer.id);
            if (r) {
              r.state = 'error';
              r.error = 'Data channel error';
              copy.set(offer.id, r);
            }
            return copy;
          });
        };
      };

      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          sendWebrtcSignal({
            type: 'candidate',
            role: 'receiver',
            target: offer.author,
            session_id: offer.id,
            data: JSON.stringify(evt.candidate),
          }).catch((e) => console.error('[webrtc] signal send failed:', e));
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log('[webrtc] ICE state:', pc.iceConnectionState);
      };

      setReceivers((prev) => {
        const copy = new Map(prev);
        copy.set(offer.id, {
          pc,
          offer,
          keypair,
          state: 'connecting',
          progress: 0,
          error: null,
          blobUrl: null,
          answerSignaled: false,
        });
        return copy;
      });
    } catch (e) {
      console.error('[webrtc] failed to start receive:', e);
      setError(String(e));
    }
  }

  // Process incoming WebRTC signaling messages.
  createEffect(() => {
    const sigs = signalEvents();
    const senders = webRTCSenders();
    const recvs = receivers();

    (async () => {
      for (const sig of sigs) {
        if (processedSignals.has(sig.data)) continue;

        let payload: any;
        try {
          payload = JSON.parse(atob(sig.data));
        } catch {
          continue;
        }

        if (payload.target !== identity()?.pubkey) continue;

        const sessionId = payload.session_id;
        const sender = senders.get(sessionId);
        const receiver = recvs.get(sessionId);

        const fromSender = payload.role === 'sender';
        const fromReceiver = payload.role === 'receiver';

        const shouldProcessBySender = sender && fromReceiver &&
          (payload.type === 'answer' || payload.type === 'candidate');

        const shouldProcessByReceiver = receiver && fromSender &&
          (payload.type === 'offer' || payload.type === 'candidate');

        if (!shouldProcessBySender && !shouldProcessByReceiver) continue;

        processedSignals.add(sig.data);

        if (sender && fromReceiver && payload.type === 'answer' && !sender.answerReceived) {
          try {
            await sender.pc.setRemoteDescription(JSON.parse(payload.data));
            sender.answerReceived = true;
          } catch (e) {
            console.error('[webrtc] setRemoteDescription failed:', e);
          }
        }

        if (sender && fromReceiver && payload.type === 'candidate') {
          try {
            sender.pc.addIceCandidate(JSON.parse(payload.data));
          } catch (e) {
            console.warn('[webrtc] addIceCandidate (sender) failed:', e);
          }
        }

        if (receiver && fromSender && payload.type === 'offer' && !receiver.answerSignaled) {
          try {
            await receiver.pc.setRemoteDescription(JSON.parse(payload.data));
            const answer = await receiver.pc.createAnswer();
            await receiver.pc.setLocalDescription(answer);

            if (receiver.pc.localDescription) {
              sendWebrtcSignal({
                type: 'answer',
                role: 'receiver',
                target: receiver.offer.author,
                session_id: sessionId,
                data: JSON.stringify(receiver.pc.localDescription),
              }).catch((e) => console.error('[webrtc] answer send failed:', e));
            }

            receiver.answerSignaled = true;
          } catch (e) {
            console.error('[webrtc] answer creation failed:', e);
          }
        }

        if (receiver && fromSender && payload.type === 'candidate') {
          try {
            receiver.pc.addIceCandidate(JSON.parse(payload.data));
          } catch (e) {
            console.warn('[webrtc] addIceCandidate (receiver) failed:', e);
          }
        }
      }
    })();
  });

  createEffect(() => {
    loadIdentity();
    loadWall();
    loadModerationStatus();

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
        if (event.type === 'webrtc_signal') {
          setSignalEvents((prev) => {
            if (prev.some((s) => s.data === event.data)) return prev;
            return [...prev, event];
          });
        }
      },
      undefined,
      () => setWsConnected(false),
    );

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
        <div class="node-url-selector">
          <input
            type="text"
            value={nodeUrl()}
            placeholder="http://localhost:3000 (empty = same origin)"
            oninput={(e) => handleNodeUrlChange((e.target as HTMLInputElement).value)}
          />
        </div>
      <Show when={identity()}>
        <IdentityBadge identity={identity()!} onAction={handleIdentityAction} />
      </Show>
      </header>

      <Show when={error()}>
        <div class="error-banner">{error()}</div>
      </Show>
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
        <a href="#" class={activeTab() === 'settings' ? 'active' : ''} onclick={() => setActiveTab('settings')}>
          Settings
        </a>
        <a href="#" class={activeTab() === 'moderation' ? 'active' : ''} onclick={() => setActiveTab('moderation')}>
          Moderation
        </a>
        <a href="#" class={activeTab() === 'communities' ? 'active' : ''} onclick={() => setActiveTab('communities')}>
          Communities
        </a>
         <a href="#" class={activeTab() === 'files' ? 'active' : ''} onclick={() => setActiveTab('files')}>
          Files
         </a>
       </nav>

      <main class="main-content">
        <Show when={activeTab() === 'network'}>
          <Network />
        </Show>

        <Show when={activeTab() === 'wall'}>
          <div class="wall-column">
            <PostForm
              onSubmit={handlePostSubmit}
              onBlobUpload={handleBlobUpload}
              onMediaOffer={handleMediaOffer}
              currentPubKey={identity()?.pubkey ?? ''}
              useWebRTC={useWebRTC()}
              onUseWebRTCChange={setUseWebRTC}
            />
            <PeerManager onSync={handleSync} />
            <Show when={initialLoad()} fallback={
              <>
                <Show when={refreshing()}>
                  <div class="refresh-indicator">Updating...</div>
                </Show>
                <PostList
                  records={records()}
                  hiddenCids={hiddenCids()}
                  currentPubKey={identity()?.pubkey ?? ''}
                  onReaction={handleReaction}
                  receivers={receivers()}
                  onReceiveOffer={startReceive}
                />
              </>
            }>
              <div class="loading">Loading...</div>
            </Show>
          </div>
        </Show>

        <Show when={activeTab() === 'chat'}>
          <Chat records={records()} currentPubKey={identity()?.pubkey ?? ''} onReaction={handleReaction} />
        </Show>

        <Show when={activeTab() === 'peers'}>
          <aside class="sidebar">
            <PeerManager onSync={handleSync} />
          </aside>
          <section class="feed">
            <PostList
              records={records()}
              hiddenCids={hiddenCids()}
              currentPubKey={identity()?.pubkey ?? ''}
              onReaction={handleReaction}
              receivers={receivers()}
              onReceiveOffer={startReceive}
            />
          </section>
        </Show>

        <Show when={activeTab() === 'settings'}>
          <div class="settings-view">
            <KeyBackup />
            <IdentityManager
              currentPubKey={identity()?.pubkey ?? ''}
              locked={identity()?.locked ?? false}
              autoUnlock={identity()?.auto_unlock}
              defaultAction={settingsAction()}
              onUnlock={handleUnlock}
              onIdentityDeleted={() => {
                setIdentity(null);
                loadIdentity();
              }}
              onIdentityImported={() => {
                loadIdentity();
              }}
            />
          </div>
        </Show>

        <Show when={activeTab() === 'moderation'}>
          <Moderation records={records()} />
        </Show>

        <Show when={activeTab() === 'communities'}>
          <Communities records={records()} currentPubKey={identity()?.pubkey ?? ''} />
        </Show>

        <Show when={activeTab() === 'files'}>
          <FileTransfer
            records={records()}
            currentPubKey={identity()?.pubkey ?? ''}
            receivers={receivers()}
            onReceiveOffer={startReceive}
          />
        </Show>
      </main>

      <footer class="app-footer">
        <p>DDN Prototype B â€” Phase 4 (Reactions) + Phase 5 (Identity Persistence) + Phase 6.2 (Community Model)</p>
      </footer>
    </div>
  );
}
