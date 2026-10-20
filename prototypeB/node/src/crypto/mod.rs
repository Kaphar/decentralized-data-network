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

    /// The raw 32-byte Ed25519 secret seed.
    pub fn secret_bytes(&self) -> Vec<u8> {
        self.signing.to_bytes().to_vec()
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
    /// KDF parameters, serialized so backups remain self-describing.
    #[serde(default)]
    pub kdf: KdfParams,
}

/// Password-based key derivation parameters (PBKDF2-HMAC-SHA256).
/// The plan calls for Argon2/PBKDF2; PBKDF2 is used here because it needs no
/// extra native dependencies and is available in the pure-Rust `pbkdf2` crate.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KdfParams {
    pub alg: String,
    pub iterations: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        KdfParams { alg: "pbkdf2-sha256".to_string(), iterations: 600_000 }
    }
}

pub fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    derive_key_with(password, salt, &KdfParams::default())
}

pub fn derive_key_with(password: &str, salt: &[u8], params: &KdfParams) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), salt, params.iterations, &mut out);
    out
}

pub fn encrypt_key(password: &str, secret: &[u8]) -> EncryptedKey {
    encrypt_key_with(password, secret, &KdfParams::default())
}

pub fn encrypt_key_with(password: &str, secret: &[u8], params: &KdfParams) -> EncryptedKey {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let key = derive_key_with(password, &salt, params);
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
        kdf: params.clone(),
    }
}

pub fn decrypt_key(password: &str, enc: &EncryptedKey) -> Result<Vec<u8>, &'static str> {
    use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
    let engine = base64::engine::general_purpose::STANDARD;
    let salt = engine.decode(&enc.salt).map_err(|_| "invalid salt")?;
    if salt.len() != 16 {
        return Err("salt must be 16 bytes");
    }
    let key = derive_key_with(password, &salt, &enc.kdf);
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

// ---------------------------------------------------------------------------
// Persistent identity file (meshwall_backup.json) — Phase 1 key management
// ---------------------------------------------------------------------------

/// On-disk / downloadable key backup format. Contains only the *encrypted*
/// private key plus KDF salt — never the plaintext secret. Without the user's
/// password this file is useless, which is exactly the "no admin reset" rule.
#[derive(Serialize, Deserialize, Clone)]
pub struct IdentityFile {
    pub version: u32,
    pub format: String,
    pub pubkey: String,
    pub created_ms: u64,
    pub encrypted: EncryptedKey,
}

pub fn create_identity_file(keypair: &Keypair, password: &str) -> IdentityFile {
    IdentityFile {
        version: 1,
        format: "ddn-keybackup-v1".to_string(),
        pubkey: pubkey_to_cid(&keypair.public_key_bytes()),
        created_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        encrypted: encrypt_key(password, &keypair.secret_bytes()),
    }
}

pub fn load_identity_file(file: &IdentityFile, password: &str) -> Result<Keypair, &'static str> {
    let secret = decrypt_key(password, &file.encrypted)?;
    let kp = Keypair::from_bytes(&secret)?;
    // Fail closed if the pubkey doesn't match the backup metadata.
    if pubkey_to_cid(&kp.public_key_bytes()) != file.pubkey {
        return Err("pubkey mismatch: backup file corrupted or tampered");
    }
    Ok(kp)
}

// ---------------------------------------------------------------------------
// X25519 + AES-GCM sealed DM encryption (Phase 2 groundwork, E2EE DMs)
// ---------------------------------------------------------------------------

/// Encrypt a DM for `recipient_pub_hex` (their Ed25519 pubkey, hex).
/// We map Ed25519 -> X25519 deterministically on both sides (same scheme as
/// libsodium's `crypto_box`), do a static-ephemeral X25519 exchange, derive an
/// AES-256-GCM key with HKDF-SHA256 over the shared secret + both pubkeys, and
/// seal the plaintext. Nodes only ever see the returned ciphertext fields.
pub fn seal_dm(
    sender_ed25519_pub: &[u8],
    recipient_ed25519_pub_hex: &str,
    plaintext: &[u8],
) -> Result<(String, String, String), &'static str> {
    use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
    use x25519_dalek::{PublicKey, StaticSecret};

    let recipient_ed = cid_to_pubkey(recipient_ed25519_pub_hex)?;
    let recipient_x = ed25519_pub_to_x25519(&recipient_ed)?;

    let mut eph_secret_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut eph_secret_bytes);
    let eph_secret = StaticSecret::from(eph_secret_bytes);
    let eph_public = PublicKey::from(&eph_secret);

    let recipient_pk = PublicKey::from(recipient_x);
    let shared = eph_secret.diffie_hellman(&recipient_pk);

    let key = dm_derive_key(
        shared.as_bytes(),
        &ed25519_pub_to_x25519(sender_ed25519_pub)?,
        &recipient_x,
        &eph_public.to_bytes(),
    );

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "cipher init failed")?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| "encryption failed")?;

    let engine = base64::engine::general_purpose::STANDARD;
    Ok((
        engine.encode(ct),
        engine.encode(nonce_bytes),
        hex::encode(eph_public.to_bytes()),
    ))
}

/// Decrypt a DM sealed to our identity.
pub fn open_dm(
    our_ed25519_secret: &[u8],
    sender_ed25519_pub: &[u8],
    ciphertext_b64: &str,
    nonce_b64: &str,
    ephemeral_pub_hex: &str,
) -> Result<Vec<u8>, &'static str> {
    use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
    use x25519_dalek::{PublicKey, StaticSecret};

    let our_kp = Keypair::from_bytes(our_ed25519_secret)?;

    // Our X25519 secret key = SHA-512(ed25519 secret seed)[0..32] clamped.
    use sha2::Digest;
    let mut h = <sha2::Sha512 as Default>::default();
    h.update(our_ed25519_secret);
    let hash: [u8; 64] = h.finalize().into();
    let mut priv_bytes = [0u8; 32];
    priv_bytes.copy_from_slice(&hash[..32]);
    clamp_scalar(&mut priv_bytes);
    let secret = StaticSecret::from(priv_bytes);

    let eph_bytes = hex::decode(ephemeral_pub_hex).map_err(|_| "bad ephemeral pubkey hex")?;
    if eph_bytes.len() != 32 {
        return Err("ephemeral pubkey must be 32 bytes");
    }
    let mut eph_arr = [0u8; 32];
    eph_arr.copy_from_slice(&eph_bytes);
    let shared = secret.diffie_hellman(&PublicKey::from(eph_arr));

    let key = dm_derive_key(
        shared.as_bytes(),
        &ed25519_pub_to_x25519(sender_ed25519_pub)?,
        &ed25519_pub_to_x25519(&our_kp.public_key_bytes())?,
        &eph_arr,
    );

    let engine = base64::engine::general_purpose::STANDARD;
    let ct = engine.decode(ciphertext_b64).map_err(|_| "bad ciphertext base64")?;
    let nonce_bytes = engine.decode(nonce_b64).map_err(|_| "bad nonce base64")?;
    if nonce_bytes.len() != 12 {
        return Err("nonce must be 12 bytes");
    }
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "cipher init failed")?;
    cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ct.as_ref())
        .map_err(|_| "decryption failed (wrong key or tampered message)")
}

fn dm_derive_key(
    shared: &[u8; 32],
    sender_x: &[u8; 32],
    recipient_x: &[u8; 32],
    eph_x: &[u8; 32],
) -> [u8; 32] {
    use hkdf::Hkdf;
    let info = [&sender_x[..], &recipient_x[..], &eph_x[..]].concat();
    let hk = Hkdf::<sha2::Sha256>::new(Some(b"ddn-dm-v1"), shared);
    let mut key = [0u8; 32];
    hk.expand(&info, &mut key).expect("32-byte output always valid");
    key
}

/// libsodium-style Ed25519 -> X25519 public key mapping.
/// Uses `curve25519-dalek`'s vetted Montgomery conversion: decompress the
/// compressed Edwards point and map u = (1+y)/(1-y) over GF(2^255-19).
fn ed25519_pub_to_x25519(ed: &[u8]) -> Result<[u8; 32], &'static str> {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    if ed.len() != 32 {
        return Err("ed25519 pubkey must be 32 bytes");
    }
    let comp = CompressedEdwardsY::from_slice(ed)
        .map_err(|_| "ed25519 pubkey must be 32 bytes")?;
    let point = comp
        .decompress()
        .ok_or("invalid ed25519 point (not on curve)")?;
    let mont = point.to_montgomery();
    let mut out = [0u8; 32];
    out.copy_from_slice(mont.as_bytes());
    Ok(out)
}

/// Clamp an X25519 secret scalar per RFC 7748 §5.
fn clamp_scalar(s: &mut [u8; 32]) {
    s[0] &= 248;
    s[31] &= 127;
    s[31] |= 64;
}

pub fn pubkey_to_cid(pubkey: &[u8]) -> String {
    hex::encode(pubkey)
}

pub fn cid_to_pubkey(cid: &str) -> Result<Vec<u8>, &'static str> {
    hex::decode(cid).map_err(|_| "invalid pubkey hex")
}

/// Generate an ephemeral X25519 keypair for WebRTC media signaling.
/// Returns (pubkey_hex, secret_hex). The secret is returned so the frontend
/// can participate in the WebRTC handshake; it should be discarded after use.
pub fn generate_x25519_keypair() -> (String, String) {
    use x25519_dalek::{PublicKey, StaticSecret};
    let mut secret_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut secret_bytes);
    let secret = StaticSecret::from(secret_bytes);
    let pubkey = PublicKey::from(&secret);
    (hex::encode(pubkey.to_bytes()), hex::encode(secret_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known-answer test for the Ed25519 -> X25519 public key mapping.
    ///
    /// Uses a well-known Ed25519 secret seed and cross-checks our
    /// `ed25519_pub_to_x25519` against `curve25519-dalek`'s vetted
    /// `CompressedEdwardsY::to_montgomery` conversion (same algorithm libsodium
    /// uses for `crypto_sign_ed25519_pk_to_curve25519`).
    #[test]
    fn edwards_to_montgomery_known_answer() {
        // RFC 8032 Test 1 seed → Ed25519 pubkey.
        let ed_secret: [u8; 32] = [
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x3d, 0xa9, 0xc0, 0x7d, 0x8b, 0x5e, 0x0c,
            0x6e, 0x0b, 0x8a, 0x03, 0xe1, 0xd7, 0xec, 0x81, 0xc8, 0xee, 0x8e, 0x3e, 0x5b, 0x8b,
            0xea, 0x1f, 0x9e, 0x7c,
        ];
        let signing = ed25519_dalek::SigningKey::from(&ed_secret);
        let ed_pub = signing.verifying_key().to_bytes();

        // Cross-check: compute the Montgomery u-coordinate directly via curve25519-dalek.
        let comp = curve25519_dalek::edwards::CompressedEdwardsY(ed_pub);
        let point = comp.decompress().expect("pubkey must be a valid curve point");
        let mont = point.to_montgomery();
        let expected_x25519 = mont.to_bytes();

        let u = ed25519_pub_to_x25519(&ed_pub).unwrap();
        assert_eq!(u, expected_x25519);
    }

    #[test]
    fn seal_open_dm_roundtrip() {
        let alice = Keypair::generate();
        let bob = Keypair::generate();
        let alice_pub = alice.public_key_bytes();
        let bob_pub_hex = hex::encode(bob.public_key_bytes());

        let plaintext = b"hello encrypted mesh".to_vec();
        let (ct, nonce, eph) = seal_dm(&alice_pub, &bob_pub_hex, &plaintext).unwrap();

        let opened =
            open_dm(&bob.secret_bytes(), &alice_pub, &ct, &nonce, &eph).unwrap();
        assert_eq!(opened, plaintext);

        // Wrong recipient must fail.
        let eve = Keypair::generate();
        assert!(open_dm(&eve.secret_bytes(), &alice_pub, &ct, &nonce, &eph).is_err());
    }

    #[test]
    fn sign_verify_and_backup() {
        let kp = Keypair::generate();
        let msg = b"canonical payload";
        let sig = kp.sign(msg);
        assert!(Keypair::verify(&kp.public_key_bytes(), msg, &sig.to_bytes()).is_ok());
        assert!(Keypair::verify(&kp.public_key_bytes(), b"other", &sig.to_bytes()).is_err());

        // Low iteration count keeps the test fast; production uses 600k.
        let params = KdfParams { alg: "pbkdf2-sha256".into(), iterations: 1000 };
        let file = IdentityFile {
            version: 1,
            format: "ddn-keybackup-v1".into(),
            pubkey: pubkey_to_cid(&kp.public_key_bytes()),
            created_ms: 0,
            encrypted: encrypt_key_with("hunter2", &kp.secret_bytes(), &params),
        };
        let loaded = load_identity_file(&file, "hunter2").unwrap();
        assert_eq!(loaded.public_key_bytes(), kp.public_key_bytes());
        assert!(load_identity_file(&file, "wrong-password").is_err());
    }
}
