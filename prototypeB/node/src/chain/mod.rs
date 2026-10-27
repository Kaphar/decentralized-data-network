use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::crypto::Keypair;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AnchorTx {
    pub author: String,
    pub record_cid: String,
    pub ts: u64,
    pub sig: String,
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
}

pub struct AnchorChain {
    data_dir: PathBuf,
    genesis_validator: Keypair,
    validators: Vec<String>,
    blocks: Arc<RwLock<Vec<Block>>>,
    pending_txs: Arc<RwLock<Vec<AnchorTx>>>,
    anchor_index: Arc<RwLock<HashMap<String, u64>>>,
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
            running: false,
        }
    }

    pub fn validators(&self) -> Vec<String> {
        self.validators.clone()
    }

    fn save(&self) {
        let path = self.data_dir.join("chain_state.json");
        let blocks = futures::executor::block_on(async {
            self.blocks.read().await.clone()
        });
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
        };
        let mut pending = self.pending_txs.write().await;
        pending.push(tx);
        true
    }

    pub async fn anchor_status(&self, cid: &str) -> Option<u64> {
        let index = self.anchor_index.read().await;
        index.get(cid).copied()
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
        };

        let mut block = block;
        block.header.hash = Block::compute_hash(&block.header);

        {
            let mut blocks = self.blocks.write().await;
            let mut index = self.anchor_index.write().await;
            for tx in &block.txs {
                index.insert(tx.record_cid.clone(), block.header.height);
            }
            blocks.push(block.clone());
        }
        self.save();

        Some(block)
    }

    pub fn start_producer(&mut self, interval_secs: u64) {
        self.running = true;
        let blocks = Arc::clone(&self.blocks);
        let pending = Arc::clone(&self.pending_txs);
        let index = Arc::clone(&self.anchor_index);
        let data_dir = self.data_dir.clone();
        let validators = self.validators.clone();
        let genesis_pk = self.genesis_validator.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
            loop {
                interval.tick().await;

                let txs_to_process: Vec<AnchorTx> = {
                    let mut p = pending.write().await;
                    p.drain(..).collect()
                };

                if txs_to_process.is_empty() {
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
                };

                let mut block = block;
                block.header.hash = Block::compute_hash(&block.header);

                {
                    let mut b = blocks.write().await;
                    let mut idx = index.write().await;
                    for tx in &block.txs {
                        idx.insert(tx.record_cid.clone(), block.header.height);
                    }
                    b.push(block.clone());
                }

                let path = data_dir.join("chain_state.json");
                let b = blocks.read().await;
                if let Ok(s) = serde_json::to_string_pretty(&*b) {
                    let _ = std::fs::write(&path, s);
                }

                let _ = genesis_pk;
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
        }
    }
}
