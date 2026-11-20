use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const FORMAT_VERSION: i16 = 1;
pub const CHUNK_SIZE: usize = 64 * 1024;
pub const TAG_BYTES: usize = 16;
pub const NONCE_PREFIX_BYTES: usize = 8;
pub const KEY_BYTES: usize = 32;

#[derive(Debug, PartialEq, Eq)]
pub struct ChunkError(pub String);

impl std::fmt::Display for ChunkError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "encrypted file is damaged: {}", self.0)
    }
}

impl std::error::Error for ChunkError {}

#[derive(Clone)]
pub struct FileContext {
    pub tenant_id: Uuid,
    pub file_id: Uuid,
    pub nonce_prefix: [u8; NONCE_PREFIX_BYTES],
    pub chunk_size: usize,
}

fn nonce(prefix: &[u8; NONCE_PREFIX_BYTES], index: u32) -> [u8; 12] {
    let mut value = [0u8; 12];
    value[..NONCE_PREFIX_BYTES].copy_from_slice(prefix);
    value[NONCE_PREFIX_BYTES..].copy_from_slice(&index.to_be_bytes());
    value
}

fn chunk_context(context: &FileContext, index: u32, last: bool) -> Vec<u8> {
    format!(
        "[\"storage-chunk\",{FORMAT_VERSION},\"{}\",\"{}\",{index},{last}]",
        context.tenant_id, context.file_id
    )
    .into_bytes()
}

fn cipher(key: &[u8]) -> Result<Aes256Gcm, ChunkError> {
    if key.len() != KEY_BYTES {
        return Err(ChunkError("the file key has the wrong length".into()));
    }
    Ok(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key)))
}

pub fn encrypted_size_of(plain_size: u64, chunk_size: usize) -> u64 {
    let chunk = chunk_size as u64;
    let chunks = plain_size.div_ceil(chunk).max(1);
    plain_size + chunks * TAG_BYTES as u64
}

pub struct Encryptor {
    cipher: Aes256Gcm,
    context: FileContext,
    pending: Zeroizing<Vec<u8>>,
    index: u32,
    pub plain_bytes: u64,
}

impl Encryptor {
    pub fn new(key: &[u8], context: FileContext) -> Result<Self, ChunkError> {
        Ok(Self {
            cipher: cipher(key)?,
            context,
            pending: Zeroizing::new(Vec::new()),
            index: 0,
            plain_bytes: 0,
        })
    }

    pub fn chunk_count(&self) -> u32 {
        self.index
    }

    pub fn push(&mut self, data: &[u8]) -> Result<Vec<u8>, ChunkError> {
        self.plain_bytes += data.len() as u64;
        self.pending.extend_from_slice(data);
        let mut sealed = Vec::new();
        while self.pending.len() > self.context.chunk_size {
            let rest = Zeroizing::new(self.pending.split_off(self.context.chunk_size));
            let chunk = std::mem::replace(&mut self.pending, rest);
            sealed.extend(self.seal(&chunk, false)?);
        }
        Ok(sealed)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ChunkError> {
        let last = std::mem::replace(&mut self.pending, Zeroizing::new(Vec::new()));
        self.seal(&last, true)
    }

    fn seal(&mut self, plain: &[u8], last: bool) -> Result<Vec<u8>, ChunkError> {
        let index = self.index;
        self.index = index
            .checked_add(1)
            .ok_or_else(|| ChunkError("file too large for the chunk format".into()))?;
        let nonce = nonce(&self.context.nonce_prefix, index);
        let aad = chunk_context(&self.context, index, last);
        self.cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plain,
                    aad: &aad,
                },
            )
            .map_err(|_| ChunkError("encryption failed".into()))
    }
}

pub struct Decryptor {
    cipher: Aes256Gcm,
    context: FileContext,
    pending: Vec<u8>,
    index: u32,
    chunk_count: u32,
    encrypted_size: u64,
}

impl Decryptor {
    pub fn new(
        key: &[u8],
        context: FileContext,
        chunk_count: u32,
        encrypted_size: u64,
    ) -> Result<Self, ChunkError> {
        let full = (context.chunk_size + TAG_BYTES) as u64;
        let tag = TAG_BYTES as u64;
        let valid = chunk_count >= 1
            && encrypted_size
                .checked_sub(u64::from(chunk_count - 1) * full)
                .is_some_and(|last| last >= tag && last <= full);
        if !valid {
            return Err(ChunkError("sizes don't match the chunk count".into()));
        }
        Ok(Self {
            cipher: cipher(key)?,
            context,
            pending: Vec::new(),
            index: 0,
            chunk_count,
            encrypted_size,
        })
    }

    fn size_of(&self, index: u32) -> usize {
        let full = self.context.chunk_size + TAG_BYTES;
        if index < self.chunk_count - 1 {
            full
        } else {
            (self.encrypted_size - u64::from(self.chunk_count - 1) * full as u64) as usize
        }
    }

    pub fn push(&mut self, data: &[u8]) -> Result<Zeroizing<Vec<u8>>, ChunkError> {
        self.pending.extend_from_slice(data);
        let mut plain = Zeroizing::new(Vec::new());
        while self.index < self.chunk_count && self.pending.len() >= self.size_of(self.index) {
            let size = self.size_of(self.index);
            let rest = self.pending.split_off(size);
            let sealed = std::mem::replace(&mut self.pending, rest);
            plain.extend(self.open(&sealed)?.iter());
        }
        if self.index >= self.chunk_count && !self.pending.is_empty() {
            return Err(ChunkError("extra data after the last chunk".into()));
        }
        Ok(plain)
    }

    pub fn finish(&self) -> Result<(), ChunkError> {
        if self.index == self.chunk_count {
            Ok(())
        } else {
            Err(ChunkError("chunks are missing".into()))
        }
    }

    fn open(&mut self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, ChunkError> {
        let index = self.index;
        let last = index == self.chunk_count - 1;
        let nonce = nonce(&self.context.nonce_prefix, index);
        let aad = chunk_context(&self.context, index, last);
        let plain = self
            .cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: sealed,
                    aad: &aad,
                },
            )
            .map_err(|_| ChunkError(format!("chunk {index} failed authentication")))?;
        self.index += 1;
        Ok(Zeroizing::new(plain))
    }
}
