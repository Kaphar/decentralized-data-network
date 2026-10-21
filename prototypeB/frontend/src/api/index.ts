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
} from '../types';

const API_BASE = '';

export async function fetchIdentity(): Promise<IdentityInfo> {
  const resp = await fetch(`${API_BASE}/api/identity`);
  if (!resp.ok) throw new Error('Failed to fetch identity');
  return resp.json();
}

export async function backupIdentity(password: string): Promise<IdentityFile> {
  const resp = await fetch(`${API_BASE}/api/identity/backup`, {
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
  const resp = await fetch(`${API_BASE}/api/identity/export`, {
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
  const resp = await fetch(`${API_BASE}/api/identity/unlock`, {
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
  const resp = await fetch(`${API_BASE}/api/identity/import`, {
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
  const resp = await fetch(`${API_BASE}/api/identity`, {
    method: 'DELETE',
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to delete identity');
  }
  return resp.json();
}

export async function uploadBlob(file: File): Promise<string> {
  const resp = await fetch(`${API_BASE}/api/blob`, {
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
  const resp = await fetch(`${API_BASE}/api/record/sign`, {
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
  const resp = await fetch(`${API_BASE}/api/record`, {
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
  const resp = await fetch(`${API_BASE}/api/wall`);
  if (!resp.ok) throw new Error('Failed to fetch wall');
  const data: WallResponse = await resp.json();
  return data.posts;
}

export async function fetchRecord(id: string): Promise<BaseRecord> {
  const resp = await fetch(`${API_BASE}/api/record/${id}`);
  if (!resp.ok) throw new Error('Failed to fetch record');
  return resp.json();
}

export async function listRecords(): Promise<RecordListResponse> {
  const resp = await fetch(`${API_BASE}/api/records`);
  if (!resp.ok) throw new Error('Failed to fetch records');
  return resp.json();
}

export async function addPeer(url: string): Promise<{ added: string }> {
  const resp = await fetch(`${API_BASE}/api/peers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!resp.ok) throw new Error('Failed to add peer');
  return resp.json();
}

export async function fetchPeers(): Promise<PeerListResponse> {
  const resp = await fetch(`${API_BASE}/api/peers`);
  if (!resp.ok) throw new Error('Failed to fetch peers');
  return resp.json();
}

export async function syncPeers(): Promise<SyncResponse> {
  const resp = await fetch(`${API_BASE}/api/sync`, { method: 'POST' });
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
  const resp = await fetch(`${API_BASE}/api/network`);
  if (!resp.ok) throw new Error('Failed to fetch network status');
  return resp.json();
}

export async function connectToPeer(multiaddr: string): Promise<void> {
  const resp = await fetch(
    `${API_BASE}/api/network/connect?addr=${encodeURIComponent(multiaddr)}`,
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
  const resp = await fetch(`${API_BASE}/api/dm/seal`, {
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
  const resp = await fetch(`${API_BASE}/api/dm/open`, {
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
  const resp = await fetch(`${API_BASE}/api/media/offer`, {
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
  const resp = await fetch(`${API_BASE}/api/media/accept`, {
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
  const resp = await fetch(`${API_BASE}/api/webrtc/signal`, {
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
  const resp = await fetch(`${API_BASE}/api/report`, {
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

export async function fetchModerationList(): Promise<{ blocked_cids: string[]; hidden_cids: string[]; mod_pubkeys: string[] }> {
  const resp = await fetch(`${API_BASE}/api/moderation`);
  if (!resp.ok) throw new Error('Failed to fetch moderation list');
  return resp.json();
}

export interface MediaKeypair {
  pubkey: string;
  secret: string;
}

export async function generateMediaKeypair(): Promise<MediaKeypair> {
  const resp = await fetch(`${API_BASE}/api/media/keypair`, { method: 'POST' });
  if (!resp.ok) throw new Error('Failed to generate keypair');
  return resp.json();
}

export function subscribeEvents(
  onEvent: (event: WsEvent) => void,
  onError?: (err: Event) => void,
  onClose?: () => void,
): () => void {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsBase = `${proto}//${window.location.host}`;
  const ws = new WebSocket(`${wsBase}/ws/events`);

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
