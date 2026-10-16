use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordType {
    Profile,
    Post,
    Comment,
    Reaction,
    Message,
    MediaOffer,
    MediaAccept,
    Report,
    ModAction,
    ModGrant,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BaseRecord {
    pub id: String,
    pub r#type: RecordType,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev: Option<String>,
    pub ts: u64,
    #[serde(default)]
    pub payload: serde_json::Value,
    pub sig: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MediaRef {
    pub cid: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SignRequest {
    pub r#type: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev: Option<String>,
    pub ts: u64,
    pub payload: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SignResponse {
    pub id: String,
    pub sig: String,
}

impl BaseRecord {
    pub fn compute_id(&self) -> String {
        let mut map: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        map.insert("type".to_string(), serde_json::to_value(&self.r#type).unwrap());
        map.insert("author".to_string(), serde_json::to_value(&self.author).unwrap());
        map.insert("prev".to_string(), serde_json::to_value(&self.prev).unwrap());
        map.insert("ts".to_string(), serde_json::to_value(self.ts).unwrap());
        map.insert("payload".to_string(), serde_json::to_value(&self.payload).unwrap());
        let json = serde_json::to_string(&map).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(json.as_bytes());
        let result = hasher.finalize();
        result.iter().map(|b| format!("{:02x}", b)).collect()
    }

    pub fn sign(&mut self, signing_key: &crate::crypto::Keypair) {
        self.id = self.compute_id();
        let sig = signing_key.sign(self.id.as_bytes());
        self.sig = Some(hex::encode(sig.to_bytes()));
    }

    pub fn verify(&self) -> Result<(), &'static str> {
        let computed_id = self.compute_id();
        if self.id != computed_id {
            return Err("record id does not match hash");
        }
        let sig_bytes = hex::decode(self.sig.as_ref().ok_or("missing signature")?)
            .map_err(|_| "invalid signature hex")?;
        crate::crypto::Keypair::verify(&crate::crypto::cid_to_pubkey(&self.author)?, self.id.as_bytes(), &sig_bytes)?;
        Ok(())
    }

    pub fn to_canonical_json(&self) -> Result<String, &'static str> {
        serde_json::to_string(self).map_err(|_| "serialization failed")
    }

    pub fn from_sign_request(req: &SignRequest, signing_key: &crate::crypto::Keypair) -> Self {
        let record_type: RecordType = serde_json::from_str(&format!("\"{}\"", req.r#type))
            .unwrap_or(RecordType::Post);
        let mut record = BaseRecord {
            id: String::new(),
            r#type: record_type,
            author: req.author.clone(),
            prev: req.prev.clone(),
            ts: req.ts,
            payload: req.payload.clone(),
            sig: None,
        };
        record.sign(signing_key);
        record
    }
}
