use zeroize::Zeroizing;

pub const KEY_BYTES: usize = 32;

pub type Key = Zeroizing<[u8; KEY_BYTES]>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealState {
    Uninitialised,
    Sealed,
    Unsealed,
}

impl SealState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Uninitialised => "uninitialised",
            Self::Sealed => "sealed",
            Self::Unsealed => "unsealed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasterKeyError {
    Sealed,
    UnknownVersion,
}

pub trait KeyProvider: Send + Sync {
    fn state(&self) -> SealState;
    fn current_version(&self) -> i32;
    fn master_key(&self, version: i32) -> Result<Key, MasterKeyError>;
    fn begin_request(&self) -> bool;
    fn end_request(&self);
}

pub fn key_from_slice(bytes: &[u8]) -> Option<Key> {
    let array: [u8; KEY_BYTES] = bytes.try_into().ok()?;
    Some(Zeroizing::new(array))
}

pub fn random_key() -> Key {
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, key.as_mut());
    key
}
