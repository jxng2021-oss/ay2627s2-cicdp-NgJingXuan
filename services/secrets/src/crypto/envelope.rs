use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::crypto::aes_gcm::{AUTH_TAG_BYTES, DecryptionError, NONCE_BYTES, Sealed, open, seal};
use crate::keys::{KEY_BYTES, Key, KeyProvider, MasterKeyError, key_from_slice};

pub const FORMAT_VERSION: i16 = 1;
pub const WRAPPED_KEY_BYTES: usize = 5 + NONCE_BYTES + AUTH_TAG_BYTES + KEY_BYTES;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedData {
    pub format_version: i16,
    pub key_version: i32,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub auth_tag: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvelopeError {
    Sealed,
    Decryption(DecryptionError),
}

impl From<DecryptionError> for EnvelopeError {
    fn from(error: DecryptionError) -> Self {
        Self::Decryption(error)
    }
}

impl EncryptedData {
    fn new(format_version: i16, key_version: i32, sealed: Sealed) -> Self {
        Self {
            format_version,
            key_version,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            auth_tag: sealed.auth_tag,
        }
    }

    fn sealed(&self) -> Sealed {
        Sealed {
            nonce: self.nonce.clone(),
            ciphertext: self.ciphertext.clone(),
            auth_tag: self.auth_tag.clone(),
        }
    }
}

fn context(parts: Value) -> Vec<u8> {
    parts.to_string().into_bytes()
}

fn tenant_key_context(tenant_id: &str, tenant_key_version: i32, format: i16, key: i32) -> Vec<u8> {
    context(json!([
        "tenant-key",
        format,
        key,
        tenant_id,
        tenant_key_version
    ]))
}

fn secret_value_context(
    tenant_id: &str,
    name: &str,
    version: i32,
    format: i16,
    key: i32,
) -> Vec<u8> {
    context(json!([
        "secret-value",
        format,
        key,
        tenant_id,
        name,
        version
    ]))
}

fn file_key_context(tenant_id: &str, file_id: &str, format: i16, key: i32) -> Vec<u8> {
    context(json!(["file-key", format, key, tenant_id, file_id]))
}

fn signing_key_context(tenant_id: &str, pool_id: &str, format: i16, key: i32) -> Vec<u8> {
    context(json!(["signing-key", format, key, tenant_id, pool_id]))
}

fn check_format(data: &EncryptedData) -> Result<(), DecryptionError> {
    if data.format_version == FORMAT_VERSION {
        Ok(())
    } else {
        Err(DecryptionError("unsupported format version"))
    }
}

fn exact_key(plain: Zeroizing<Vec<u8>>, reason: &'static str) -> Result<Key, DecryptionError> {
    key_from_slice(&plain).ok_or(DecryptionError(reason))
}

pub fn wrap_tenant_key(
    keys: &dyn KeyProvider,
    tenant_id: &str,
    tenant_key_version: i32,
    tenant_key: &Key,
) -> Result<EncryptedData, EnvelopeError> {
    let key_version = keys.current_version();
    let master_key = keys.master_key(key_version).map_err(|error| match error {
        MasterKeyError::Sealed => EnvelopeError::Sealed,
        MasterKeyError::UnknownVersion => {
            EnvelopeError::Decryption(DecryptionError("master key version not available"))
        }
    })?;
    let aad = tenant_key_context(tenant_id, tenant_key_version, FORMAT_VERSION, key_version);
    let sealed = seal(&master_key, tenant_key.as_ref(), &aad);
    Ok(EncryptedData::new(FORMAT_VERSION, key_version, sealed))
}

pub fn unwrap_tenant_key(
    keys: &dyn KeyProvider,
    tenant_id: &str,
    tenant_key_version: i32,
    data: &EncryptedData,
) -> Result<Key, EnvelopeError> {
    check_format(data)?;
    let master_key = keys
        .master_key(data.key_version)
        .map_err(|error| match error {
            MasterKeyError::Sealed => EnvelopeError::Sealed,
            MasterKeyError::UnknownVersion => {
                EnvelopeError::Decryption(DecryptionError("master key version not available"))
            }
        })?;
    let aad = tenant_key_context(
        tenant_id,
        tenant_key_version,
        data.format_version,
        data.key_version,
    );
    let plain = open(&master_key, &data.sealed(), &aad)?;
    Ok(exact_key(plain, "wrong tenant key size")?)
}

pub fn encrypt_value(
    tenant_key: &Key,
    tenant_key_version: i32,
    tenant_id: &str,
    name: &str,
    version: i32,
    value: &str,
) -> EncryptedData {
    let aad = secret_value_context(tenant_id, name, version, FORMAT_VERSION, tenant_key_version);
    let sealed = seal(tenant_key, value.as_bytes(), &aad);
    EncryptedData::new(FORMAT_VERSION, tenant_key_version, sealed)
}

pub fn decrypt_value(
    tenant_key: &Key,
    tenant_id: &str,
    name: &str,
    version: i32,
    data: &EncryptedData,
) -> Result<Zeroizing<String>, DecryptionError> {
    check_format(data)?;
    let aad = secret_value_context(
        tenant_id,
        name,
        version,
        data.format_version,
        data.key_version,
    );
    let plain = open(tenant_key, &data.sealed(), &aad)?;
    Ok(Zeroizing::new(String::from_utf8_lossy(&plain).into_owned()))
}

pub fn wrap_file_key(
    tenant_key: &Key,
    tenant_key_version: i32,
    tenant_id: &str,
    file_id: &str,
    file_key: &Key,
) -> EncryptedData {
    let aad = file_key_context(tenant_id, file_id, FORMAT_VERSION, tenant_key_version);
    EncryptedData::new(
        FORMAT_VERSION,
        tenant_key_version,
        seal(tenant_key, file_key.as_ref(), &aad),
    )
}

pub fn unwrap_file_key(
    tenant_key: &Key,
    tenant_id: &str,
    file_id: &str,
    data: &EncryptedData,
) -> Result<Key, DecryptionError> {
    check_format(data)?;
    let aad = file_key_context(tenant_id, file_id, data.format_version, data.key_version);
    exact_key(
        open(tenant_key, &data.sealed(), &aad)?,
        "wrong file key size",
    )
}

pub fn wrap_signing_key(
    tenant_key: &Key,
    tenant_key_version: i32,
    tenant_id: &str,
    pool_id: &str,
    data_key: &Key,
) -> EncryptedData {
    let aad = signing_key_context(tenant_id, pool_id, FORMAT_VERSION, tenant_key_version);
    EncryptedData::new(
        FORMAT_VERSION,
        tenant_key_version,
        seal(tenant_key, data_key.as_ref(), &aad),
    )
}

pub fn unwrap_signing_key(
    tenant_key: &Key,
    tenant_id: &str,
    pool_id: &str,
    data: &EncryptedData,
) -> Result<Key, DecryptionError> {
    check_format(data)?;
    let aad = signing_key_context(tenant_id, pool_id, data.format_version, data.key_version);
    exact_key(
        open(tenant_key, &data.sealed(), &aad)?,
        "wrong signing data key size",
    )
}

pub fn encode_wrapped_key(data: &EncryptedData) -> Vec<u8> {
    let mut blob = Vec::with_capacity(WRAPPED_KEY_BYTES);
    blob.push(u8::try_from(data.format_version).unwrap_or(0));
    blob.extend_from_slice(&u32::try_from(data.key_version).unwrap_or(0).to_be_bytes());
    blob.extend_from_slice(&data.nonce);
    blob.extend_from_slice(&data.auth_tag);
    blob.extend_from_slice(&data.ciphertext);
    blob
}

pub fn decode_wrapped_key(blob: &[u8]) -> Result<EncryptedData, DecryptionError> {
    if blob.len() != WRAPPED_KEY_BYTES {
        return Err(DecryptionError("wrong wrapped key size"));
    }
    let version_bytes: [u8; 4] = blob[1..5]
        .try_into()
        .map_err(|_| DecryptionError("wrong wrapped key size"))?;
    let key_version = i32::try_from(u32::from_be_bytes(version_bytes))
        .map_err(|_| DecryptionError("key version out of range"))?;
    Ok(EncryptedData {
        format_version: i16::from(blob[0]),
        key_version,
        nonce: blob[5..17].to_vec(),
        auth_tag: blob[17..33].to_vec(),
        ciphertext: blob[33..].to_vec(),
    })
}
