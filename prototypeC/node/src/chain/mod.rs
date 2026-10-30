use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::crypto::Keypair;

/// Maximum size of embedded payload data in an AnchorTx (100 KB).
/// Media above this threshold is anchored by CID-only.
pub const MAX_EMBEDDED_PAYLOAD: u64 = 5000 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AnchorTx {
    pub author: String,
    pub record_cid: String,
    pub ts: u64,
    pub sig: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BlockSignature {
    pub validator_cid: String,
    pub signature: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BlockHeader {
    pub height: u64,
    pub parent_hash: String,
    pub timestamp: u64,
    pub proposer: String,
    pub merkle_root: String,
    pub nonce: u64,
    pub hash: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Block {
    pub header: BlockHeader,
    pub txs: Vec<AnchorTx>,
    #[serde(default)]
    pub signatures: Vec<BlockSignature>,
}

pub struct AnchorChain {
    data_dir: PathBuf,
    genesis_validator: Keypair,
    validators: Vec<String>,
    blocks: Arc<RwLock<Vec<Block>>>,
    pending_txs: Arc<RwLock<Vec<AnchorTx>>>,
    anchor_index: Arc<RwLock<HashMap<String, u64>>>,
    pending_blocks: Arc<RwLock<Vec<Block>>>,
    running: bool,
}

impl Block {
    fn compute_hash(header_without_hash: &BlockHeader) -> String {
        let json = serde_json::json!({
            "height": header_without_hash.height,
            "parent_hash": header_without_hash.parent_hash,
            "timestamp": header_without_hash.timestamp,
            "proposer": header_without_hash.proposer,
            "merkle_root": header_without_hash.merkle_root,
            "nonce": header_without_hash.nonce,
        });
        let bytes = serde_json::to_vec(&json).unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        hex::encode(hasher.finalize())
    }

    pub fn hash_block(&self) -> String {
        let mut header = self.header.clone();
        header.hash = String::new();
        Self::compute_hash(&header)
    }
}

fn merkle_root(txs: &[AnchorTx]) -> String {
    if txs.is_empty() {
        let mut h = Sha256::new();
        h.update(b"");
        return hex::encode(h.finalize());
    }
    let leaves: Vec<String> = txs
        .iter()
        .map(|tx| {
            let mut h = Sha256::new();
            h.update(serde_json::to_string(&tx).unwrap_or_default().as_bytes());
            hex::encode(h.finalize())
        })
        .collect();
    let mut level = leaves;
    while level.len() > 1 {
        let mut next = Vec::new();
        for chunk in level.chunks(2) {
            let mut h = Sha256::new();
            if chunk.len() == 2 {
                h.update(format!("{}{}", chunk[0], chunk[1]).as_bytes());
            } else {
                h.update(format!("{}{}", chunk[0], chunk[0]).as_bytes());
            }
            next.push(hex::encode(h.finalize()));
        }
        level = next;
    }
    level[0].clone()
}

impl AnchorChain {
    pub fn new(data_dir: &Path, genesis_validator: &Keypair) -> Self {
        let mut blocks: Vec<Block> = Vec::new();
        let genesis = Block {
            header: BlockHeader {
                height: 0,
                parent_hash: String::new(),
                timestamp: 0,
                proposer: crate::crypto::pubkey_to_cid(&genesis_validator.public_key_bytes()),
                merkle_root: merkle_root(&[]),
                nonce: 0,
                hash: String::new(),
            },
            txs: vec![],
            signatures: vec![],
        };
        let mut genesis = genesis;
        genesis.header.hash = Block::compute_hash(&genesis.header);
        blocks.push(genesis);

        let path = data_dir.join("chain_state.json");
        if path.exists() {
            if let Ok(s) = std::fs::read_to_string(&path) {
                if let Ok(saved) = serde_json::from_str::<Vec<Block>>(&s) {
                    blocks = saved;
                }
            }
        }

        Self {
            data_dir: data_dir.to_path_buf(),
            genesis_validator: genesis_validator.clone(),
            validators: vec![crate::crypto::pubkey_to_cid(
                &genesis_validator.public_key_bytes(),
            )],
            blocks: Arc::new(RwLock::new(blocks)),
            pending_txs: Arc::new(RwLock::new(Vec::new())),
            anchor_index: Arc::new(RwLock::new(HashMap::new())),
            pending_blocks: Arc::new(RwLock::new(Vec::new())),
            running: false,
        }
    }

    /// Build the validator set: genesis validator + any validators from DDN_VALIDATORS env.
    pub fn with_validators(mut self, extra_validators: Vec<String>) -> Self {
        let genesis_cid = crate::crypto::pubkey_to_cid(
            &self.genesis_validator.public_key_bytes(),
        );
        if !self.validators.contains(&genesis_cid) {
            self.validators.insert(0, genesis_cid);
        }
        for v in extra_validators {
            if !self.validators.contains(&v) {
                self.validators.push(v);
            }
        }
        self
    }

    /// Minimum number of validator signatures required for a block to be committed.
    /// Computed as 2/3 + 1 of the total validator set.
    fn two_thirds_plus_one(&self) -> usize {
        let n = self.validators.len();
        if n == 0 {
            return 1;
        }
        (n * 2 / 3) + 1
    }

    pub fn validators(&self) -> Vec<String> {
        self.validators.clone()
    }

    fn save(&self) {
        let path = self.data_dir.join("chain_state.json");
        let blocks = futures::executor::block_on(async { self.blocks.read().await.clone() });
        if let Ok(s) = serde_json::to_string_pretty(&blocks) {
            let _ = std::fs::create_dir_all(&self.data_dir);
            let _ = std::fs::write(&path, s);
        }
    }

    pub async fn latest_block(&self) -> Block {
        let blocks = self.blocks.read().await;
        blocks.last().cloned().unwrap_or_default()
    }

    pub async fn block_at(&self, height: u64) -> Option<Block> {
        let blocks = self.blocks.read().await;
        blocks.iter().find(|b| b.header.height == height).cloned()
    }

    pub async fn anchor_cid(&self, author: &str, record_cid: &str, ts: u64, sig: &str) -> bool {
        let tx = AnchorTx {
            author: author.to_string(),
            record_cid: record_cid.to_string(),
            ts,
            sig: sig.to_string(),
            payload_data: None,
            content_type: None,
        };
        let mut pending = self.pending_txs.write().await;
        pending.push(tx);
        true
    }

    /// Anchor a record with embedded payload data (for text + small media < 100 KB).
    /// The payload is stored directly in the block transaction, not just the CID.
    pub async fn anchor_payload(
        &self,
        author: &str,
        record_cid: &str,
        ts: u64,
        sig: &str,
        payload_data: String,
        content_type: String,
    ) -> bool {
        if payload_data.len() as u64 > MAX_EMBEDDED_PAYLOAD {
            return false;
        }
        let tx = AnchorTx {
            author: author.to_string(),
            record_cid: record_cid.to_string(),
            ts,
            sig: sig.to_string(),
            payload_data: Some(payload_data),
            content_type: Some(content_type),
        };
        let mut pending = self.pending_txs.write().await;
        pending.push(tx);
        true
    }

    pub async fn anchor_status(&self, cid: &str) -> Option<u64> {
        let index = self.anchor_index.read().await;
        index.get(cid).copied()
    }

    pub async fn propose_block(&self) -> Option<Block> {
        let mut pending = self.pending_txs.write().await;
        if pending.is_empty() {
            return None;
        }
        let txs: Vec<AnchorTx> = pending.drain(..).collect();
        drop(pending);

        let latest = self.latest_block().await;
        let new_height = latest.header.height + 1;
        let proposer = self
            .validators
            .get((new_height as usize) % self.validators.len())
            .cloned()
            .unwrap_or_else(|| self.validators[0].clone());

        let block = Block {
            header: BlockHeader {
                height: new_height,
                parent_hash: latest.header.hash,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                proposer: proposer.clone(),
                merkle_root: merkle_root(&txs),
                nonce: new_height,
                hash: String::new(),
            },
            txs,
            signatures: vec![],
        };

        let mut block = block;
        block.header.hash = Block::compute_hash(&block.header);
        Some(block)
    }

    /// List block proposals currently awaiting validator signatures.
    pub async fn pending_block_proposals(&self) -> Vec<Block> {
        let pending = self.pending_blocks.read().await;
        pending.clone()
    }

    /// Validator signs a block proposal by hash. The signature covers the block hash.
    pub fn sign_block(&self, kp: &Keypair, block_hash: &str) -> BlockSignature {
        let cid = crate::crypto::pubkey_to_cid(&kp.public_key_bytes());
        let sig = kp.sign(block_hash.as_bytes());
        BlockSignature {
            validator_cid: cid,
            signature: sig.to_bytes().iter().map(|b| format!("{:02x}", b)).collect(),
        }
    }

    /// Verify a block's signature from a known validator.
     fn verify_signature(block_hash: &str, sig: &BlockSignature) -> bool {
        if let Ok(pubkey) = crate::crypto::cid_to_pubkey(&sig.validator_cid) {
            if let Ok(sig_bytes) = hex::decode(&sig.signature) {
                if sig_bytes.len() == 64 {
                    let mut arr = [0u8; 64];
                    arr.copy_from_slice(&sig_bytes);
                    let sig_obj = ed25519_dalek::Signature::from_bytes(&arr);
                    return Keypair::verify(&pubkey, block_hash.as_bytes(), &sig_obj.to_bytes()).is_ok();
                }
            }
        }
        false
    }

    /// Validate a block: check hash integrity, parent linkage, proposer is a validator,
    /// and that 2/3+1 of validators have signed.
    pub fn validate_block(&self, block: &Block) -> bool {
        // Recompute hash to verify integrity.
        let mut header_copy = block.header.clone();
        header_copy.hash = String::new();
        if Block::compute_hash(&header_copy) != block.header.hash {
            return false;
        }

        // Parent must match latest block.
        let blocks = futures::executor::block_on(self.blocks.read());
        let latest = blocks.last();
        if let Some(latest) = latest {
            if block.header.parent_hash != latest.header.hash {
                return false;
            }
            if block.header.height != latest.header.height + 1 {
                return false;
            }
        } else if block.header.height != 1 {
            return false;
        }

        // Proposer must be a validator.
        if !self.validators.contains(&block.header.proposer) {
            return false;
        }

        // Collect valid signatures from distinct validators.
        let mut seen = std::collections::HashSet::new();
        let mut valid_sigs = 0;
        for sig in &block.signatures {
            if seen.contains(&sig.validator_cid) {
                continue;
            }
            if self.validators.contains(&sig.validator_cid)
                && Self::verify_signature(&block.header.hash, sig)
            {
                seen.insert(sig.validator_cid.clone());
                valid_sigs += 1;
            }
        }

        valid_sigs >= self.two_thirds_plus_one()
    }

    /// Commit a block to the chain after validation. Returns true if committed.
    pub async fn commit_block(&self, block: Block) -> bool {
        if !self.validate_block(&block) {
            return false;
        }

        let mut blocks = self.blocks.write().await;
        // Prevent duplicate commits.
        if blocks.iter().any(|b| b.header.hash == block.header.hash) {
            return false;
        }

        let mut index = self.anchor_index.write().await;
        for tx in &block.txs {
            index.insert(tx.record_cid.clone(), block.header.height);
        }
        blocks.push(block.clone());
        drop(blocks);
        drop(index);

        self.save();
        true
    }

    pub async fn build_block(&self) -> Option<Block> {
        let mut pending = self.pending_txs.write().await;
        if pending.is_empty() {
            return None;
        }
        let txs: Vec<AnchorTx> = pending.drain(..).collect();
        drop(pending);

        let latest = self.latest_block().await;
        let new_height = latest.header.height + 1;
        let proposer = self
            .validators
            .get((new_height as usize) % self.validators.len())
            .cloned()
            .unwrap_or_else(|| self.validators[0].clone());

        let block = Block {
            header: BlockHeader {
                height: new_height,
                parent_hash: latest.header.hash,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                proposer: proposer.clone(),
                merkle_root: merkle_root(&txs),
                nonce: new_height,
                hash: String::new(),
            },
            txs,
            signatures: vec![],
        };

        let mut block = block;
        block.header.hash = Block::compute_hash(&block.header);

        let threshold = self.two_thirds_plus_one();
        if threshold <= 1 {
            // Single validator: self-sign and commit immediately.
            let self_sig = self.sign_block(&self.genesis_validator, &block.header.hash);
            block.signatures.push(self_sig);
            let mut blocks = self.blocks.write().await;
            let mut index = self.anchor_index.write().await;
            for tx in &block.txs {
                index.insert(tx.record_cid.clone(), block.header.height);
            }
            blocks.push(block.clone());
            drop(blocks);
            drop(index);
            self.save();
        }

        Some(block)
    }

    pub fn start_producer(&mut self, interval_secs: u64) {
        self.running = true;
        let blocks = Arc::clone(&self.blocks);
        let pending = Arc::clone(&self.pending_txs);
        let index = Arc::clone(&self.anchor_index);
        let pending_blocks = Arc::clone(&self.pending_blocks);
        let data_dir = self.data_dir.clone();
        let validators = self.validators.clone();
        let genesis_pk = self.genesis_validator.clone();
        let genesis_cid = crate::crypto::pubkey_to_cid(
            &self.genesis_validator.public_key_bytes(),
        );

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
            loop {
                interval.tick().await;

                // Collect pending proposals that need more signatures.
                {
                    let pending_proposals = pending_blocks.read().await;
                    for proposal in pending_proposals.iter() {
                        let valid_sigs: std::collections::HashSet<String> = proposal
                            .signatures
                            .iter()
                            .filter(|s| validators.contains(&s.validator_cid))
                            .map(|s| s.validator_cid.clone())
                            .collect();
                        let threshold = if validators.len() == 1 {
                            1
                        } else {
                            (validators.len() * 2 / 3) + 1
                        };
                        if valid_sigs.len() >= threshold {
                            // Commit the block.
                            let mut b = blocks.write().await;
                            if b.iter().any(|bl| bl.header.hash == proposal.header.hash) {
                                continue;
                            }
                            let mut idx = index.write().await;
                            for tx in &proposal.txs {
                                idx.insert(tx.record_cid.clone(), proposal.header.height);
                            }
                            b.push(proposal.clone());
                            drop(b);
                            drop(idx);

                            let path = data_dir.join("chain_state.json");
                            let b = blocks.read().await;
                            if let Ok(s) = serde_json::to_string_pretty(&*b) {
                                let _ = std::fs::write(&path, s);
                            }
                        }
                    }
                }

                // Try to propose a new block if this node is the proposer.
                let txs_to_process: Vec<AnchorTx> = {
                    let mut p = pending.write().await;
                    p.drain(..).collect()
                };

                if txs_to_process.is_empty() {
                    if !pending_blocks.read().await.is_empty() {
                        // Has pending proposals but no new txs; loop to check signatures.
                    }
                    continue;
                }

                let latest = {
                    let b = blocks.read().await;
                    b.last().cloned().unwrap_or_default()
                };

                let new_height = latest.header.height + 1;
                let proposer = validators
                    .get((new_height as usize) % validators.len())
                    .cloned()
                    .unwrap_or_else(|| validators[0].clone());

                // Only the proposer creates the block.
                if proposer != genesis_cid {
                    continue;
                }

                let block = Block {
                    header: BlockHeader {
                        height: new_height,
                        parent_hash: latest.header.hash,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                        proposer: proposer.clone(),
                        merkle_root: merkle_root(&txs_to_process),
                        nonce: new_height,
                        hash: String::new(),
                    },
                    txs: txs_to_process.clone(),
                    signatures: vec![],
                };

                let mut block = block;
                block.header.hash = Block::compute_hash(&block.header);

                // Self-sign.
                let self_sig = {
                    let sig = genesis_pk.sign(block.header.hash.as_bytes());
                    BlockSignature {
                        validator_cid: genesis_cid.clone(),
                        signature: sig.to_bytes().iter().map(|b| format!("{:02x}", b)).collect(),
                    }
                };
                block.signatures.push(self_sig);

                // Store as pending proposal (for other validators to sign via API).
                {
                    let mut pp = pending_blocks.write().await;
                    pp.push(block.clone());
                }

                // For single-validator or if threshold already met, commit immediately.
                let threshold = if validators.len() == 1 { 1 } else { (validators.len() * 2 / 3) + 1 };
                if block.signatures.len() >= threshold {
                    let mut b = blocks.write().await;
                    let mut idx = index.write().await;
                    for tx in &block.txs {
                        idx.insert(tx.record_cid.clone(), block.header.height);
                    }
                    b.push(block.clone());
                    drop(b);
                    drop(idx);

                    let path = data_dir.join("chain_state.json");
                    let b = blocks.read().await;
                    if let Ok(s) = serde_json::to_string_pretty(&*b) {
                        let _ = std::fs::write(&path, s);
                    }

                    // Remove from pending.
                    pending_blocks.write().await.retain(|p| p.header.hash != block.header.hash);
                }
            }
        });
    }
}

impl Default for Block {
    fn default() -> Self {
        Block {
            header: BlockHeader {
                height: 0,
                parent_hash: String::new(),
                timestamp: 0,
                proposer: String::new(),
                merkle_root: String::new(),
                nonce: 0,
                hash: String::new(),
            },
            txs: vec![],
            signatures: vec![],
        }
    }
}
