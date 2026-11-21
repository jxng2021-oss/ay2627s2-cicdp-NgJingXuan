use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use zeroize::Zeroizing;

use crate::keys::Key;

pub const NONCE_BYTES: usize = 12;
pub const AUTH_TAG_BYTES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub auth_tag: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptionError(pub &'static str);

impl std::fmt::Display for DecryptionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "decryption failed: {}", self.0)
    }
}

impl std::error::Error for DecryptionError {}

fn cipher(key: &Key) -> Aes256Gcm {
    Aes256Gcm::new(key.as_ref().into())
}

pub fn seal(key: &Key, plaintext: &[u8], aad: &[u8]) -> Sealed {
    let mut nonce = [0u8; NONCE_BYTES];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let mut buffer = plaintext.to_vec();
    let tag =
        match cipher(key).encrypt_in_place_detached(Nonce::from_slice(&nonce), aad, &mut buffer) {
            Ok(tag) => tag,
            Err(_) => unreachable!("AES-256-GCM encryption of an in-memory buffer cannot fail"),
        };
    Sealed {
        nonce: nonce.to_vec(),
        ciphertext: buffer,
        auth_tag: tag.to_vec(),
    }
}

pub fn open(key: &Key, sealed: &Sealed, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>, DecryptionError> {
    if sealed.nonce.len() != NONCE_BYTES {
        return Err(DecryptionError("wrong nonce length"));
    }
    if sealed.auth_tag.len() != AUTH_TAG_BYTES {
        return Err(DecryptionError("wrong auth tag length"));
    }
    let mut buffer = Zeroizing::new(sealed.ciphertext.clone());
    cipher(key)
        .decrypt_in_place_detached(
            Nonce::from_slice(&sealed.nonce),
            aad,
            &mut buffer,
            Tag::from_slice(&sealed.auth_tag),
        )
        .map_err(|_| DecryptionError("authentication failed"))?;
    Ok(buffer)
}
