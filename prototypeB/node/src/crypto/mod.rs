use ed25519_dalek::{Signature, Signer, Verifier, VerifyingKey, SigningKey};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use base64::Engine;

#[derive(Clone)]
pub struct Keypair {
    pub signing: SigningKey,
    pub verifying: VerifyingKey,
}

impl Keypair {
    pub fn generate() -> Self {
        let mut secret = [0u8; 32];
        OsRng.fill_bytes(&mut secret);
        let signing = SigningKey::from_bytes(&secret);
        let verifying = signing.verifying_key();
        Keypair { signing, verifying }
    }

    pub fn from_bytes(secret: &[u8]) -> Result<Self, &'static str> {
        if secret.len() != 32 {
            return Err("secret key must be 32 bytes");
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(secret);
        let signing = SigningKey::from_bytes(&arr);
        let verifying = signing.verifying_key();
        Ok(Keypair { signing, verifying })
    }

    pub fn public_key_bytes(&self) -> Vec<u8> {
        self.verifying.to_bytes().to_vec()
    }

    pub fn sign(&self, message: &[u8]) -> Signature {
        self.signing.sign(message)
    }

    pub fn verify(pubkey: &[u8], message: &[u8], signature: &[u8]) -> Result<(), &'static str> {
        if pubkey.len() != 32 {
            return Err("invalid pubkey length");
        }
        if signature.len() != 64 {
            return Err("invalid signature length");
        }
        let mut pk_arr = [0u8; 32];
        pk_arr.copy_from_slice(pubkey);
        let verifying = VerifyingKey::from_bytes(&pk_arr).map_err(|_| "invalid pubkey")?;
        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(signature);
        let sig = Signature::from_bytes(&sig_arr);
        verifying.verify(message, &sig).map_err(|_| "signature verification failed")
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct EncryptedKey {
    pub encrypted_secret: String,
    pub salt: String,
    pub cipher: String,
}

pub fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hasher.update(salt);
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

pub fn encrypt_key(password: &str, secret: &[u8]) -> EncryptedKey {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let key = derive_key(password, &salt);
    use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
    let cipher = Aes256Gcm::new((&key).into());
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let encrypted = cipher.encrypt(nonce, secret).expect("encryption failed");
    let mut combined = nonce_bytes.to_vec();
    combined.extend(encrypted);
    let engine = base64::engine::general_purpose::STANDARD;
    EncryptedKey {
        encrypted_secret: engine.encode(&combined),
        salt: engine.encode(salt),
        cipher: "aes-256-gcm".to_string(),
    }
}

pub fn decrypt_key(password: &str, enc: &EncryptedKey) -> Result<Vec<u8>, &'static str> {
    use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
    let engine = base64::engine::general_purpose::STANDARD;
    let salt = engine.decode(&enc.salt).map_err(|_| "invalid salt")?;
    if salt.len() != 16 {
        return Err("salt must be 16 bytes");
    }
    let mut salt_arr = [0u8; 16];
    salt_arr.copy_from_slice(&salt);
    let key = derive_key(password, &salt_arr);
    let cipher = Aes256Gcm::new((&key).into());
    let combined = engine.decode(&enc.encrypted_secret).map_err(|_| "invalid encrypted key")?;
    if combined.len() < 12 {
        return Err("ciphertext too short");
    }
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let mut nonce_arr = [0u8; 12];
    nonce_arr.copy_from_slice(nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_arr);
    cipher.decrypt(nonce, ciphertext).map_err(|_| "decryption failed")
}

pub fn pubkey_to_cid(pubkey: &[u8]) -> String {
    hex::encode(pubkey)
}

pub fn cid_to_pubkey(cid: &str) -> Result<Vec<u8>, &'static str> {
    hex::decode(cid).map_err(|_| "invalid pubkey hex")
}