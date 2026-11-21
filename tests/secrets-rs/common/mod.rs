#![allow(dead_code)]

pub mod contract;
pub mod http;

use std::collections::HashMap;
use std::sync::Mutex;

use secrets::keys::{Key, KeyProvider, MasterKeyError, SealState, key_from_slice};
use uuid::Uuid;

pub const TENANT_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
pub const TENANT_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

pub fn tenant(id: &str) -> Uuid {
    Uuid::parse_str(id).expect("a test tenant ID is a UUID")
}

pub struct StaticKeyProvider {
    keys: HashMap<i32, [u8; 32]>,
    current: i32,
    state: Mutex<SealState>,
}

impl StaticKeyProvider {
    pub fn new(master_key: &[u8]) -> Self {
        Self::with_versions(&[(1, master_key)], 1)
    }

    pub fn with_versions(keys: &[(i32, &[u8])], current: i32) -> Self {
        Self {
            keys: keys
                .iter()
                .map(|(version, key)| {
                    let key: [u8; 32] = (*key).try_into().expect("a test master key is 32 bytes");
                    (*version, key)
                })
                .collect(),
            current,
            state: Mutex::new(SealState::Unsealed),
        }
    }

    pub fn random() -> Self {
        let mut key = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key);
        Self::new(&key)
    }

    pub fn set_state(&self, state: SealState) {
        *self.state.lock().expect("lock") = state;
    }
}

impl KeyProvider for StaticKeyProvider {
    fn state(&self) -> SealState {
        *self.state.lock().expect("lock")
    }

    fn current_version(&self) -> i32 {
        self.current
    }

    fn master_key(&self, version: i32) -> Result<Key, MasterKeyError> {
        if self.state() != SealState::Unsealed {
            return Err(MasterKeyError::Sealed);
        }
        self.keys
            .get(&version)
            .and_then(|key| key_from_slice(key))
            .ok_or(MasterKeyError::UnknownVersion)
    }

    fn begin_request(&self) -> bool {
        self.state() == SealState::Unsealed
    }

    fn end_request(&self) {}
}
