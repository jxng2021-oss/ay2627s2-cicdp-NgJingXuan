use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::{Stream, StreamExt};
use rand::RngCore;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::crypto::chunks::{
    CHUNK_SIZE, Decryptor, Encryptor, FORMAT_VERSION, FileContext, KEY_BYTES, NONCE_PREFIX_BYTES,
};
use crate::errors::AppError;
use crate::models::file_model::{self, Cursor, FileRow, NewFile, UploadResult, Usage};
use crate::services::file_key_service::{FileKeyError, FileKeyService};

pub struct FileServiceOptions {
    pub db: PgPool,
    pub data_dir: PathBuf,
    pub max_upload_bytes: u64,
    pub quota_bytes: u64,
    pub file_keys: Arc<dyn FileKeyService>,
    pub chunk_size: usize,
}

pub struct Upload {
    pub name: Option<String>,
    pub content_type: String,
    pub declared_bytes: Option<u64>,
}

pub struct Page {
    pub files: Vec<FileRow>,
    pub next_cursor: Option<String>,
}

pub type PlainStream = std::pin::Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

pub struct FileService {
    db: PgPool,
    data_dir: PathBuf,
    max_upload_bytes: u64,
    quota_bytes: u64,
    file_keys: Arc<dyn FileKeyService>,
    chunk_size: usize,
}

pub fn blob_path(data_dir: &Path, tenant_id: Uuid, blob_id: Uuid) -> PathBuf {
    data_dir
        .join(tenant_id.to_string())
        .join(blob_id.to_string())
}

pub fn temp_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(".tmp")
}

fn file_key_error(error: FileKeyError) -> AppError {
    match error {
        FileKeyError::Sealed => AppError::secrets_sealed(),
        FileKeyError::Rejected => {
            tracing::error!("a file key was rejected by the secrets service");
            AppError::internal()
        }
        FileKeyError::Unavailable => {
            tracing::warn!("the secrets service is unavailable");
            AppError::keys_unavailable()
        }
    }
}

fn context_of(file: &FileRow) -> Result<FileContext, AppError> {
    let nonce_prefix: [u8; NONCE_PREFIX_BYTES] = file
        .nonce_prefix
        .as_slice()
        .try_into()
        .map_err(|_| AppError::internal())?;
    Ok(FileContext {
        tenant_id: file.tenant_id,
        file_id: file.id,
        nonce_prefix,
        chunk_size: usize::try_from(file.chunk_size).map_err(|_| AppError::internal())?,
    })
}

pub fn make_cursor(file: &FileRow) -> String {
    let created = file.created_at.to_rfc3339_opts(SecondsFormat::Micros, true);
    URL_SAFE_NO_PAD.encode(serde_json::json!([created, file.id]).to_string())
}

pub fn parse_cursor(text: &str) -> Option<Cursor> {
    let raw = URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).ok()?;
    let (created, id): (String, String) = serde_json::from_slice(&raw).ok()?;
    Some(Cursor {
        created_at: DateTime::parse_from_rfc3339(&created)
            .ok()?
            .with_timezone(&Utc),
        id: Uuid::parse_str(&id).ok()?,
    })
}

struct Received {
    encrypted_size: u64,
    checksum: Vec<u8>,
    plain_size: u64,
    chunk_count: u32,
}

impl FileService {
    pub fn new(options: FileServiceOptions) -> Self {
        Self {
            db: options.db,
            data_dir: options.data_dir,
            max_upload_bytes: options.max_upload_bytes,
            quota_bytes: options.quota_bytes,
            file_keys: options.file_keys,
            chunk_size: if options.chunk_size == 0 {
                CHUNK_SIZE
            } else {
                options.chunk_size
            },
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub async fn is_another_tenants_file(&self, tenant_id: Uuid, id: &str) -> bool {
        match Uuid::parse_str(id) {
            Ok(id) => file_model::file_exists_for_another_tenant(&self.db, tenant_id, id)
                .await
                .unwrap_or(false),
            Err(_) => false,
        }
    }

    pub async fn upload<S, E>(
        &self,
        tenant_id: Uuid,
        upload: Upload,
        body: &mut S,
        request_id: &str,
    ) -> Result<FileRow, AppError>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
        E: Display,
    {
        if upload
            .declared_bytes
            .is_some_and(|declared| declared > self.max_upload_bytes)
        {
            return Err(AppError::upload_too_large());
        }
        let reservation = upload.declared_bytes.unwrap_or(self.max_upload_bytes);
        let reservation_i64 =
            i64::try_from(reservation).map_err(|_| AppError::upload_too_large())?;
        let quota = i64::try_from(self.quota_bytes).unwrap_or(i64::MAX);
        if !file_model::reserve_space(&self.db, tenant_id, reservation_i64, quota).await? {
            return Err(AppError::quota_exceeded());
        }

        let file_id = Uuid::new_v4();
        let blob_id = Uuid::new_v4();
        let mut file_key = Zeroizing::new([0u8; KEY_BYTES]);
        OsRng.fill_bytes(file_key.as_mut());

        let wrapped = match self
            .file_keys
            .wrap(tenant_id, file_id, file_key.as_ref(), request_id)
            .await
        {
            Ok(wrapped) => wrapped,
            Err(error) => {
                file_model::release_reservation(&self.db, tenant_id, reservation_i64).await?;
                return Err(file_key_error(error));
            }
        };

        let mut nonce_prefix = [0u8; NONCE_PREFIX_BYTES];
        OsRng.fill_bytes(&mut nonce_prefix);
        let record = file_model::insert_uploading_file(
            &self.db,
            NewFile {
                id: file_id,
                tenant_id,
                blob_id,
                original_name: upload.name,
                content_type: upload.content_type,
                encrypted_file_key: wrapped,
                format_version: FORMAT_VERSION,
                chunk_size: i32::try_from(self.chunk_size).map_err(|_| AppError::internal())?,
                nonce_prefix: nonce_prefix.to_vec(),
                reserved_bytes: reservation_i64,
            },
        )
        .await?;

        let temp_path = temp_dir(&self.data_dir).join(format!("{blob_id}.part"));
        let final_path = blob_path(&self.data_dir, tenant_id, blob_id);
        let limit = self.max_upload_bytes.min(reservation);
        let context = FileContext {
            tenant_id,
            file_id,
            nonce_prefix,
            chunk_size: self.chunk_size,
        };

        let saved = self
            .save_encrypted(
                body,
                &temp_path,
                &final_path,
                limit,
                file_key.as_ref(),
                context,
            )
            .await;
        drop(file_key);

        let received = match saved {
            Ok(received) => received,
            Err(error) => {
                let _ = fs::remove_file(&temp_path).await;
                let _ = fs::remove_file(&final_path).await;
                file_model::remove_failed_upload(&self.db, &record).await?;
                return Err(error);
            }
        };

        let ready = file_model::mark_ready(
            &self.db,
            &record,
            UploadResult {
                plain_size: i64::try_from(received.plain_size).map_err(|_| AppError::internal())?,
                encrypted_size: i64::try_from(received.encrypted_size)
                    .map_err(|_| AppError::internal())?,
                chunk_count: i32::try_from(received.chunk_count)
                    .map_err(|_| AppError::internal())?,
                checksum: received.checksum,
            },
        )
        .await;
        match ready {
            Ok(ready) => Ok(ready),
            Err(error) => {
                let _ = fs::remove_file(&final_path).await;
                let _ = file_model::remove_failed_upload(&self.db, &record).await;
                Err(error.into())
            }
        }
    }

    async fn save_encrypted<S, E>(
        &self,
        body: &mut S,
        temp_path: &Path,
        final_path: &Path,
        limit: u64,
        key: &[u8],
        context: FileContext,
    ) -> Result<Received, AppError>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
        E: Display,
    {
        fs::create_dir_all(temp_dir(&self.data_dir)).await?;
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp_path)
            .await?;
        let mut encryptor = Encryptor::new(key, context).map_err(|_| AppError::internal())?;
        let mut hash = Sha256::new();
        let mut encrypted_size = 0u64;
        let mut received = 0u64;

        while let Some(frame) = body.next().await {
            let data = frame.map_err(|error| {
                tracing::warn!(error = %error, "upload stopped part-way");
                AppError::bad_request("The upload was interrupted")
            })?;
            received += data.len() as u64;
            if received > limit {
                return Err(AppError::upload_too_large());
            }
            let sealed = encryptor.push(&data).map_err(|_| AppError::internal())?;
            if !sealed.is_empty() {
                hash.update(&sealed);
                encrypted_size += sealed.len() as u64;
                out.write_all(&sealed).await?;
            }
        }
        let sealed = encryptor.finish().map_err(|_| AppError::internal())?;
        hash.update(&sealed);
        encrypted_size += sealed.len() as u64;
        out.write_all(&sealed).await?;
        out.sync_all().await?;
        drop(out);

        if let Some(folder) = final_path.parent() {
            fs::create_dir_all(folder).await?;
        }
        fs::rename(temp_path, final_path).await?;
        Ok(Received {
            encrypted_size,
            checksum: hash.finalize().to_vec(),
            plain_size: encryptor.plain_bytes,
            chunk_count: encryptor.chunk_count(),
        })
    }

    async fn ready_file(&self, tenant_id: Uuid, id: &str) -> Result<FileRow, AppError> {
        let id = Uuid::parse_str(id).map_err(|_| AppError::file_not_found())?;
        file_model::find_ready_file(&self.db, tenant_id, id)
            .await?
            .ok_or_else(AppError::file_not_found)
    }

    pub async fn metadata(&self, tenant_id: Uuid, id: &str) -> Result<FileRow, AppError> {
        self.ready_file(tenant_id, id).await
    }

    pub async fn download(
        &self,
        tenant_id: Uuid,
        id: &str,
        request_id: &str,
    ) -> Result<(FileRow, PlainStream), AppError> {
        let file = self.ready_file(tenant_id, id).await?;
        let path = blob_path(&self.data_dir, file.tenant_id, file.blob_id);

        if !checksum_matches(&path, &file).await {
            tracing::error!(fileId = %file.id, "encrypted file failed its integrity check");
            return Err(AppError::internal());
        }

        let key = self
            .file_keys
            .unwrap(
                file.tenant_id,
                file.id,
                &file.encrypted_file_key,
                request_id,
            )
            .await
            .map_err(file_key_error)?;
        let chunk_count = u32::try_from(file.chunk_count).map_err(|_| AppError::internal())?;
        let encrypted_size =
            u64::try_from(file.encrypted_size).map_err(|_| AppError::internal())?;
        let decryptor = Decryptor::new(&key, context_of(&file)?, chunk_count, encrypted_size)
            .map_err(|_| AppError::internal())?;
        drop(key);
        let source = File::open(&path).await?;
        Ok((file.clone(), decrypt_stream(source, decryptor, file.id)))
    }

    pub async fn list(
        &self,
        tenant_id: Uuid,
        limit: i64,
        after: Option<&Cursor>,
    ) -> Result<Page, AppError> {
        let mut rows = file_model::list_ready_files(&self.db, tenant_id, limit + 1, after).await?;
        let has_more = rows.len() as i64 > limit;
        rows.truncate(usize::try_from(limit).unwrap_or(0));
        let next_cursor = if has_more {
            rows.last().map(make_cursor)
        } else {
            None
        };
        Ok(Page {
            files: rows,
            next_cursor,
        })
    }

    pub async fn usage(&self, tenant_id: Uuid) -> Result<(Usage, u64), AppError> {
        Ok((
            file_model::get_usage(&self.db, tenant_id).await?,
            self.quota_bytes,
        ))
    }

    pub async fn remove(&self, tenant_id: Uuid, id: &str) -> Result<FileRow, AppError> {
        let id = Uuid::parse_str(id).map_err(|_| AppError::file_not_found())?;
        let file = file_model::mark_deleting(&self.db, tenant_id, id)
            .await?
            .ok_or_else(AppError::file_not_found)?;
        remove_if_present(&blob_path(&self.data_dir, file.tenant_id, file.blob_id)).await?;
        file_model::remove_deleted_file(&self.db, &file).await?;
        Ok(file)
    }

    pub async fn remove_tenant(&self, tenant_id: Uuid) -> Result<usize, AppError> {
        let files = file_model::mark_tenant_deleting(&self.db, tenant_id).await?;
        for file in &files {
            remove_if_present(&blob_path(&self.data_dir, file.tenant_id, file.blob_id)).await?;
        }
        file_model::remove_tenant_records(&self.db, tenant_id).await?;
        match fs::remove_dir_all(self.data_dir.join(tenant_id.to_string())).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(files.len())
    }
}

async fn remove_if_present(path: &Path) -> Result<(), std::io::Error> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn checksum_matches(path: &Path, file: &FileRow) -> bool {
    let Some(expected) = &file.checksum else {
        return false;
    };
    let Ok(metadata) = fs::metadata(path).await else {
        return false;
    };
    if i64::try_from(metadata.len()).ok() != Some(file.encrypted_size) {
        return false;
    }
    let Ok(mut source) = File::open(path).await else {
        return false;
    };
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match source.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => hash.update(&buffer[..read]),
            Err(_) => return false,
        }
    }
    hash.finalize().as_slice() == expected.as_slice()
}

fn decrypt_stream(source: File, decryptor: Decryptor, file_id: Uuid) -> PlainStream {
    let state = Some((source, decryptor));
    Box::pin(futures_util::stream::unfold(
        state,
        move |state| async move {
            let (mut source, mut decryptor) = state?;
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let read = match source.read(&mut buffer).await {
                    Ok(read) => read,
                    Err(error) => {
                        tracing::error!(fileId = %file_id, error = %error, "download failed part-way; connection aborted");
                        return Some((Err(error), None));
                    }
                };
                if read == 0 {
                    return match decryptor.finish() {
                        Ok(()) => None,
                        Err(error) => {
                            tracing::error!(fileId = %file_id, error = %error, "download failed part-way; connection aborted");
                            Some((Err(std::io::Error::other(error)), None))
                        }
                    };
                }
                match decryptor.push(&buffer[..read]) {
                    Ok(plain) if plain.is_empty() => continue,
                    Ok(plain) => {
                        return Some((
                            Ok(Bytes::copy_from_slice(&plain)),
                            Some((source, decryptor)),
                        ));
                    }
                    Err(error) => {
                        tracing::error!(fileId = %file_id, error = %error, "download failed part-way; connection aborted");
                        return Some((Err(std::io::Error::other(error)), None));
                    }
                }
            }
        },
    ))
}

pub fn iso_millis(time: &DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}
