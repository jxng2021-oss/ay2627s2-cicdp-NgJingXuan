use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use sqlx::PgPool;
use tokio::sync::Notify;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::crypto::aes_gcm::{Sealed, open, seal};
use crate::crypto::envelope::FORMAT_VERSION;
use crate::keys::{Key, KeyProvider, MasterKeyError, SealState, key_from_slice, random_key};
use crate::models::seal_model::{
    SealConfigRow, find_seal_config, has_encrypted_data, insert_seal_config,
};
use crate::seal::shamir::{combine, split};
use crate::seal::shares::{decode_share, encode_share, share_number};

pub const SHARE_COUNT: usize = 5;
pub const THRESHOLD: usize = 3;
const FIRST_MASTER_KEY_VERSION: i32 = 1;

#[derive(Debug, Clone)]
pub struct SealSettings {
    pub unseal_timeout: Duration,
    pub max_failed_attempts: u32,
    pub lockout: Duration,
    pub drain_timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SealStatus {
    pub initialised: bool,
    pub sealed: bool,
    pub shares: usize,
    pub threshold: usize,
    pub progress: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnsealResult {
    #[serde(flatten)]
    pub status: SealStatus,
    pub duplicate: bool,
}

pub struct Initialised {
    pub shares: Vec<Zeroizing<String>>,
    pub threshold: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealReason {
    Operator,
    Shutdown,
}

#[derive(Debug)]
pub enum SealError {
    AlreadyInitialised,
    LeftoverData,
    NotInitialised,
    InvalidShare,
    UnsealFailed,
    TooManyAttempts { retry_after_seconds: u64 },
    AuditUnavailable,
    Internal(&'static str),
    Database(sqlx::Error),
}

impl std::fmt::Display for SealError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyInitialised => {
                formatter.write_str("The secrets service is already initialised")
            }
            Self::LeftoverData => formatter
                .write_str("The database already holds encrypted data from an earlier setup"),
            Self::NotInitialised => {
                formatter.write_str("The secrets service hasn't been initialised yet")
            }
            Self::InvalidShare => formatter.write_str("That isn't a valid unseal key share"),
            Self::UnsealFailed => {
                formatter.write_str("Unsealing failed. Progress was cleared; start again.")
            }
            Self::TooManyAttempts { .. } => {
                formatter.write_str("Too many failed unseal attempts; try again later")
            }
            Self::AuditUnavailable => formatter.write_str("the audit event could not be saved"),
            Self::Internal(reason) => write!(formatter, "internal error: {reason}"),
            Self::Database(error) => write!(formatter, "database error: {error}"),
        }
    }
}

impl std::error::Error for SealError {}

impl From<sqlx::Error> for SealError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

pub type AuditFuture = Pin<Box<dyn Future<Output = Result<(), ()>> + Send>>;
pub type SealAudit = Arc<dyn Fn(&'static str) -> AuditFuture + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> Duration + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
    })
}

pub fn no_audit() -> SealAudit {
    Arc::new(|_| Box::pin(async { Ok(()) }))
}

#[derive(Default)]
struct Inner {
    config: Option<SealConfigRow>,
    master_key: Option<Key>,
    sealing: bool,
    submitted: BTreeMap<u8, Zeroizing<Vec<u8>>>,
    progress_generation: u64,
    failed_attempts: u32,
    locked_until: Duration,
    initialising: bool,
}

impl Inner {
    fn state(&self) -> SealState {
        match (&self.config, &self.master_key) {
            (None, _) => SealState::Uninitialised,
            (Some(_), Some(_)) if !self.sealing => SealState::Unsealed,
            _ => SealState::Sealed,
        }
    }

    fn status(&self) -> SealStatus {
        SealStatus {
            initialised: self.config.is_some(),
            sealed: self.state() != SealState::Unsealed,
            shares: self.config.as_ref().map_or(SHARE_COUNT, |config| {
                usize::try_from(config.share_count).unwrap_or(0)
            }),
            threshold: self.config.as_ref().map_or(THRESHOLD, |config| {
                usize::try_from(config.threshold).unwrap_or(0)
            }),
            progress: self.submitted.len(),
        }
    }

    fn clear_progress(&mut self) {
        self.submitted.clear();
        self.progress_generation += 1;
    }
}

pub struct SealManager {
    db: PgPool,
    settings: SealSettings,
    now: Clock,
    audit: SealAudit,
    inner: Arc<Mutex<Inner>>,
    active_requests: AtomicUsize,
    drained: Notify,
}

fn master_key_context(config: &SealConfigRow) -> Vec<u8> {
    json!([
        "master-key",
        config.format_version,
        config.seal_id.to_string(),
        config.master_key_version,
        config.share_count,
        config.threshold
    ])
    .to_string()
    .into_bytes()
}

fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn sealed_master_key(config: &SealConfigRow) -> Sealed {
    Sealed {
        nonce: config.nonce.clone(),
        ciphertext: config.ciphertext.clone(),
        auth_tag: config.auth_tag.clone(),
    }
}

fn open_master_key(shares: &[Zeroizing<Vec<u8>>], config: &SealConfigRow) -> Option<Key> {
    let parts: Vec<&[u8]> = shares.iter().map(|share| share.as_slice()).collect();
    let unseal_key = key_from_slice(&combine(&parts).ok()?)?;
    let master = open(
        &unseal_key,
        &sealed_master_key(config),
        &master_key_context(config),
    )
    .ok()?;
    key_from_slice(&master)
}

impl SealManager {
    pub fn new(db: PgPool, settings: SealSettings, now: Clock, audit: SealAudit) -> Self {
        Self {
            db,
            settings,
            now,
            audit,
            inner: Arc::new(Mutex::new(Inner::default())),
            active_requests: AtomicUsize::new(0),
            drained: Notify::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub async fn load(&self) -> Result<(), SealError> {
        let config = find_seal_config(&self.db).await?;
        self.lock().config = config;
        Ok(())
    }

    pub fn status(&self) -> SealStatus {
        self.lock().status()
    }

    pub async fn initialise(&self) -> Result<Initialised, SealError> {
        {
            let mut inner = self.lock();
            if inner.initialising {
                return Err(SealError::AlreadyInitialised);
            }
            inner.initialising = true;
        }
        let result = self.create_seal().await;
        self.lock().initialising = false;
        result
    }

    async fn create_seal(&self) -> Result<Initialised, SealError> {
        self.load().await?;
        if self.lock().config.is_some() {
            return Err(SealError::AlreadyInitialised);
        }
        if has_encrypted_data(&self.db).await? {
            return Err(SealError::LeftoverData);
        }

        let master_key = random_key();
        let unseal_key = random_key();
        let mut config = SealConfigRow {
            seal_id: Uuid::new_v4(),
            share_count: SHARE_COUNT as i16,
            threshold: THRESHOLD as i16,
            master_key_version: FIRST_MASTER_KEY_VERSION,
            format_version: FORMAT_VERSION,
            nonce: Vec::new(),
            ciphertext: Vec::new(),
            auth_tag: Vec::new(),
        };
        let encrypted = seal(
            &unseal_key,
            master_key.as_ref(),
            &master_key_context(&config),
        );
        config.nonce = encrypted.nonce;
        config.ciphertext = encrypted.ciphertext;
        config.auth_tag = encrypted.auth_tag;

        let shares = split(unseal_key.as_ref(), SHARE_COUNT, THRESHOLD)
            .map_err(|_| SealError::Internal("splitting the unseal key failed"))?;
        check_every_combination(&shares, &unseal_key, &master_key, &config)?;

        (self.audit)("secrets.initialised")
            .await
            .map_err(|()| SealError::AuditUnavailable)?;
        if !insert_seal_config(&self.db, &config).await? {
            return Err(SealError::AlreadyInitialised);
        }
        self.load().await?;
        Ok(Initialised {
            shares: shares.iter().map(|share| encode_share(share)).collect(),
            threshold: THRESHOLD,
        })
    }

    pub async fn submit_share(&self, text: &str) -> Result<UnsealResult, SealError> {
        if self.lock().config.is_none() {
            self.load().await?;
            if self.lock().config.is_none() {
                return Err(SealError::NotInitialised);
            }
        }

        let (shares, config) = {
            let mut inner = self.lock();
            if inner.state() == SealState::Unsealed {
                return Ok(UnsealResult {
                    status: inner.status(),
                    duplicate: false,
                });
            }
            let now = (self.now)();
            if now < inner.locked_until {
                let wait = inner.locked_until - now;
                return Err(SealError::TooManyAttempts {
                    retry_after_seconds: wait.as_millis().div_ceil(1000) as u64,
                });
            }

            let Ok(share) = decode_share(text) else {
                self.record_failure(&mut inner);
                return Err(SealError::InvalidShare);
            };
            let number = share_number(&share);
            if let Some(existing) = inner.submitted.get(&number) {
                if same_bytes(existing, &share) {
                    return Ok(UnsealResult {
                        status: inner.status(),
                        duplicate: true,
                    });
                }
                self.record_failure(&mut inner);
                return Err(SealError::InvalidShare);
            }

            inner.submitted.insert(number, share);
            if inner.submitted.len() == 1 {
                self.clear_progress_later(inner.progress_generation);
            }
            let Some(config) = inner.config.clone() else {
                return Err(SealError::NotInitialised);
            };
            if inner.submitted.len() < usize::try_from(config.threshold).unwrap_or(THRESHOLD) {
                return Ok(UnsealResult {
                    status: inner.status(),
                    duplicate: false,
                });
            }
            let shares: Vec<Zeroizing<Vec<u8>>> = inner.submitted.values().cloned().collect();
            inner.clear_progress();
            (shares, config)
        };

        let Some(master_key) = open_master_key(&shares, &config) else {
            let mut inner = self.lock();
            self.record_failure(&mut inner);
            return Err(SealError::UnsealFailed);
        };
        drop(shares);

        (self.audit)("secrets.unsealed")
            .await
            .map_err(|()| SealError::AuditUnavailable)?;
        let mut inner = self.lock();
        inner.master_key = Some(master_key);
        inner.sealing = false;
        inner.failed_attempts = 0;
        Ok(UnsealResult {
            status: SealStatus {
                progress: 0,
                ..inner.status()
            },
            duplicate: false,
        })
    }

    pub async fn seal(&self, reason: SealReason) -> Result<(), SealError> {
        let record = {
            let mut inner = self.lock();
            inner.clear_progress();
            if inner.master_key.is_none() {
                return Ok(());
            }
            reason == SealReason::Operator && !inner.sealing
        };
        if record {
            (self.audit)("secrets.sealed")
                .await
                .map_err(|()| SealError::AuditUnavailable)?;
        }
        self.lock().sealing = true;
        self.wait_for_requests().await;
        let mut inner = self.lock();
        inner.master_key = None;
        inner.sealing = false;
        Ok(())
    }

    pub fn active_requests(&self) -> usize {
        self.active_requests.load(Ordering::SeqCst)
    }

    async fn wait_for_requests(&self) {
        let deadline = tokio::time::Instant::now() + self.settings.drain_timeout;
        loop {
            let drained = self.drained.notified();
            tokio::pin!(drained);
            drained.as_mut().enable();
            if self.active_requests.load(Ordering::SeqCst) == 0 {
                return;
            }
            if tokio::time::timeout_at(deadline, drained).await.is_err() {
                return;
            }
        }
    }

    fn record_failure(&self, inner: &mut Inner) {
        inner.failed_attempts += 1;
        if inner.failed_attempts >= self.settings.max_failed_attempts {
            inner.failed_attempts = 0;
            inner.locked_until = (self.now)() + self.settings.lockout;
            inner.clear_progress();
        }
    }

    fn clear_progress_later(&self, generation: u64) {
        let inner = self.inner.clone();
        let timeout = self.settings.unseal_timeout;
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            let mut inner = inner.lock().unwrap_or_else(PoisonError::into_inner);
            if inner.progress_generation == generation {
                inner.clear_progress();
            }
        });
    }
}

fn check_every_combination(
    shares: &[Zeroizing<Vec<u8>>],
    unseal_key: &Key,
    master_key: &Key,
    config: &SealConfigRow,
) -> Result<(), SealError> {
    for first in 0..shares.len() {
        for second in first + 1..shares.len() {
            for third in second + 1..shares.len() {
                let group = [
                    shares[first].as_slice(),
                    shares[second].as_slice(),
                    shares[third].as_slice(),
                ];
                let rebuilt =
                    combine(&group).map_err(|_| SealError::Internal("share check failed"))?;
                let opened = open(
                    &key_from_slice(&rebuilt).ok_or(SealError::Internal("share check failed"))?,
                    &sealed_master_key(config),
                    &master_key_context(config),
                )
                .map_err(|_| SealError::Internal("share check failed"))?;
                if !same_bytes(&rebuilt, unseal_key.as_ref())
                    || !same_bytes(&opened, master_key.as_ref())
                {
                    return Err(SealError::Internal("share check failed"));
                }
            }
        }
    }
    Ok(())
}

impl KeyProvider for SealManager {
    fn state(&self) -> SealState {
        self.lock().state()
    }

    fn current_version(&self) -> i32 {
        self.lock()
            .config
            .as_ref()
            .map_or(FIRST_MASTER_KEY_VERSION, |config| config.master_key_version)
    }

    fn master_key(&self, version: i32) -> Result<Key, MasterKeyError> {
        let inner = self.lock();
        let Some(key) = &inner.master_key else {
            return Err(MasterKeyError::Sealed);
        };
        let current = inner
            .config
            .as_ref()
            .map_or(FIRST_MASTER_KEY_VERSION, |config| config.master_key_version);
        if version != current {
            return Err(MasterKeyError::UnknownVersion);
        }
        Ok(Zeroizing::new(**key))
    }

    fn begin_request(&self) -> bool {
        let inner = self.lock();
        if inner.state() != SealState::Unsealed {
            return false;
        }
        self.active_requests.fetch_add(1, Ordering::SeqCst);
        true
    }

    fn end_request(&self) {
        let previous = self
            .active_requests
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                Some(count.saturating_sub(1))
            })
            .unwrap_or(0);
        if previous <= 1 {
            self.drained.notify_waiters();
        }
    }
}
