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
