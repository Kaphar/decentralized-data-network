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
  | { target_cid: string; action: string; mod_pubkey: string; community_cid?: string; duration_secs?: number }
  | { new_mod_pubkey: string; signed_by: string }
  | { name: string; description: string; creator: string }
  | { community_cid: string; target_pubkey: string; role: string }
  | Record<string, unknown>;

export interface MediaRef {
  cid: string;
  mime: string;
  size: number;
  isOffer?: boolean;
}

export interface IdentityInfo {
  pubkey: string;
  locked: boolean;
  auto_unlock?: boolean;
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

export interface NetworkStatus {
  enabled: boolean;
  peer_id?: string;
  listen_addrs?: string[];
  topic?: string;
  connected_peers?: string[];
  manual_peers?: string[];
  reason?: string;
}

export interface WsHelloEvent {
  type: 'hello';
  pubkey: string;
  peer_id?: string;
}

export interface WsGossipEvent {
  type: 'gossip';
  source: string;
  record: BaseRecord;
}

export interface WsRecordEvent {
  type: 'record';
  record: BaseRecord;
}

export interface WsWebrtcSignalEvent {
  type: 'webrtc_signal';
  source: string;
  data: string;
}

export type WsEvent = WsHelloEvent | WsGossipEvent | WsRecordEvent | WsWebrtcSignalEvent;

export interface BackupRequest {
  password: string;
}

export interface RestoreRequest {
  file: IdentityFile;
  password: string;
}

export interface IdentityFile {
  version: number;
  format: string;
  pubkey: string;
  created_ms: number;
  encrypted: {
    encrypted_secret: string;
    salt: string;
    cipher: string;
    kdf: { alg: string; iterations: number };
  };
}

export interface SealDmRequest {
  author: string;
  to: string;
  plaintext: string;
}

export interface SealDmResponse {
  ciphertext: string;
  nonce: string;
  ephemeral_pubkey: string;
}

export interface OpenDmRequest {
  ciphertext: string;
  nonce: string;
  ephemeral_pubkey: string;
  sender: string;
}

export interface OpenDmResponse {
  plaintext: string;
}

export interface MediaOfferRequest {
  to: string;
  file_name: string;
  size_bytes: number;
  ephemeral_pubkey: string;
}

export interface MediaAcceptRequest {
  offer_cid: string;
  ephemeral_pubkey: string;
}

export interface ReportRequest {
  target_cid: string;
  reason: string;
}

export interface ModActionRequest {
  target_cid: string;
  action: 'hide' | 'nuke';
  mod_pubkey: string;
}

export interface CommunityCreateRequest {
  name: string;
  description: string;
}

export interface CommunityMembershipRequest {
  community_cid: string;
  target_pubkey: string;
  role: string;
}

export interface CommunityInfoResponse {
  cid: string;
  name: string;
  founder: string;
  moderators: string[];
  blocked_cids: string[];
  hidden_cids: string[];
}

export interface ModerationResponse {
  blocked_cids: string[];
  hidden_cids: string[];
  mod_pubkeys: string[];
  communities: Record<string, CommunityInfoResponse>;
}

export interface ChainBlockHeader {
  height: number;
  parent_hash: string;
  timestamp: number;
  proposer: string;
  merkle_root: string;
  nonce: number;
  hash: string;
}

export interface ChainTx {
  author: string;
  record_cid: string;
  ts: number;
  sig: string;
}

export interface ChainBlock {
  header: ChainBlockHeader;
  txs: ChainTx[];
}

export interface AnchorTxInput {
  author: string;
  record_cid: string;
  ts: number;
  sig: string;
  payload?: unknown;
  media_cid_only?: boolean;
  encrypted?: EncryptedEnvelope;
  community_cid?: string;
  to?: string;
}

export interface EncryptedEnvelope {
  ciphertext: string;
  nonce: string;
  ephemeral_pubkey: string;
}

export interface ChainAnchorResponse {
  status: string;
}

export interface ChainRecordStatus {
  cid: string;
  height: number | null;
}

export interface ChainValidatorsResponse {
  validators: string[];
}

export interface ChainIndexEntry {
  record_cid: string;
  author: string;
  ts: number;
  height: number;
  committed: boolean;
  dapp?: string;
  community_cid?: string;
  encrypted: boolean;
}

export interface ChainIndexResponse {
  results: ChainIndexEntry[];
}

export interface ChainProofResponse {
  cid: string;
  height: number;
  proof: string[];
  root: string;
}

export interface ChainVerifyResponse {
  valid: boolean;
  record_cid: string;
}

export interface ChainVotesResponse {
  height: number;
  votes: Array<{ validator: string; sig: string }>;
}

export interface DappManifest {
  name: string;
  title?: string;
  version?: string;
  description?: string;
  icon?: string;
  routes?: string[];
  permissions?: string[];
}
