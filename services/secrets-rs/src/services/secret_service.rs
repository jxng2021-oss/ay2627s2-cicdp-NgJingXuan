use std::future::Future;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::crypto::aes_gcm::DecryptionError;
use crate::crypto::envelope::{
    EnvelopeError, decode_wrapped_key, decrypt_value, encode_wrapped_key, encrypt_value,
    unwrap_file_key, unwrap_signing_key, unwrap_tenant_key, wrap_file_key, wrap_signing_key,
    wrap_tenant_key,
};
use crate::keys::{Key, KeyProvider, random_key};
use crate::models::secret_model::{self as model, SecretSummary, TenantKeyRow, VersionSummary};

const FIRST_TENANT_KEY_VERSION: i32 = 1;

#[derive(Debug)]
pub enum ServiceError {
    Sealed,
    Decryption(DecryptionError),
    TenantShredded,
    AuditUnavailable,
    Database(sqlx::Error),
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sealed => write!(formatter, "the secrets service is sealed"),
            Self::Decryption(error) => write!(formatter, "{error}"),
            Self::TenantShredded => write!(formatter, "this tenant was shredded"),
            Self::AuditUnavailable => write!(formatter, "the audit event could not be saved"),
            Self::Database(error) => write!(formatter, "database error: {error}"),
        }
    }
}

impl std::error::Error for ServiceError {}

impl From<sqlx::Error> for ServiceError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<DecryptionError> for ServiceError {
    fn from(error: DecryptionError) -> Self {
        Self::Decryption(error)
    }
}

impl From<EnvelopeError> for ServiceError {
    fn from(error: EnvelopeError) -> Self {
        match error {
            EnvelopeError::Sealed => Self::Sealed,
            EnvelopeError::Decryption(error) => Self::Decryption(error),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedVersion {
    pub name: String,
    pub version: i32,
    pub created_at: DateTime<Utc>,
}

pub struct SecretValue {
    pub name: String,
    pub version: i32,
    pub value: Zeroizing<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

pub struct SecretService {
    db: PgPool,
    keys: Arc<dyn KeyProvider>,
}

impl SecretService {
    pub fn new(db: PgPool, keys: Arc<dyn KeyProvider>) -> Self {
        Self { db, keys }
    }

    pub async fn save<F, Fut>(
        &self,
        tenant_id: Uuid,
        name: &str,
        value: &str,
        before_commit: F,
    ) -> Result<SavedVersion, ServiceError>
    where
        F: FnOnce(SavedVersion) -> Fut,
        Fut: Future<Output = Result<(), ServiceError>>,
    {
        let mut tx = self.db.begin().await?;
        let secret = model::reserve_next_version(&mut tx, tenant_id, name).await?;
        let saved = self
            .write_version(
                &mut tx,
                tenant_id,
                secret.id,
                name,
                secret.latest_version,
                value,
            )
            .await?;
        before_commit(saved.clone()).await?;
        tx.commit().await?;
        Ok(saved)
    }

    pub async fn rotate<F, Fut>(
        &self,
        tenant_id: Uuid,
        name: &str,
        value: &str,
        before_commit: F,
    ) -> Result<Option<SavedVersion>, ServiceError>
    where
        F: FnOnce(SavedVersion) -> Fut,
        Fut: Future<Output = Result<(), ServiceError>>,
    {
        let mut tx = self.db.begin().await?;
        let Some(secret) =
            model::reserve_next_version_of_existing(&mut tx, tenant_id, name).await?
        else {
            return Ok(None);
        };
        let saved = self
            .write_version(
                &mut tx,
                tenant_id,
                secret.id,
                name,
                secret.latest_version,
                value,
            )
            .await?;
        before_commit(saved.clone()).await?;
        tx.commit().await?;
        Ok(Some(saved))
    }

    pub async fn describe(
        &self,
        tenant_id: Uuid,
        name: &str,
        version: Option<i32>,
    ) -> Result<Option<SavedVersion>, ServiceError> {
        let mut conn = self.db.acquire().await?;
        let Some(secret) = model::find_secret(&mut conn, tenant_id, name).await? else {
            return Ok(None);
        };
        let wanted = version.unwrap_or(secret.latest_version);
        Ok(model::find_version(&mut conn, secret.id, wanted)
            .await?
            .map(|row| SavedVersion {
                name: name.to_string(),
                version: wanted,
                created_at: row.created_at,
            }))
    }

    pub async fn read(
        &self,
        tenant_id: Uuid,
        name: &str,
        version: Option<i32>,
    ) -> Result<Option<SecretValue>, ServiceError> {
        let mut conn = self.db.acquire().await?;
        let Some(secret) = model::find_secret(&mut conn, tenant_id, name).await? else {
            return Ok(None);
        };
        let wanted = version.unwrap_or(secret.latest_version);
        let Some(row) = model::find_version(&mut conn, secret.id, wanted).await? else {
            return Ok(None);
        };
        let tenant_key = self
            .existing_tenant_key(&mut conn, tenant_id, row.tenant_key_version)
            .await?;
        let value = decrypt_value(
            &tenant_key,
            &tenant_id.to_string(),
            name,
            wanted,
            &row.data(),
        )?;
        Ok(Some(SecretValue {
            name: name.to_string(),
            version: wanted,
            value,
            created_at: row.created_at,
        }))
    }

    pub async fn list(
        &self,
        tenant_id: Uuid,
        limit: i64,
        cursor: Option<&str>,
    ) -> Result<Page<SecretSummary>, ServiceError> {
        let mut conn = self.db.acquire().await?;
        let rows = model::list_secrets(&mut conn, tenant_id, limit + 1, cursor).await?;
        Ok(page(rows, limit, |last| last.name.clone()))
    }

    pub async fn versions(
        &self,
        tenant_id: Uuid,
        name: &str,
        limit: i64,
        cursor: Option<i32>,
    ) -> Result<Option<Page<VersionSummary>>, ServiceError> {
        let mut conn = self.db.acquire().await?;
        let Some(secret) = model::find_secret(&mut conn, tenant_id, name).await? else {
            return Ok(None);
        };
        let rows = model::list_versions(&mut conn, secret.id, limit + 1, cursor).await?;
        Ok(Some(page(rows, limit, |last| last.version.to_string())))
    }

    pub async fn delete<F, Fut>(
        &self,
        tenant_id: Uuid,
        name: &str,
        before_commit: F,
    ) -> Result<bool, ServiceError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(), ServiceError>>,
    {
        let mut tx = self.db.begin().await?;
        let deleted = model::delete_secret(&mut tx, tenant_id, name).await?;
        if deleted {
            before_commit().await?;
        }
        tx.commit().await?;
        Ok(deleted)
    }

    pub async fn shred(&self, tenant_id: Uuid) -> Result<(), ServiceError> {
        let mut tx = self.db.begin().await?;
        model::shred_tenant(&mut tx, tenant_id).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn wrap_file_key(
        &self,
        tenant_id: Uuid,
        file_id: &str,
        file_key: &Key,
    ) -> Result<Vec<u8>, ServiceError> {
        let mut conn = self.db.acquire().await?;
        let (tenant_key, key_version) = self.active_tenant_key(&mut conn, tenant_id).await?;
        let data = wrap_file_key(
            &tenant_key,
            key_version,
            &tenant_id.to_string(),
            file_id,
            file_key,
        );
        Ok(encode_wrapped_key(&data))
    }

    pub async fn unwrap_file_key(
        &self,
        tenant_id: Uuid,
        file_id: &str,
        wrapped: &[u8],
    ) -> Result<Key, ServiceError> {
        let data = decode_wrapped_key(wrapped)?;
        let mut conn = self.db.acquire().await?;
        let tenant_key = self
            .existing_tenant_key(&mut conn, tenant_id, data.key_version)
            .await?;
        Ok(unwrap_file_key(
            &tenant_key,
            &tenant_id.to_string(),
            file_id,
            &data,
        )?)
    }

    pub async fn wrap_signing_key(
        &self,
        tenant_id: Uuid,
        pool_id: &str,
        data_key: &Key,
    ) -> Result<Vec<u8>, ServiceError> {
        let mut conn = self.db.acquire().await?;
        let (tenant_key, key_version) = self.active_tenant_key(&mut conn, tenant_id).await?;
        let data = wrap_signing_key(
            &tenant_key,
            key_version,
            &tenant_id.to_string(),
            pool_id,
            data_key,
        );
        Ok(encode_wrapped_key(&data))
    }

    pub async fn unwrap_signing_key(
        &self,
        tenant_id: Uuid,
        pool_id: &str,
        wrapped: &[u8],
    ) -> Result<Key, ServiceError> {
        let data = decode_wrapped_key(wrapped)?;
        let mut conn = self.db.acquire().await?;
        let tenant_key = self
            .existing_tenant_key(&mut conn, tenant_id, data.key_version)
            .await?;
        Ok(unwrap_signing_key(
            &tenant_key,
            &tenant_id.to_string(),
            pool_id,
            &data,
        )?)
    }

    async fn write_version(
        &self,
        conn: &mut PgConnection,
        tenant_id: Uuid,
        secret_id: Uuid,
        name: &str,
        version: i32,
        value: &str,
    ) -> Result<SavedVersion, ServiceError> {
        let (tenant_key, key_version) = self.active_tenant_key(conn, tenant_id).await?;
        let encrypted = encrypt_value(
            &tenant_key,
            key_version,
            &tenant_id.to_string(),
            name,
            version,
            value,
        );
        let created_at = model::insert_version(conn, secret_id, version, &encrypted).await?;
        Ok(SavedVersion {
            name: name.to_string(),
            version,
            created_at,
        })
    }

    async fn active_tenant_key(
        &self,
        conn: &mut PgConnection,
        tenant_id: Uuid,
    ) -> Result<(Key, i32), ServiceError> {
        let row = match model::find_active_tenant_key(conn, tenant_id).await? {
            Some(row) => row,
            None => self.create_tenant_key(conn, tenant_id).await?,
        };
        let key = unwrap_tenant_key(
            self.keys.as_ref(),
            &tenant_id.to_string(),
            row.key_version,
            &row.data(),
        )?;
        Ok((key, row.key_version))
    }

    async fn create_tenant_key(
        &self,
        conn: &mut PgConnection,
        tenant_id: Uuid,
    ) -> Result<TenantKeyRow, ServiceError> {
        if model::is_tenant_shredded(conn, tenant_id).await? {
            return Err(ServiceError::TenantShredded);
        }
        let new_key = random_key();
        let wrapped = wrap_tenant_key(
            self.keys.as_ref(),
            &tenant_id.to_string(),
            FIRST_TENANT_KEY_VERSION,
            &new_key,
        )?;
        model::insert_tenant_key_if_missing(conn, tenant_id, FIRST_TENANT_KEY_VERSION, &wrapped)
            .await?;
        model::find_active_tenant_key(conn, tenant_id)
            .await?
            .ok_or(ServiceError::Decryption(DecryptionError(
                "the tenant key was not saved",
            )))
    }

    async fn existing_tenant_key(
        &self,
        conn: &mut PgConnection,
        tenant_id: Uuid,
        key_version: i32,
    ) -> Result<Key, ServiceError> {
        let Some(row) = model::find_tenant_key(conn, tenant_id, key_version).await? else {
            if model::is_tenant_shredded(conn, tenant_id).await? {
                return Err(ServiceError::TenantShredded);
            }
            return Err(ServiceError::Decryption(DecryptionError(
                "tenant key not found",
            )));
        };
        Ok(unwrap_tenant_key(
            self.keys.as_ref(),
            &tenant_id.to_string(),
            key_version,
            &row.data(),
        )?)
    }
}

fn page<T>(mut rows: Vec<T>, limit: i64, cursor_of: impl Fn(&T) -> String) -> Page<T> {
    let limit = usize::try_from(limit).unwrap_or(0);
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = if more {
        rows.last().map(cursor_of)
    } else {
        None
    };
    Page {
        items: rows,
        next_cursor,
    }
}
