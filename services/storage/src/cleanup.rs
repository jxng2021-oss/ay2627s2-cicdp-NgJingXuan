use std::collections::HashSet;
use std::path::Path;

use sqlx::PgPool;
use tokio::fs;
use uuid::Uuid;

use crate::models::file_model;
use crate::services::file_service::{blob_path, temp_dir};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CleanupReport {
    pub unfinished: usize,
    pub unknown_files: usize,
}

pub async fn clean_up_on_start(
    db: &PgPool,
    data_dir: &Path,
) -> Result<CleanupReport, Box<dyn std::error::Error>> {
    let temp = temp_dir(data_dir);
    match fs::remove_dir_all(&temp).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(&temp).await?;

    let unfinished = file_model::unfinished_files(db).await?;
    for file in &unfinished {
        match fs::remove_file(blob_path(data_dir, file.tenant_id, file.blob_id)).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        file_model::delete_record(db, file.id).await?;
    }

    let known: HashSet<String> = file_model::all_blob_ids(db)
        .await?
        .into_iter()
        .map(|id| id.to_string())
        .collect();
    let mut unknown_files = 0;
    let mut tenants = fs::read_dir(data_dir).await?;
    while let Some(entry) = tenants.next_entry().await? {
        let is_tenant_folder = entry.file_type().await?.is_dir()
            && Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok();
        if !is_tenant_folder {
            continue;
        }
        let mut blobs = fs::read_dir(entry.path()).await?;
        while let Some(blob) = blobs.next_entry().await? {
            if !known.contains(blob.file_name().to_string_lossy().as_ref()) {
                unknown_files += 1;
            }
        }
    }

    file_model::recompute_usage(db).await?;
    if !unfinished.is_empty() {
        tracing::info!(
            unfinished = unfinished.len(),
            "cleaned up unfinished uploads and interrupted deletes"
        );
    }
    if unknown_files > 0 {
        tracing::warn!(
            unknown_files,
            "files without a record were found in the data folder and kept (see docs/runbook.md)"
        );
    }
    Ok(CleanupReport {
        unfinished: unfinished.len(),
        unknown_files,
    })
}
