export interface BaseRecord {
  id: string;
  type: string;
  author: string;
  prev: string | null;
  ts: number;
  payload: RecordPayload;
  sig: string | null;
}

export type RecordPayload =
  | { text: string; media?: MediaRef[] }
  | { target_cid: string; text: string }
  | { target_cid: string; emoji: string }
  | { to: string; ciphertext: string; nonce: string; ephemeral_pubkey: string }
  | { target_user: string; file_name: string; size_bytes: number; ephemeral_pubkey: string }
  | { offer_cid: string; ephemeral_pubkey: string }
  | { target_cid: string; reason: string }
  | { target_cid: string; action: string; mod_pubkey: string }
  | { new_mod_pubkey: string; signed_by: string }
  | Record<string, unknown>;

export interface MediaRef {
  cid: string;
  mime: string;
  size: number;
}

export interface IdentityInfo {
  pubkey: string;
}

export interface BlobUploadResponse {
  cid: string;
}

export interface SignedRecordResponse {
  id: string;
  type: string;
  author: string;
  prev: string | null;
  ts: number;
  payload: RecordPayload;
  sig: string | null;
}

export interface SyncResponse {
  added: number;
}

export interface PeerAddRequest {
  url: string;
}

export interface PeerListResponse {
  peers: string[];
}

export interface RecordListEntry {
  id: string;
  type: string;
  author: string;
  ts: number;
}

export interface RecordListResponse {
  records: RecordListEntry[];
}

export interface WallResponse {
  posts: BaseRecord[];
}

export interface DmResponse {
  messages: BaseRecord[];
}
