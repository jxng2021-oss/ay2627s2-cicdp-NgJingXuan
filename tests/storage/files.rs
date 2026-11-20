mod common;

use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::http::{Method, StatusCode};
use common::*;
use futures_util::stream;
use sqlx::PgPool;
use storage::cleanup::clean_up_on_start;
use uuid::Uuid;

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn uploads_and_downloads_a_file_as_a_safe_attachment(db: PgPool) {
    let storage = start(db, Settings::default());
    let content = b"hello, encrypted world. this spans several 64-byte chunks of the test chunk size, so order matters.";

    let uploaded = upload(&storage.app, content, Some("report%20%C3%A9t%C3%A9.txt")).await;
    assert_eq!(uploaded.status, StatusCode::CREATED);
    let file = uploaded.json();
    assert_eq!(file["name"], "report été.txt");
    assert_eq!(file["contentType"], "text/plain");
    assert_eq!(file["size"], content.len());

    let id = file["id"].as_str().expect("id");
    let downloaded = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{id}")),
    )
    .await;
    assert_eq!(downloaded.status, StatusCode::OK);
    assert_eq!(downloaded.body, content);
    assert_eq!(
        downloaded.headers["content-type"],
        "application/octet-stream"
    );
    assert_eq!(downloaded.headers["x-content-type-options"], "nosniff");
    assert_eq!(
        downloaded.headers["content-disposition"],
        "attachment; filename=\"report__t_.txt\"; filename*=UTF-8''report%20%C3%A9t%C3%A9.txt"
    );
    assert_eq!(
        storage.audit.actions().await,
        vec!["file.uploaded:success", "file.downloaded:success"]
    );
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn stores_only_ciphertext_under_random_names(db: PgPool) {
    let storage = start(db, Settings::default());
    let content = b"PLAINTEXT-MARKER that must never reach the disk";
    let uploaded = upload(&storage.app, content, Some("secret-plans.txt")).await;
    assert_eq!(uploaded.status, StatusCode::CREATED);

    let files = files_on_disk(&storage.data_dir);
    assert_eq!(files.len(), 1);
    let stored = std::fs::read(&files[0]).expect("blob");
    assert!(!stored.windows(16).any(|w| w == &content[..16]));
    let path = files[0].to_string_lossy().to_string();
    assert!(!path.contains("secret-plans"));
    assert!(path.contains(TENANT_A));
    let name = files[0]
        .file_name()
        .expect("name")
        .to_string_lossy()
        .to_string();
    assert!(Uuid::parse_str(&name).is_ok());
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn the_same_file_encrypts_differently_each_time(db: PgPool) {
    let storage = start(db, Settings::default());
    upload(&storage.app, b"identical content", None).await;
    upload(&storage.app, b"identical content", None).await;
    let blobs: Vec<Vec<u8>> = files_on_disk(&storage.data_dir)
        .iter()
        .map(|path| std::fs::read(path).expect("blob"))
        .collect();
    assert_eq!(blobs.len(), 2);
    assert_ne!(blobs[0], blobs[1]);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn another_tenants_file_is_the_same_404_and_is_recorded_as_denied(db: PgPool) {
    let storage = start(db, Settings::default());
    let id = upload(&storage.app, b"tenant A's file", None).await.json()["id"]
        .as_str()
        .expect("id")
        .to_string();
    let missing = Uuid::new_v4().to_string();

    for path in [format!("/files/{id}"), format!("/files/{id}/metadata")] {
        let other = send(
            &storage.app,
            Call::new(Method::GET, &path).tenant(Some(TENANT_B)),
        )
        .await;
        assert_eq!(other.status, StatusCode::NOT_FOUND);
        assert_eq!(other.json()["error"]["message"], "File not found");
    }
    let deleted = send(
        &storage.app,
        Call::new(Method::DELETE, &format!("/files/{id}")).tenant(Some(TENANT_B)),
    )
    .await;
    assert_eq!(deleted.status, StatusCode::NOT_FOUND);
    let missing_answer = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{missing}")).tenant(Some(TENANT_B)),
    )
    .await;
    assert_eq!(missing_answer.status, StatusCode::NOT_FOUND);
    assert_eq!(missing_answer.json()["error"]["message"], "File not found");

    let actions = storage.audit.actions().await;
    assert_eq!(
        actions
            .iter()
            .filter(|a| *a == "file.access_denied:denied")
            .count(),
        3
    );
    let still = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{id}")),
    )
    .await;
    assert_eq!(still.status, StatusCode::OK);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn refuses_malformed_file_ids_without_touching_the_disk(db: PgPool) {
    let storage = start(db, Settings::default());
    for path in [
        "/files/..%2F..%2Fetc",
        "/files/not-a-uuid",
        "/files/not-a-uuid/metadata",
    ] {
        let answer = send(&storage.app, Call::new(Method::GET, path)).await;
        assert_eq!(answer.status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn checks_the_checksum_before_sending_anything(db: PgPool) {
    let storage = start(db, Settings::default());
    let id = upload(
        &storage.app,
        b"original data that will be changed on disk",
        None,
    )
    .await
    .json()["id"]
        .as_str()
        .expect("id")
        .to_string();
    let blob = files_on_disk(&storage.data_dir).remove(0);
    let mut data = std::fs::read(&blob).expect("blob");
    data[3] ^= 1;
    std::fs::write(&blob, data).expect("write");

    let answer = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{id}")),
    )
    .await;
    assert_eq!(answer.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(answer.code(), "INTERNAL_ERROR");
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn refuses_a_file_key_moved_to_another_file(db: PgPool) {
    let storage = start(db.clone(), Settings::default());
    let first = upload(&storage.app, b"first file", None).await.json()["id"]
        .as_str()
        .expect("id")
        .to_string();
    let second = upload(&storage.app, b"second file", None).await.json()["id"]
        .as_str()
        .expect("id")
        .to_string();
    sqlx::query(
        "UPDATE files SET encrypted_file_key = (SELECT encrypted_file_key FROM files WHERE id = $1) WHERE id = $2",
    )
    .bind(Uuid::parse_str(&first).expect("uuid"))
    .bind(Uuid::parse_str(&second).expect("uuid"))
    .execute(&db)
    .await
    .expect("update");

    let answer = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{second}")),
    )
    .await;
    assert_eq!(answer.status, StatusCode::INTERNAL_SERVER_ERROR);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn sealed_secrets_service_refuses_transfers_but_metadata_keeps_working(db: PgPool) {
    let storage = start(db, Settings::default());
    let id = upload(&storage.app, b"stored before sealing", None)
        .await
        .json()["id"]
        .as_str()
        .expect("id")
        .to_string();
    storage.keys.set(KeyMode::Sealed);

    let refused = upload(&storage.app, b"while sealed", None).await;
    assert_eq!(refused.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(refused.code(), "SECRETS_SEALED");
    assert_eq!(refused.headers["retry-after"], "30");
    let download = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{id}")),
    )
    .await;
    assert_eq!(download.code(), "SECRETS_SEALED");

    for path in [
        "/files".to_string(),
        format!("/files/{id}/metadata"),
        "/usage".to_string(),
    ] {
        assert_eq!(
            send(&storage.app, Call::new(Method::GET, &path))
                .await
                .status,
            StatusCode::OK,
            "{path}"
        );
    }
    let usage = send(&storage.app, Call::new(Method::GET, "/usage"))
        .await
        .json();
    assert_eq!(usage["reservedBytes"], 0);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn an_unreachable_secrets_service_is_a_503(db: PgPool) {
    let storage = start(db, Settings::default());
    storage.keys.set(KeyMode::Unavailable);
    let answer = upload(&storage.app, b"data", None).await;
    assert_eq!(answer.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(answer.code(), "SERVICE_UNAVAILABLE");
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn an_upload_over_the_limit_leaves_nothing_behind(db: PgPool) {
    let storage = start(
        db,
        Settings {
            max_upload_bytes: 100,
            ..Settings::default()
        },
    );
    let declared = upload(&storage.app, &[1u8; 101], None).await;
    assert_eq!(declared.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(declared.code(), "PAYLOAD_TOO_LARGE");
    assert_eq!(declared.headers["connection"], "close");

    let chunks: Vec<Result<Vec<u8>, std::io::Error>> = (0..5).map(|_| Ok(vec![2u8; 40])).collect();
    let streamed = send(
        &storage.app,
        Call::new(Method::POST, "/files").body(Body::from_stream(stream::iter(chunks))),
    )
    .await;
    assert_eq!(streamed.status, StatusCode::PAYLOAD_TOO_LARGE);

    assert!(files_on_disk(&storage.data_dir).is_empty());
    let count: (i64,) = sqlx::query_as("SELECT count(*) FROM files")
        .fetch_one(&storage.db)
        .await
        .expect("count");
    assert_eq!(count.0, 0);
    let usage = send(&storage.app, Call::new(Method::GET, "/usage"))
        .await
        .json();
    assert_eq!(usage["reservedBytes"], 0);
    assert_eq!(usage["usedBytes"], 0);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn a_broken_upload_leaves_no_temporary_data_record_or_reservation(db: PgPool) {
    let storage = start(db, Settings::default());
    let chunks: Vec<Result<Vec<u8>, std::io::Error>> = vec![
        Ok(vec![3u8; 100]),
        Err(std::io::Error::other("client disconnected")),
    ];
    let answer = send(
        &storage.app,
        Call::new(Method::POST, "/files").body(Body::from_stream(stream::iter(chunks))),
    )
    .await;
    assert!(answer.status.is_client_error() || answer.status.is_server_error());
    assert!(files_on_disk(&storage.data_dir).is_empty());
    let count: (i64,) = sqlx::query_as("SELECT count(*) FROM files")
        .fetch_one(&storage.db)
        .await
        .expect("count");
    assert_eq!(count.0, 0);
    let usage = send(&storage.app, Call::new(Method::GET, "/usage"))
        .await
        .json();
    assert_eq!(usage["reservedBytes"], 0);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn refuses_uploads_over_the_tenant_quota_and_counts_usage(db: PgPool) {
    let storage = start(
        db,
        Settings {
            quota_bytes: 100,
            ..Settings::default()
        },
    );
    assert_eq!(
        upload(&storage.app, &[1u8; 60], None).await.status,
        StatusCode::CREATED
    );
    let over = upload(&storage.app, &[1u8; 60], None).await;
    assert_eq!(over.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(over.code(), "STORAGE_QUOTA_EXCEEDED");
    let usage = send(&storage.app, Call::new(Method::GET, "/usage"))
        .await
        .json();
    assert_eq!(usage["usedBytes"], 60);
    assert_eq!(usage["reservedBytes"], 0);
    assert_eq!(usage["limitBytes"], 100);

    let other = send(
        &storage.app,
        Call::new(Method::GET, "/usage").tenant(Some(TENANT_B)),
    )
    .await
    .json();
    assert_eq!(other["usedBytes"], 0);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn simultaneous_uploads_cannot_go_over_the_limit_together(db: PgPool) {
    let storage = start(
        db,
        Settings {
            quota_bytes: 250,
            ..Settings::default()
        },
    );
    let uploads = (0..5).map(|_| upload(&storage.app, &[9u8; 100], None));
    let answers = futures_util::future::join_all(uploads).await;
    let created = answers
        .iter()
        .filter(|a| a.status == StatusCode::CREATED)
        .count();
    assert_eq!(created, 2);
    let usage = send(&storage.app, Call::new(Method::GET, "/usage"))
        .await
        .json();
    assert_eq!(usage["usedBytes"], 200);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn deleting_removes_the_data_and_record_and_gives_space_back(db: PgPool) {
    let storage = start(db, Settings::default());
    let id = upload(&storage.app, &[4u8; 70], None).await.json()["id"]
        .as_str()
        .expect("id")
        .to_string();
    let deleted = send(
        &storage.app,
        Call::new(Method::DELETE, &format!("/files/{id}")),
    )
    .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    assert!(files_on_disk(&storage.data_dir).is_empty());
    let again = send(
        &storage.app,
        Call::new(Method::DELETE, &format!("/files/{id}")),
    )
    .await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    let usage = send(&storage.app, Call::new(Method::GET, "/usage"))
        .await
        .json();
    assert_eq!(usage["usedBytes"], 0);
    assert!(
        storage
            .audit
            .actions()
            .await
            .contains(&"file.deleted:success".to_string())
    );
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn a_delete_interrupted_part_way_can_be_finished(db: PgPool) {
    let storage = start(db.clone(), Settings::default());
    let id = upload(&storage.app, b"half deleted", None).await.json()["id"]
        .as_str()
        .expect("id")
        .to_string();
    let uuid = Uuid::parse_str(&id).expect("uuid");
    let tenant = Uuid::parse_str(TENANT_A).expect("uuid");
    storage::models::file_model::mark_deleting(&db, tenant, uuid)
        .await
        .expect("mark");
    let finished = send(
        &storage.app,
        Call::new(Method::DELETE, &format!("/files/{id}")),
    )
    .await;
    assert_eq!(finished.status, StatusCode::NO_CONTENT);
    assert!(files_on_disk(&storage.data_dir).is_empty());
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn lists_metadata_newest_first_with_pagination(db: PgPool) {
    let storage = start(db, Settings::default());
    for index in 0..5 {
        upload(
            &storage.app,
            format!("file {index}").as_bytes(),
            Some(&format!("f{index}.txt")),
        )
        .await;
    }
    let mut names = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let path = match &cursor {
            None => "/files?limit=2".to_string(),
            Some(c) => format!("/files?limit=2&cursor={c}"),
        };
        let page = send(&storage.app, Call::new(Method::GET, &path))
            .await
            .json();
        for file in page["files"].as_array().expect("files") {
            names.push(file["name"].as_str().expect("name").to_string());
        }
        match page["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => break,
        }
    }
    assert_eq!(
        names,
        vec!["f4.txt", "f3.txt", "f2.txt", "f1.txt", "f0.txt"]
    );

    for bad in [
        "/files?limit=0",
        "/files?limit=101",
        "/files?limit=abc",
        "/files?cursor=%%%",
    ] {
        assert_eq!(
            send(&storage.app, Call::new(Method::GET, bad)).await.status,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn refuses_unsafe_file_names(db: PgPool) {
    let storage = start(db, Settings::default());
    for name in [
        "",
        "a%2Fb",
        "a%5Cb",
        "line%0Abreak",
        "%E0%A4%A",
        &"x".repeat(256),
    ] {
        let answer = upload(&storage.app, b"x", Some(name)).await;
        assert_eq!(answer.status, StatusCode::BAD_REQUEST, "{name}");
    }
    let unnamed = upload(&storage.app, b"x", None).await.json();
    assert!(unnamed["name"].is_null());
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn keeps_only_a_plain_content_type(db: PgPool) {
    let storage = start(db, Settings::default());
    let odd = send(
        &storage.app,
        Call::new(Method::POST, "/files")
            .header("content-type", "text/html; charset=utf-8")
            .body(b"<b>x</b>".to_vec()),
    )
    .await
    .json();
    assert_eq!(odd["contentType"], "text/html");
    let bad = send(
        &storage.app,
        Call::new(Method::POST, "/files")
            .header("content-type", "not a type")
            .body(b"x".to_vec()),
    )
    .await
    .json();
    assert_eq!(bad["contentType"], "application/octet-stream");
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn needs_a_valid_tenant_and_internal_traffic(db: PgPool) {
    let storage = start(db, Settings::default());
    let no_tenant = send(&storage.app, Call::new(Method::GET, "/files").tenant(None)).await;
    assert_eq!(no_tenant.status, StatusCode::BAD_REQUEST);
    let bad_tenant = send(
        &storage.app,
        Call::new(Method::GET, "/files").tenant(Some("../../etc")),
    )
    .await;
    assert_eq!(bad_tenant.status, StatusCode::BAD_REQUEST);
    let outside = send(
        &storage.app,
        Call::new(Method::GET, "/files").peer("8.8.8.8:5000"),
    )
    .await;
    assert_eq!(outside.status, StatusCode::FORBIDDEN);
    let health = send(&storage.app, Call::new(Method::GET, "/health").tenant(None)).await;
    assert_eq!(health.status, StatusCode::OK);
    assert_eq!(health.json()["status"], "ok");
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn uses_the_gateways_request_id_and_ignores_malformed_ones(db: PgPool) {
    let storage = start(db, Settings::default());
    let id = Uuid::new_v4().to_string();
    let kept = send(
        &storage.app,
        Call::new(Method::GET, "/usage").header("x-request-id", id.clone()),
    )
    .await;
    assert_eq!(kept.headers["x-request-id"], id.as_str());

    let replaced = send(
        &storage.app,
        Call::new(Method::GET, "/nowhere").header("x-request-id", "not-a-uuid <script>"),
    )
    .await;
    let new_id = replaced.headers["x-request-id"].to_str().expect("id");
    assert!(Uuid::parse_str(new_id).is_ok());
    assert_eq!(replaced.status, StatusCode::NOT_FOUND);
    assert_eq!(replaced.json()["error"]["requestId"], new_id);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn refuses_new_requests_while_shutting_down(db: PgPool) {
    let storage = start(db, Settings::default());
    storage.shutting_down.store(true, Ordering::SeqCst);
    let answer = send(&storage.app, Call::new(Method::GET, "/usage")).await;
    assert_eq!(answer.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(answer.headers["connection"], "close");
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn file_events_are_best_effort_when_the_audit_log_is_down(db: PgPool) {
    let storage = start(db, Settings::default());
    storage.audit.down.store(true, Ordering::SeqCst);
    let answer = upload(&storage.app, b"still works", None).await;
    assert_eq!(answer.status, StatusCode::CREATED);
    assert!(storage.audit.actions().await.is_empty());
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn deleting_a_tenant_destroys_its_keys_data_and_records_only(db: PgPool) {
    let storage = start(db.clone(), Settings::default());
    upload(&storage.app, b"tenant A one", None).await;
    upload(&storage.app, b"tenant A two", None).await;
    let b_file = send(
        &storage.app,
        Call::new(Method::POST, "/files")
            .tenant(Some(TENANT_B))
            .body(b"tenant B".to_vec()),
    )
    .await
    .json();

    let deleted = send(&storage.app, Call::new(Method::DELETE, "/tenant")).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    assert!(!storage.data_dir.join(TENANT_A).exists());
    let left: (i64,) = sqlx::query_as("SELECT count(*) FROM files WHERE tenant_id = $1")
        .bind(Uuid::parse_str(TENANT_A).expect("uuid"))
        .fetch_one(&db)
        .await
        .expect("count");
    assert_eq!(left.0, 0);
    let b_id = b_file["id"].as_str().expect("id");
    let b_still = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{b_id}")).tenant(Some(TENANT_B)),
    )
    .await;
    assert_eq!(b_still.status, StatusCode::OK);
    let again = send(&storage.app, Call::new(Method::DELETE, "/tenant")).await;
    assert_eq!(again.status, StatusCode::NO_CONTENT);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn start_up_cleanup_finishes_or_undoes_unfinished_work_and_keeps_unknown_files(db: PgPool) {
    let storage = start(db.clone(), Settings::default());
    let id = upload(&storage.app, b"kept file", None).await.json()["id"]
        .as_str()
        .expect("id")
        .to_string();
    let half = upload(&storage.app, b"half deleted", None).await.json()["id"]
        .as_str()
        .expect("id")
        .to_string();
    storage::models::file_model::mark_deleting(
        &db,
        Uuid::parse_str(TENANT_A).expect("uuid"),
        Uuid::parse_str(&half).expect("uuid"),
    )
    .await
    .expect("mark");
    let temp = storage.data_dir.join(".tmp");
    std::fs::write(temp.join("leftover.part"), b"temp").expect("temp");
    let unknown = storage
        .data_dir
        .join(TENANT_A)
        .join(Uuid::new_v4().to_string());
    std::fs::write(&unknown, b"no record").expect("unknown");
    sqlx::query("UPDATE tenant_usage SET reserved_bytes = 999")
        .execute(&db)
        .await
        .expect("usage");

    let report = clean_up_on_start(&db, &storage.data_dir)
        .await
        .expect("cleanup");
    assert_eq!(report.unfinished, 1);
    assert_eq!(report.unknown_files, 1);
    assert!(unknown.exists());
    assert!(!temp.join("leftover.part").exists());
    let kept = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{id}")),
    )
    .await;
    assert_eq!(kept.status, StatusCode::OK);
    let usage = send(&storage.app, Call::new(Method::GET, "/usage"))
        .await
        .json();
    assert_eq!(usage["reservedBytes"], 0);
    assert_eq!(usage["usedBytes"], 9);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn streams_a_large_file_through_many_chunks(db: PgPool) {
    let storage = start(
        db,
        Settings {
            max_upload_bytes: 4 * 1024 * 1024,
            chunk_size: 64 * 1024,
            ..Settings::default()
        },
    );
    let content: Vec<u8> = (0..3 * 1024 * 1024 + 17)
        .map(|i: u32| (i % 253) as u8)
        .collect();
    let parts: Vec<Result<Vec<u8>, std::io::Error>> = content
        .chunks(10_000)
        .map(|part| Ok(part.to_vec()))
        .collect();
    let uploaded = send(
        &storage.app,
        Call::new(Method::POST, "/files").body(Body::from_stream(stream::iter(parts))),
    )
    .await;
    assert_eq!(uploaded.status, StatusCode::CREATED);
    let id = uploaded.json()["id"].as_str().expect("id").to_string();
    let downloaded = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{id}")),
    )
    .await;
    assert_eq!(downloaded.body.len(), content.len());
    assert!(downloaded.body == content);
}
