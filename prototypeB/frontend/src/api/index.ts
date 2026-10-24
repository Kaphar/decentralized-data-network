import type {
  IdentityInfo,
  BlobUploadResponse,
  SignedRecordResponse,
  WallResponse,
  PeerListResponse,
  SyncResponse,
  RecordListResponse,
  BaseRecord,
  NetworkStatus,
  WsEvent,
  IdentityFile,
  SealDmResponse,
  OpenDmResponse,
  CommunityCreateRequest,
  CommunityMembershipRequest,
  ModerationResponse,
} from '../types';

function getStoredApiBase(): string {
  if (typeof window !== 'undefined') {
    return window.localStorage.getItem('ddn_node_url') || '';
  }
  return '';
}

let apiBase: string = getStoredApiBase();

export function setApiBase(url: string): void {
  apiBase = url.replace(/\/+$/, '');
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('ddn_node_url', apiBase);
  }
}

export function getApiBase(): string {
  return apiBase;
}

function resolveUrl(path: string): string {
  const base = getApiBase();
  return base ? `${base}${path}` : path;
}

function resolveWsUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  const base = getApiBase();
  if (!base) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${path}`;
  }
  let wsBase = base;
  if (wsBase.startsWith('http://')) {
    wsBase = 'ws://' + wsBase.slice(7);
  } else if (wsBase.startsWith('https://')) {
    wsBase = 'wss://' + wsBase.slice(8);
  }
  return `${wsBase}${path}`;
}

export async function fetchIdentity(): Promise<IdentityInfo> {
  const resp = await fetch(resolveUrl('/api/identity'));
  if (!resp.ok) throw new Error('Failed to fetch identity');
  return resp.json();
}

export async function backupIdentity(password: string): Promise<IdentityFile> {
  const resp = await fetch(resolveUrl('/api/identity/backup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to backup identity');
  }
  return resp.json();
}

export async function exportIdentity(password: string): Promise<IdentityFile> {
  const resp = await fetch(resolveUrl('/api/identity/export'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to export identity');
  }
  return resp.json();
}

export async function unlockIdentity(password: string): Promise<{ pubkey: string; locked: boolean }> {
  const resp = await fetch(resolveUrl('/api/identity/unlock'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to unlock identity');
  }
  return resp.json();
}

export async function importIdentity(
  file: IdentityFile,
  password: string,
): Promise<{ status: string; pubkey: string; requires_restart: boolean }> {
  const resp = await fetch(resolveUrl('/api/identity/import'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, password }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to import identity');
  }
  return resp.json();
}

export async function deleteIdentity(): Promise<{ status: string; requires_restart: boolean }> {
  const resp = await fetch(resolveUrl('/api/identity'), {
    method: 'DELETE',
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to delete identity');
  }
  return resp.json();
}

export async function uploadBlob(file: File): Promise<string> {
  const resp = await fetch(resolveUrl('/api/blob'), {
    method: 'POST',
    body: file,
  });
  if (!resp.ok) throw new Error('Failed to upload blob');
  const data: BlobUploadResponse = await resp.json();
  return data.cid;
}

export async function signRecord(
  typeStr: string,
  author: string,
  prev: string | null,
  ts: number,
  payload: unknown,
): Promise<BaseRecord> {
  const resp = await fetch(resolveUrl('/api/record/sign'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: typeStr, author, prev, ts, payload }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to sign record');
  }
  return resp.json();
}

export async function submitRecord(record: BaseRecord): Promise<{ id: string }> {
  const resp = await fetch(resolveUrl('/api/record'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to submit record');
  }
  return resp.json();
}

export async function postReaction(
  targetCid: string,
  emoji: string,
  author: string,
): Promise<{ id: string }> {
  const ts = Date.now();
  const signed = await signRecord('reaction', author, null, ts, { target_cid: targetCid, emoji });
  return submitRecord(signed);
}

export async function fetchWall(): Promise<BaseRecord[]> {
  const resp = await fetch(resolveUrl('/api/wall'));
  if (!resp.ok) throw new Error('Failed to fetch wall');
  const data: WallResponse = await resp.json();
  return data.posts;
}

export async function fetchRecord(id: string): Promise<BaseRecord> {
  const resp = await fetch(resolveUrl(`/api/record/${id}`));
  if (!resp.ok) throw new Error('Failed to fetch record');
  return resp.json();
}

export async function listRecords(): Promise<RecordListResponse> {
  const resp = await fetch(resolveUrl('/api/records'));
  if (!resp.ok) throw new Error('Failed to fetch records');
  return resp.json();
}

export async function addPeer(url: string): Promise<{ added: string }> {
  const resp = await fetch(resolveUrl('/api/peers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!resp.ok) throw new Error('Failed to add peer');
  return resp.json();
}

export async function fetchPeers(): Promise<PeerListResponse> {
  const resp = await fetch(resolveUrl('/api/peers'));
  if (!resp.ok) throw new Error('Failed to fetch peers');
  return resp.json();
}

export async function syncPeers(): Promise<SyncResponse> {
  const resp = await fetch(resolveUrl('/api/sync'), { method: 'POST' });
  if (!resp.ok) throw new Error('Failed to sync');
  return resp.json();
}

export function downloadJson(filename: string, json: string) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function fetchNetworkStatus(): Promise<NetworkStatus> {
  const resp = await fetch(resolveUrl('/api/network'));
  if (!resp.ok) throw new Error('Failed to fetch network status');
  return resp.json();
}

export async function connectToPeer(multiaddr: string): Promise<void> {
  const resp = await fetch(
    resolveUrl(`/api/network/connect?addr=${encodeURIComponent(multiaddr)}`),
    { method: 'POST' },
  );
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to connect');
  }
}

export async function sealDm(
  author: string,
  to: string,
  plaintext: string,
): Promise<SealDmResponse> {
  const resp = await fetch(resolveUrl('/api/dm/seal'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author, to, plaintext }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to encrypt DM');
  }
  return resp.json();
}

export async function openDm(
  ciphertext: string,
  nonce: string,
  ephemeral_pubkey: string,
  sender: string,
): Promise<string> {
  const resp = await fetch(resolveUrl('/api/dm/open'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciphertext, nonce, ephemeral_pubkey, sender }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to decrypt DM');
  }
  const data: OpenDmResponse = await resp.json();
  return data.plaintext;
}

export async function sendMediaOffer(
  to: string,
  file_name: string,
  size_bytes: number,
  ephemeral_pubkey: string,
): Promise<{ id: string }> {
  const resp = await fetch(resolveUrl('/api/media/offer'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: to, file_name, size_bytes, ephemeral_pubkey }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to send media offer');
  }
  return resp.json();
}

export async function sendMediaAccept(
  offer_cid: string,
  ephemeral_pubkey: string,
): Promise<{ id: string }> {
  const resp = await fetch(resolveUrl('/api/media/accept'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offer_cid, ephemeral_pubkey }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to send media accept');
  }
  return resp.json();
}

export interface WebrtcSignalRequest {
  payload: string;
}

export interface WebrtcSignalPayload {
  type: 'offer' | 'answer' | 'candidate';
  role: 'sender' | 'receiver';
  target: string;
  session_id: string;
  data: string;
}

export async function sendWebrtcSignal(payload: WebrtcSignalPayload): Promise<void> {
  const resp = await fetch(resolveUrl('/api/webrtc/signal'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: btoa(JSON.stringify(payload)) }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to send signal');
  }
}

export interface MediaKeypair {
  pubkey: string;
  secret: string;
}

export async function reportContent(target_cid: string, reason: string): Promise<{ id: string }> {
  const resp = await fetch(resolveUrl('/api/report'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_cid, reason }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to report content');
  }
  return resp.json();
}

export async function fetchModerationList(): Promise<ModerationResponse> {
  const resp = await fetch(resolveUrl('/api/moderation'));
  if (!resp.ok) throw new Error('Failed to fetch moderation list');
  return resp.json();
}

export async function fetchCommunities(): Promise<BaseRecord[]> {
  const resp = await fetch(resolveUrl('/api/community'));
  if (!resp.ok) throw new Error('Failed to fetch communities');
  const data: { communities: BaseRecord[] } = await resp.json();
  return data.communities;
}

export async function createCommunity(
  name: string,
  description: string,
): Promise<{ id: string; record: BaseRecord }> {
  const resp = await fetch(resolveUrl('/api/community'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to create community');
  }
  return resp.json();
}

export async function promoteCommunityModerator(
  community_cid: string,
  target_pubkey: string,
  role: string,
): Promise<{ id: string; record: BaseRecord }> {
  const resp = await fetch(resolveUrl('/api/community/membership'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ community_cid, target_pubkey, role }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to promote community moderator');
  }
  return resp.json();
}

export async function createCommunityModAction(
  community_cid: string,
  target_cid: string,
  action: 'hide' | 'nuke',
  mod_pubkey: string,
): Promise<{ id: string }> {
  const ts = Date.now();
  const signed = await signRecord(
    'mod_action',
    mod_pubkey,
    null,
    ts,
    {
      target_cid,
      action,
      mod_pubkey,
      community_cid,
    },
  );
  return submitRecord(signed);
}

export interface MediaKeypair {
  pubkey: string;
  secret: string;
}

export async function generateMediaKeypair(): Promise<MediaKeypair> {
  const resp = await fetch(resolveUrl('/api/media/keypair'), { method: 'POST' });
  if (!resp.ok) throw new Error('Failed to generate keypair');
  return resp.json();
}

export function subscribeEvents(
  onEvent: (event: WsEvent) => void,
  onError?: (err: Event) => void,
  onClose?: () => void,
): () => void {
  const wsUrl = resolveWsUrl('/ws/events');
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[ws] connected to /ws/events');
  };

  ws.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as WsEvent;
      onEvent(event);
    } catch (e) {
      console.error('[ws] parse error:', e);
    }
  };

  ws.onerror = (err) => {
    console.error('[ws] error:', err);
    onError?.(err);
  };

  ws.onclose = () => {
    console.log('[ws] disconnected');
    onClose?.();
  };

  return () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };
}
