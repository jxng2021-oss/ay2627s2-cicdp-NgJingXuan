use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::crypto::envelope::EncryptedData;

#[derive(Debug, Clone, FromRow)]
pub struct TenantKeyRow {
    pub tenant_id: Uuid,
    pub key_version: i32,
    pub master_key_version: i32,
    pub format_version: i16,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub auth_tag: Vec<u8>,
}

impl TenantKeyRow {
    pub fn data(&self) -> EncryptedData {
        EncryptedData {
            format_version: self.format_version,
            key_version: self.master_key_version,
            nonce: self.nonce.clone(),
            ciphertext: self.ciphertext.clone(),
            auth_tag: self.auth_tag.clone(),
        }
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct SecretRow {
    pub id: Uuid,
    pub name: String,
    pub latest_version: i32,
}

#[derive(Debug, Clone, FromRow)]
pub struct VersionRow {
    pub version: i32,
    pub tenant_key_version: i32,
    pub format_version: i16,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub auth_tag: Vec<u8>,
    pub created_at: DateTime<Utc>,
}

impl VersionRow {
    pub fn data(&self) -> EncryptedData {
        EncryptedData {
            format_version: self.format_version,
            key_version: self.tenant_key_version,
            nonce: self.nonce.clone(),
            ciphertext: self.ciphertext.clone(),
            auth_tag: self.auth_tag.clone(),
        }
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct SecretSummary {
    pub name: String,
    pub latest_version: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct VersionSummary {
    pub version: i32,
    pub created_at: DateTime<Utc>,
}

const SELECT_TENANT_KEY: &str = "SELECT tenant_id, key_version, master_key_version, format_version, \
     nonce, ciphertext, auth_tag FROM tenant_keys";

pub async fn find_active_tenant_key(
    conn: &mut PgConnection,
    tenant_id: Uuid,
) -> Result<Option<TenantKeyRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "{SELECT_TENANT_KEY} WHERE tenant_id = $1 AND status = 'active'"
    ))
    .bind(tenant_id)
    .fetch_optional(conn)
    .await
}

pub async fn find_tenant_key(
    conn: &mut PgConnection,
    tenant_id: Uuid,
    key_version: i32,
) -> Result<Option<TenantKeyRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "{SELECT_TENANT_KEY} WHERE tenant_id = $1 AND key_version = $2"
    ))
    .bind(tenant_id)
    .bind(key_version)
    .fetch_optional(conn)
    .await
}

pub async fn insert_tenant_key_if_missing(
    conn: &mut PgConnection,
    tenant_id: Uuid,
    key_version: i32,
    data: &EncryptedData,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO tenant_keys (tenant_id, key_version, status, master_key_version, \
         format_version, nonce, ciphertext, auth_tag) \
         VALUES ($1, $2, 'active', $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
    )
    .bind(tenant_id)
    .bind(key_version)
    .bind(data.key_version)
    .bind(data.format_version)
    .bind(&data.nonce)
    .bind(&data.ciphertext)
    .bind(&data.auth_tag)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn reserve_next_version(
    conn: &mut PgConnection,
    tenant_id: Uuid,
    name: &str,
) -> Result<SecretRow, sqlx::Error> {
    sqlx::query_as(
        "INSERT INTO secrets (tenant_id, name, latest_version) VALUES ($1, $2, 1) \
         ON CONFLICT (tenant_id, name) DO UPDATE \
         SET latest_version = secrets.latest_version + 1, updated_at = now() \
         RETURNING id, name, latest_version",
    )
    .bind(tenant_id)
    .bind(name)
    .fetch_one(conn)
    .await
}

pub async fn reserve_next_version_of_existing(
    conn: &mut PgConnection,
    tenant_id: Uuid,
    name: &str,
) -> Result<Option<SecretRow>, sqlx::Error> {
    sqlx::query_as(
        "UPDATE secrets SET latest_version = latest_version + 1, updated_at = now() \
         WHERE tenant_id = $1 AND name = $2 RETURNING id, name, latest_version",
    )
    .bind(tenant_id)
    .bind(name)
    .fetch_optional(conn)
    .await
}

pub async fn insert_version(
    conn: &mut PgConnection,
    secret_id: Uuid,
    version: i32,
    data: &EncryptedData,
) -> Result<DateTime<Utc>, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO secret_versions (secret_id, version, tenant_key_version, format_version, \
         nonce, ciphertext, auth_tag) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING created_at",
    )
    .bind(secret_id)
    .bind(version)
    .bind(data.key_version)
    .bind(data.format_version)
    .bind(&data.nonce)
    .bind(&data.ciphertext)
    .bind(&data.auth_tag)
    .fetch_one(conn)
    .await
}

pub async fn find_secret(
    conn: &mut PgConnection,
    tenant_id: Uuid,
    name: &str,
) -> Result<Option<SecretRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, name, latest_version FROM secrets WHERE tenant_id = $1 AND name = $2",
    )
    .bind(tenant_id)
    .bind(name)
    .fetch_optional(conn)
    .await
}

pub async fn find_version(
    conn: &mut PgConnection,
    secret_id: Uuid,
    version: i32,
) -> Result<Option<VersionRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT version, tenant_key_version, format_version, nonce, ciphertext, auth_tag, \
         created_at FROM secret_versions WHERE secret_id = $1 AND version = $2",
    )
    .bind(secret_id)
    .bind(version)
    .fetch_optional(conn)
    .await
}

pub async fn list_secrets(
    conn: &mut PgConnection,
    tenant_id: Uuid,
    limit: i64,
    after_name: Option<&str>,
) -> Result<Vec<SecretSummary>, sqlx::Error> {
    sqlx::query_as(
        "SELECT name, latest_version, created_at, updated_at FROM secrets \
         WHERE tenant_id = $1 AND ($2::text IS NULL OR name > $2) ORDER BY name ASC LIMIT $3",
    )
    .bind(tenant_id)
    .bind(after_name)
    .bind(limit)
    .fetch_all(conn)
    .await
}

pub async fn list_versions(
    conn: &mut PgConnection,
    secret_id: Uuid,
    limit: i64,
    before_version: Option<i32>,
) -> Result<Vec<VersionSummary>, sqlx::Error> {
    sqlx::query_as(
        "SELECT version, created_at FROM secret_versions \
         WHERE secret_id = $1 AND ($2::integer IS NULL OR version < $2) \
         ORDER BY version DESC LIMIT $3",
    )
    .bind(secret_id)
    .bind(before_version)
    .bind(limit)
    .fetch_all(conn)
    .await
}

pub async fn delete_secret(
    conn: &mut PgConnection,
    tenant_id: Uuid,
    name: &str,
) -> Result<bool, sqlx::Error> {
    let deleted = sqlx::query("DELETE FROM secrets WHERE tenant_id = $1 AND name = $2")
        .bind(tenant_id)
        .bind(name)
        .execute(conn)
        .await?;
    Ok(deleted.rows_affected() > 0)
}

pub async fn shred_tenant(conn: &mut PgConnection, tenant_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO shredded_tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(tenant_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM secrets WHERE tenant_id = $1")
        .bind(tenant_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM tenant_keys WHERE tenant_id = $1")
        .bind(tenant_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

pub async fn is_tenant_shredded(
    conn: &mut PgConnection,
    tenant_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM shredded_tenants WHERE tenant_id = $1)")
        .bind(tenant_id)
        .fetch_one(conn)
        .await
}
