mod common;

use std::sync::Arc;

use common::{StaticKeyProvider, TENANT_A, TENANT_B, tenant};
use secrets::keys::{SealState, random_key};
use secrets::services::secret_service::{SecretService, ServiceError};
use sqlx::PgPool;

const FILE_ID: &str = "3f2c9b1e-6a4d-4c8e-9f1a-2b3c4d5e6f70";
const POOL_ID: &str = "8b9e3c1a-2d4f-4a6b-9c8d-1e2f3a4b5c6d";

fn service(db: &PgPool) -> (SecretService, Arc<StaticKeyProvider>) {
    let keys = Arc::new(StaticKeyProvider::random());
    (SecretService::new(db.clone(), keys.clone()), keys)
}

async fn save(service: &SecretService, tenant_id: &str, name: &str, value: &str) -> i32 {
    service
        .save(tenant(tenant_id), name, value, |_| async { Ok(()) })
        .await
        .expect("save")
        .version
}

async fn value_of(
    service: &SecretService,
    tenant_id: &str,
    name: &str,
    version: Option<i32>,
) -> Option<String> {
    service
        .read(tenant(tenant_id), name, version)
        .await
        .expect("read")
        .map(|found| found.value.to_string())
}

async fn count(db: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(db).await.expect("count")
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn saving_again_adds_a_version_and_keeps_the_old_ones(db: PgPool) {
    let (service, _) = service(&db);

    assert_eq!(save(&service, TENANT_A, "db-password", "first").await, 1);
    assert_eq!(save(&service, TENANT_A, "db-password", "second").await, 2);

    assert_eq!(
        value_of(&service, TENANT_A, "db-password", Some(1))
            .await
            .as_deref(),
        Some("first")
    );
    assert_eq!(
        value_of(&service, TENANT_A, "db-password", Some(2))
            .await
            .as_deref(),
        Some("second")
    );
    assert_eq!(
        value_of(&service, TENANT_A, "db-password", None)
            .await
            .as_deref(),
        Some("second")
    );
    assert_eq!(
        value_of(&service, TENANT_A, "db-password", Some(3)).await,
        None
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn makes_one_tenant_key_and_stores_keys_and_values_only_encrypted(db: PgPool) {
    let (service, _) = service(&db);
    let value = "a very recognisable secret value";

    save(&service, TENANT_A, "one", value).await;
    save(&service, TENANT_A, "two", value).await;
    save(&service, TENANT_B, "one", value).await;

    assert_eq!(count(&db, "SELECT count(*) FROM tenant_keys").await, 2);
    let stored: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT ciphertext FROM secret_versions UNION ALL SELECT ciphertext FROM tenant_keys",
    )
    .fetch_all(&db)
    .await
    .expect("stored bytes");
    assert!(
        stored
            .iter()
            .all(|bytes| !bytes.windows(12).any(|w| w == b"recognisable"))
    );
    let nonces: Vec<Vec<u8>> = sqlx::query_scalar("SELECT nonce FROM secret_versions")
        .fetch_all(&db)
        .await
        .expect("nonces");
    let unique: std::collections::HashSet<_> = nonces.iter().collect();
    assert_eq!(unique.len(), nonces.len());
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn concurrent_saves_each_get_their_own_version(db: PgPool) {
    let (service, _) = service(&db);
    let service = Arc::new(service);

    let saves = (0..10).map(|index| {
        let service = service.clone();
        tokio::spawn(
            async move { save(&service, TENANT_A, "busy", &format!("value {index}")).await },
        )
    });
    let mut versions = Vec::new();
    for save in saves {
        versions.push(save.await.expect("task"));
    }
    versions.sort_unstable();

    assert_eq!(versions, (1..=10).collect::<Vec<_>>());
    assert_eq!(count(&db, "SELECT count(*) FROM tenant_keys").await, 1);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn rotate_needs_an_existing_secret(db: PgPool) {
    let (service, _) = service(&db);

    let missing = service
        .rotate(tenant(TENANT_A), "api-token", "value", |_| async { Ok(()) })
        .await
        .expect("rotate");
    assert!(missing.is_none());
    assert_eq!(count(&db, "SELECT count(*) FROM secrets").await, 0);

    save(&service, TENANT_A, "api-token", "old").await;
    let rotated = service
        .rotate(tenant(TENANT_A), "api-token", "new", |_| async { Ok(()) })
        .await
        .expect("rotate")
        .expect("rotated");
    assert_eq!(rotated.version, 2);
    assert_eq!(
        value_of(&service, TENANT_A, "api-token", None)
            .await
            .as_deref(),
        Some("new")
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn describes_a_version_without_decrypting_it(db: PgPool) {
    let (service, keys) = service(&db);
    save(&service, TENANT_A, "api-token", "one").await;
    save(&service, TENANT_A, "api-token", "two").await;
    keys.set_state(SealState::Sealed);

    let latest = service
        .describe(tenant(TENANT_A), "api-token", None)
        .await
        .expect("describe");
    let first = service
        .describe(tenant(TENANT_A), "api-token", Some(1))
        .await
        .expect("describe");
    let missing = service
        .describe(tenant(TENANT_A), "api-token", Some(9))
        .await
        .expect("describe");

    assert_eq!(latest.map(|v| v.version), Some(2));
    assert_eq!(first.map(|v| v.version), Some(1));
    assert!(missing.is_none());
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn another_tenants_secret_is_the_same_as_a_missing_one(db: PgPool) {
    let (service, _) = service(&db);
    save(&service, TENANT_A, "api-token", "tenant A's value").await;
    let other = tenant(TENANT_B);

    assert!(
        service
            .read(other, "api-token", None)
            .await
            .expect("read")
            .is_none()
    );
    assert!(
        service
            .describe(other, "api-token", None)
            .await
            .expect("describe")
            .is_none()
    );
    assert!(
        service
            .versions(other, "api-token", 20, None)
            .await
            .expect("versions")
            .is_none()
    );
    assert!(
        service
            .rotate(other, "api-token", "x", |_| async { Ok(()) })
            .await
            .expect("rotate")
            .is_none()
    );
    assert!(
        !service
            .delete(other, "api-token", || async { Ok(()) })
            .await
            .expect("delete")
    );
    assert!(
        service
            .list(other, 20, None)
            .await
            .expect("list")
            .items
            .is_empty()
    );
    assert_eq!(
        value_of(&service, TENANT_A, "api-token", None)
            .await
            .as_deref(),
        Some("tenant A's value")
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn lists_secrets_by_name_a_page_at_a_time(db: PgPool) {
    let (service, _) = service(&db);
    for name in ["echo", "alpha", "delta", "charlie", "bravo"] {
        save(&service, TENANT_A, name, "v").await;
    }
    save(&service, TENANT_A, "bravo", "v2").await;

    let first = service.list(tenant(TENANT_A), 2, None).await.expect("list");
    let names: Vec<_> = first.items.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["alpha", "bravo"]);
    assert_eq!(first.items[1].latest_version, 2);
    assert_eq!(first.next_cursor.as_deref(), Some("bravo"));

    let second = service
        .list(tenant(TENANT_A), 2, Some("bravo"))
        .await
        .expect("list");
    let names: Vec<_> = second.items.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["charlie", "delta"]);

    let last = service
        .list(tenant(TENANT_A), 2, Some("delta"))
        .await
        .expect("list");
    assert_eq!(last.items.len(), 1);
    assert_eq!(last.next_cursor, None);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn lists_versions_newest_first_a_page_at_a_time(db: PgPool) {
    let (service, _) = service(&db);
    for index in 0..5 {
        save(&service, TENANT_A, "api-token", &format!("v{index}")).await;
    }

    let first = service
        .versions(tenant(TENANT_A), "api-token", 2, None)
        .await
        .expect("versions")
        .expect("found");
    assert_eq!(
        first.items.iter().map(|v| v.version).collect::<Vec<_>>(),
        [5, 4]
    );
    assert_eq!(first.next_cursor.as_deref(), Some("4"));

    let second = service
        .versions(tenant(TENANT_A), "api-token", 2, Some(4))
        .await
        .expect("versions")
        .expect("found");
    assert_eq!(
        second.items.iter().map(|v| v.version).collect::<Vec<_>>(),
        [3, 2]
    );

    let last = service
        .versions(tenant(TENANT_A), "api-token", 2, Some(2))
        .await
        .expect("versions")
        .expect("found");
    assert_eq!(
        last.items.iter().map(|v| v.version).collect::<Vec<_>>(),
        [1]
    );
    assert_eq!(last.next_cursor, None);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn deleting_removes_the_secret_and_every_version(db: PgPool) {
    let (service, _) = service(&db);
    save(&service, TENANT_A, "api-token", "one").await;
    save(&service, TENANT_A, "api-token", "two").await;

    assert!(
        service
            .delete(tenant(TENANT_A), "api-token", || async { Ok(()) })
            .await
            .expect("delete")
    );

    assert_eq!(value_of(&service, TENANT_A, "api-token", None).await, None);
    assert_eq!(count(&db, "SELECT count(*) FROM secret_versions").await, 0);
    assert!(
        !service
            .delete(tenant(TENANT_A), "api-token", || async { Ok(()) })
            .await
            .expect("delete")
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn nothing_changes_if_the_step_before_commit_fails(db: PgPool) {
    let (service, _) = service(&db);
    save(&service, TENANT_A, "api-token", "kept").await;

    let saved = service
        .save(tenant(TENANT_A), "api-token", "refused", |_| async {
            Err(ServiceError::AuditUnavailable)
        })
        .await;
    let created = service
        .save(tenant(TENANT_A), "new-one", "refused", |_| async {
            Err(ServiceError::AuditUnavailable)
        })
        .await;
    let rotated = service
        .rotate(tenant(TENANT_A), "api-token", "refused", |_| async {
            Err(ServiceError::AuditUnavailable)
        })
        .await;
    let deleted = service
        .delete(tenant(TENANT_A), "api-token", || async {
            Err(ServiceError::AuditUnavailable)
        })
        .await;

    assert!(matches!(saved, Err(ServiceError::AuditUnavailable)));
    assert!(matches!(created, Err(ServiceError::AuditUnavailable)));
    assert!(matches!(rotated, Err(ServiceError::AuditUnavailable)));
    assert!(matches!(deleted, Err(ServiceError::AuditUnavailable)));
    assert_eq!(
        value_of(&service, TENANT_A, "api-token", None)
            .await
            .as_deref(),
        Some("kept")
    );
    assert_eq!(count(&db, "SELECT count(*) FROM secret_versions").await, 1);
    assert_eq!(count(&db, "SELECT count(*) FROM secrets").await, 1);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn a_sealed_service_refuses_to_encrypt_or_decrypt(db: PgPool) {
    let (service, keys) = service(&db);
    save(&service, TENANT_A, "api-token", "value").await;
    keys.set_state(SealState::Sealed);

    let saved = service
        .save(tenant(TENANT_A), "api-token", "x", |_| async { Ok(()) })
        .await;
    let read = service.read(tenant(TENANT_A), "api-token", None).await;
    let wrapped = service
        .wrap_file_key(tenant(TENANT_A), FILE_ID, &random_key())
        .await;

    assert!(matches!(saved, Err(ServiceError::Sealed)));
    assert!(matches!(read, Err(ServiceError::Sealed)));
    assert!(matches!(wrapped, Err(ServiceError::Sealed)));
    assert_eq!(count(&db, "SELECT count(*) FROM secret_versions").await, 1);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn file_keys_unwrap_only_for_their_tenant_and_file(db: PgPool) {
    let (service, _) = service(&db);
    let file_key = random_key();

    let wrapped = service
        .wrap_file_key(tenant(TENANT_A), FILE_ID, &file_key)
        .await
        .expect("wrap");
    assert_eq!(wrapped.len(), 65);

    let unwrapped = service
        .unwrap_file_key(tenant(TENANT_A), FILE_ID, &wrapped)
        .await
        .expect("unwrap");
    assert_eq!(unwrapped.as_ref(), file_key.as_ref());
    assert!(matches!(
        service
            .unwrap_file_key(tenant(TENANT_B), FILE_ID, &wrapped)
            .await,
        Err(ServiceError::Decryption(_))
    ));
    assert!(matches!(
        service
            .unwrap_file_key(tenant(TENANT_A), POOL_ID, &wrapped)
            .await,
        Err(ServiceError::Decryption(_))
    ));
    assert!(matches!(
        service
            .unwrap_signing_key(tenant(TENANT_A), FILE_ID, &wrapped)
            .await,
        Err(ServiceError::Decryption(_))
    ));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn signing_keys_unwrap_only_for_their_tenant_and_pool(db: PgPool) {
    let (service, _) = service(&db);
    let data_key = random_key();

    let wrapped = service
        .wrap_signing_key(tenant(TENANT_A), POOL_ID, &data_key)
        .await
        .expect("wrap");

    let unwrapped = service
        .unwrap_signing_key(tenant(TENANT_A), POOL_ID, &wrapped)
        .await
        .expect("unwrap");
    assert_eq!(unwrapped.as_ref(), data_key.as_ref());
    assert!(matches!(
        service
            .unwrap_signing_key(tenant(TENANT_B), POOL_ID, &wrapped)
            .await,
        Err(ServiceError::Decryption(_))
    ));
    assert!(matches!(
        service
            .unwrap_file_key(tenant(TENANT_A), POOL_ID, &wrapped)
            .await,
        Err(ServiceError::Decryption(_))
    ));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn shredding_destroys_the_tenant_key_and_never_makes_a_new_one(db: PgPool) {
    let (service, _) = service(&db);
    save(&service, TENANT_A, "api-token", "value").await;
    save(&service, TENANT_B, "api-token", "tenant B keeps this").await;
    let wrapped = service
        .wrap_file_key(tenant(TENANT_A), FILE_ID, &random_key())
        .await
        .expect("wrap");

    service.shred(tenant(TENANT_A)).await.expect("shred");
    service
        .shred(tenant(TENANT_A))
        .await
        .expect("shredding again is safe");

    assert_eq!(
        count(&db, "SELECT count(*) FROM tenant_keys WHERE tenant_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'").await,
        0
    );
    assert_eq!(value_of(&service, TENANT_A, "api-token", None).await, None);
    assert!(matches!(
        service
            .unwrap_file_key(tenant(TENANT_A), FILE_ID, &wrapped)
            .await,
        Err(ServiceError::TenantShredded)
    ));
    assert!(matches!(
        service
            .save(tenant(TENANT_A), "api-token", "again", |_| async { Ok(()) })
            .await,
        Err(ServiceError::TenantShredded)
    ));
    assert!(matches!(
        service
            .wrap_file_key(tenant(TENANT_A), FILE_ID, &random_key())
            .await,
        Err(ServiceError::TenantShredded)
    ));
    assert_eq!(
        value_of(&service, TENANT_B, "api-token", None)
            .await
            .as_deref(),
        Some("tenant B keeps this")
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn a_damaged_wrapped_key_is_refused(db: PgPool) {
    let (service, _) = service(&db);
    let mut wrapped = service
        .wrap_file_key(tenant(TENANT_A), FILE_ID, &random_key())
        .await
        .expect("wrap");

    assert!(matches!(
        service
            .unwrap_file_key(tenant(TENANT_A), FILE_ID, &wrapped[..64])
            .await,
        Err(ServiceError::Decryption(_))
    ));
    wrapped[40] ^= 0x01;
    assert!(matches!(
        service
            .unwrap_file_key(tenant(TENANT_A), FILE_ID, &wrapped)
            .await,
        Err(ServiceError::Decryption(_))
    ));
}
