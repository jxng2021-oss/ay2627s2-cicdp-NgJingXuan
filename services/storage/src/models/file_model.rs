use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

const COLUMNS: &str = "id, tenant_id, blob_id, original_name, content_type, plain_size, \
    encrypted_size, encrypted_file_key, format_version, chunk_size, chunk_count, nonce_prefix, \
    checksum, status::text AS status, reserved_bytes, created_at, updated_at";

#[derive(Debug, Clone, FromRow)]
pub struct FileRow {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub blob_id: Uuid,
    pub original_name: Option<String>,
    pub content_type: String,
    pub plain_size: i64,
    pub encrypted_size: i64,
    pub encrypted_file_key: Vec<u8>,
    pub format_version: i16,
    pub chunk_size: i32,
    pub chunk_count: i32,
    pub nonce_prefix: Vec<u8>,
    pub checksum: Option<Vec<u8>>,
    pub status: String,
    pub reserved_bytes: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct NewFile {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub blob_id: Uuid,
    pub original_name: Option<String>,
    pub content_type: String,
    pub encrypted_file_key: Vec<u8>,
    pub format_version: i16,
    pub chunk_size: i32,
    pub nonce_prefix: Vec<u8>,
    pub reserved_bytes: i64,
}

pub struct UploadResult {
    pub plain_size: i64,
    pub encrypted_size: i64,
    pub chunk_count: i32,
    pub checksum: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub used_bytes: i64,
    pub reserved_bytes: i64,
}

pub struct Cursor {
    pub created_at: DateTime<Utc>,
    pub id: Uuid,
}

pub async fn reserve_space(
    db: &PgPool,
    tenant_id: Uuid,
    bytes: i64,
    limit: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query("INSERT INTO tenant_usage (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(tenant_id)
        .execute(db)
        .await?;
    let reserved = sqlx::query(
        "UPDATE tenant_usage SET reserved_bytes = reserved_bytes + $2 \
         WHERE tenant_id = $1 AND used_bytes + reserved_bytes + $2 <= $3",
    )
    .bind(tenant_id)
    .bind(bytes)
    .bind(limit)
    .execute(db)
    .await?;
    Ok(reserved.rows_affected() > 0)
}

pub async fn release_reservation(
    db: &PgPool,
    tenant_id: Uuid,
    bytes: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE tenant_usage SET reserved_bytes = greatest(reserved_bytes - $2, 0) WHERE tenant_id = $1",
    )
    .bind(tenant_id)
    .bind(bytes)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn file_exists_for_another_tenant(
    db: &PgPool,
    tenant_id: Uuid,
    id: Uuid,
) -> Result<bool, sqlx::Error> {
    let owner: Option<(Uuid,)> =
        sqlx::query_as("SELECT tenant_id FROM files WHERE id = $1 AND status = 'ready'")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(owner.is_some_and(|(owner,)| owner != tenant_id))
}

pub async fn get_usage(db: &PgPool, tenant_id: Uuid) -> Result<Usage, sqlx::Error> {
    let row: Option<(i64, i64)> =
        sqlx::query_as("SELECT used_bytes, reserved_bytes FROM tenant_usage WHERE tenant_id = $1")
            .bind(tenant_id)
            .fetch_optional(db)
            .await?;
    Ok(row
        .map(|(used_bytes, reserved_bytes)| Usage {
            used_bytes,
            reserved_bytes,
        })
        .unwrap_or_default())
}

pub async fn insert_uploading_file(db: &PgPool, file: NewFile) -> Result<FileRow, sqlx::Error> {
    sqlx::query_as(&format!(
        "INSERT INTO files (id, tenant_id, blob_id, original_name, content_type, \
         encrypted_file_key, format_version, chunk_size, nonce_prefix, reserved_bytes, status) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'uploading') RETURNING {COLUMNS}"
    ))
    .bind(file.id)
    .bind(file.tenant_id)
    .bind(file.blob_id)
    .bind(file.original_name)
    .bind(file.content_type)
    .bind(file.encrypted_file_key)
    .bind(file.format_version)
    .bind(file.chunk_size)
    .bind(file.nonce_prefix)
    .bind(file.reserved_bytes)
    .fetch_one(db)
    .await
}

pub async fn mark_ready(
    db: &PgPool,
    file: &FileRow,
    result: UploadResult,
) -> Result<FileRow, sqlx::Error> {
    let mut tx = db.begin().await?;
    let row: FileRow = sqlx::query_as(&format!(
        "UPDATE files SET plain_size = $2, encrypted_size = $3, chunk_count = $4, checksum = $5, \
         status = 'ready', reserved_bytes = 0, updated_at = now() \
         WHERE id = $1 AND status = 'uploading' RETURNING {COLUMNS}"
    ))
    .bind(file.id)
    .bind(result.plain_size)
    .bind(result.encrypted_size)
    .bind(result.chunk_count)
    .bind(result.checksum)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE tenant_usage SET used_bytes = used_bytes + $2, \
         reserved_bytes = greatest(reserved_bytes - $3, 0) WHERE tenant_id = $1",
    )
    .bind(file.tenant_id)
    .bind(result.plain_size)
    .bind(file.reserved_bytes)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn remove_failed_upload(db: &PgPool, file: &FileRow) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    let deleted = sqlx::query("DELETE FROM files WHERE id = $1 AND status = 'uploading'")
        .bind(file.id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() > 0 {
        sqlx::query(
            "UPDATE tenant_usage SET reserved_bytes = greatest(reserved_bytes - $2, 0) WHERE tenant_id = $1",
        )
        .bind(file.tenant_id)
        .bind(file.reserved_bytes)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn find_ready_file(
    db: &PgPool,
    tenant_id: Uuid,
    id: Uuid,
) -> Result<Option<FileRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM files WHERE id = $1 AND tenant_id = $2 AND status = 'ready'"
    ))
    .bind(id)
    .bind(tenant_id)
    .fetch_optional(db)
    .await
}

pub async fn list_ready_files(
    db: &PgPool,
    tenant_id: Uuid,
    limit: i64,
    after: Option<&Cursor>,
) -> Result<Vec<FileRow>, sqlx::Error> {
    match after {
        None => {
            sqlx::query_as(&format!(
                "SELECT {COLUMNS} FROM files WHERE tenant_id = $1 AND status = 'ready' \
                 ORDER BY created_at DESC, id DESC LIMIT $2"
            ))
            .bind(tenant_id)
            .bind(limit)
            .fetch_all(db)
            .await
        }
        Some(cursor) => {
            sqlx::query_as(&format!(
                "SELECT {COLUMNS} FROM files WHERE tenant_id = $1 AND status = 'ready' \
                 AND (created_at < $3 OR (created_at = $3 AND id < $4)) \
                 ORDER BY created_at DESC, id DESC LIMIT $2"
            ))
            .bind(tenant_id)
            .bind(limit)
            .bind(cursor.created_at)
            .bind(cursor.id)
            .fetch_all(db)
            .await
        }
    }
}

pub async fn mark_deleting(
    db: &PgPool,
    tenant_id: Uuid,
    id: Uuid,
) -> Result<Option<FileRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "UPDATE files SET status = 'deleting', encrypted_file_key = ''::bytea, updated_at = now() \
         WHERE id = $1 AND tenant_id = $2 AND status IN ('ready', 'deleting') RETURNING {COLUMNS}"
    ))
    .bind(id)
    .bind(tenant_id)
    .fetch_optional(db)
    .await
}

pub async fn mark_tenant_deleting(
    db: &PgPool,
    tenant_id: Uuid,
) -> Result<Vec<FileRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "UPDATE files SET status = 'deleting', encrypted_file_key = ''::bytea, updated_at = now() \
         WHERE tenant_id = $1 RETURNING {COLUMNS}"
    ))
    .bind(tenant_id)
    .fetch_all(db)
    .await
}

pub async fn remove_tenant_records(db: &PgPool, tenant_id: Uuid) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM files WHERE tenant_id = $1")
        .bind(tenant_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM tenant_usage WHERE tenant_id = $1")
        .bind(tenant_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

pub async fn remove_deleted_file(db: &PgPool, file: &FileRow) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    let deleted = sqlx::query("DELETE FROM files WHERE id = $1 AND status = 'deleting'")
        .bind(file.id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() > 0 {
        sqlx::query(
            "UPDATE tenant_usage SET used_bytes = greatest(used_bytes - $2, 0) WHERE tenant_id = $1",
        )
        .bind(file.tenant_id)
        .bind(file.plain_size)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn unfinished_files(db: &PgPool) -> Result<Vec<FileRow>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM files WHERE status IN ('uploading', 'deleting')"
    ))
    .fetch_all(db)
    .await
}

pub async fn all_blob_ids(db: &PgPool) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid,)> = sqlx::query_as("SELECT blob_id FROM files")
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

pub async fn delete_record(db: &PgPool, id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM files WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn recompute_usage(db: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE tenant_usage SET reserved_bytes = 0, used_bytes = coalesce(\
         (SELECT sum(plain_size) FROM files WHERE files.tenant_id = tenant_usage.tenant_id \
         AND files.status = 'ready'), 0)",
    )
    .execute(db)
    .await?;
    Ok(())
}
