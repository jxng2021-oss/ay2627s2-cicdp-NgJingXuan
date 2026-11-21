use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
pub struct SealConfigRow {
    pub seal_id: Uuid,
    pub share_count: i16,
    pub threshold: i16,
    pub master_key_version: i32,
    pub format_version: i16,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub auth_tag: Vec<u8>,
}

pub async fn find_seal_config(db: &PgPool) -> Result<Option<SealConfigRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT seal_id, share_count, threshold, master_key_version, format_version, nonce, \
         ciphertext, auth_tag FROM seal_config",
    )
    .fetch_optional(db)
    .await
}

pub async fn insert_seal_config(db: &PgPool, row: &SealConfigRow) -> Result<bool, sqlx::Error> {
    let inserted = sqlx::query(
        "INSERT INTO seal_config (id, seal_id, share_count, threshold, master_key_version, \
         format_version, nonce, ciphertext, auth_tag) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT DO NOTHING",
    )
    .bind(row.seal_id)
    .bind(row.share_count)
    .bind(row.threshold)
    .bind(row.master_key_version)
    .bind(row.format_version)
    .bind(&row.nonce)
    .bind(&row.ciphertext)
    .bind(&row.auth_tag)
    .execute(db)
    .await?;
    Ok(inserted.rows_affected() > 0)
}

pub async fn has_encrypted_data(db: &PgPool) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM tenant_keys) OR EXISTS (SELECT 1 FROM secrets)",
    )
    .fetch_one(db)
    .await
}
