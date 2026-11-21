mod common;

use axum::http::Method;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use common::http::{
    Answer, Call, IDENTITY_SERVICE_TOKEN, INTERNAL_SERVICE_TOKEN, Service, capture_logs, injected,
    put, send, start,
};
use common::{TENANT_A, TENANT_B};
use secrets::keys::SealState;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

fn random_key() -> String {
    let mut key = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key);
    STANDARD.encode(key)
}

async fn key_call(
    service: &Service,
    path: &str,
    tenant: &str,
    body: serde_json::Value,
    token: Option<&str>,
) -> Answer {
    let mut call = Call::new(Method::POST, path, tenant).json(&body);
    if let Some(token) = token {
        call = call.token(token);
    }
    send(service, call).await
}

async fn wrap_file(service: &Service, tenant: &str, file_id: &str, key: &str) -> Answer {
    key_call(
        service,
        "/internal/file-keys/wrap",
        tenant,
        json!({ "fileId": file_id, "key": key }),
        Some(INTERNAL_SERVICE_TOKEN),
    )
    .await
}

async fn unwrap_file(service: &Service, tenant: &str, file_id: &str, wrapped: &str) -> Answer {
    key_call(
        service,
        "/internal/file-keys/unwrap",
        tenant,
        json!({ "fileId": file_id, "wrappedKey": wrapped }),
        Some(INTERNAL_SERVICE_TOKEN),
    )
    .await
}

async fn wrap_signing(service: &Service, tenant: &str, pool_id: &str, key: &str) -> Answer {
    key_call(
        service,
        "/internal/signing-keys/wrap",
        tenant,
        json!({ "poolId": pool_id, "key": key }),
        Some(IDENTITY_SERVICE_TOKEN),
    )
    .await
}

async fn unwrap_signing(service: &Service, tenant: &str, pool_id: &str, wrapped: &str) -> Answer {
    key_call(
        service,
        "/internal/signing-keys/unwrap",
        tenant,
        json!({ "poolId": pool_id, "wrappedKey": wrapped }),
        Some(IDENTITY_SERVICE_TOKEN),
    )
    .await
}

fn wrapped_of(answer: &Answer) -> String {
    answer.json()["wrappedKey"]
        .as_str()
        .expect("wrapped key")
        .to_string()
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn injection_returns_the_latest_value_no_store_and_follows_rotation(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "payments", "first").await;

    let first = injected(&service, TENANT_A, "payments").await;
    put(&service, TENANT_A, "payments", "second").await;
    let second = injected(&service, TENANT_A, "payments").await;

    assert_eq!(
        first.json(),
        json!({ "name": "payments", "version": 1, "value": "first" })
    );
    assert_eq!(
        second.json(),
        json!({ "name": "payments", "version": 2, "value": "second" })
    );
    assert_eq!(second.header("cache-control").as_deref(), Some("no-store"));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn injection_is_404_for_missing_or_another_tenants_and_400_for_a_bad_name(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "payments", "A's").await;

    assert_eq!(injected(&service, TENANT_A, "missing").await.status, 404);
    assert_eq!(injected(&service, TENANT_B, "payments").await.status, 404);
    assert_eq!(injected(&service, TENANT_A, "-bad").await.status, 400);
    service.keys.set_state(SealState::Sealed);
    assert_eq!(
        injected(&service, TENANT_A, "payments").await.error_code(),
        "SECRETS_SEALED"
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn file_keys_wrap_and_unwrap_for_the_same_tenant_and_file(db: PgPool) {
    let service = start(&db);
    let file = Uuid::new_v4().to_string();
    let key = random_key();

    let wrapped = wrap_file(&service, TENANT_A, &file, &key).await;
    assert_eq!(wrapped.status, 200);
    assert_eq!(
        STANDARD.decode(wrapped_of(&wrapped)).expect("base64").len(),
        65
    );
    let again = wrap_file(&service, TENANT_A, &file, &key).await;
    assert_ne!(wrapped_of(&wrapped), wrapped_of(&again));

    let unwrapped = unwrap_file(&service, TENANT_A, &file, &wrapped_of(&wrapped)).await;
    assert_eq!(unwrapped.json(), json!({ "key": key }));
    assert_eq!(
        unwrapped.header("cache-control").as_deref(),
        Some("no-store")
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn a_wrapped_file_key_moved_or_changed_is_refused_generically(db: PgPool) {
    let service = start(&db);
    let file = Uuid::new_v4().to_string();
    let wrapped = wrapped_of(&wrap_file(&service, TENANT_A, &file, &random_key()).await);
    wrap_file(&service, TENANT_B, &file, &random_key()).await;
    let mut changed = STANDARD.decode(&wrapped).expect("base64");
    changed[40] ^= 1;

    for answer in [
        unwrap_file(&service, TENANT_A, &Uuid::new_v4().to_string(), &wrapped).await,
        unwrap_file(&service, TENANT_B, &file, &wrapped).await,
        unwrap_file(&service, TENANT_A, &file, &STANDARD.encode(changed)).await,
        unwrap_signing(&service, TENANT_A, &file, &wrapped).await,
    ] {
        assert_eq!(answer.status, 500);
        assert_eq!(answer.json()["error"]["message"], "Something went wrong");
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn refuses_bad_key_bodies(db: PgPool) {
    let service = start(&db);
    let short = STANDARD.encode([1u8; 16]);
    let file = Uuid::new_v4().to_string();
    let cases = [
        json!({ "fileId": file, "key": short }),
        json!({ "fileId": "not-a-uuid", "key": random_key() }),
        json!({ "fileId": file.to_uppercase(), "key": random_key() }),
        json!({ "fileId": file, "key": random_key(), "x": 1 }),
        json!({ "fileId": file }),
        json!({ "fileId": file, "key": 42 }),
    ];

    for body in cases {
        let answer = key_call(
            &service,
            "/internal/file-keys/wrap",
            TENANT_A,
            body,
            Some(INTERNAL_SERVICE_TOKEN),
        )
        .await;
        assert_eq!(answer.status, 400, "{}", answer.text());
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn key_routes_refuse_a_missing_or_wrong_token_even_before_saying_whether_its_sealed(
    db: PgPool,
) {
    let service = start(&db);
    let almost = format!(
        "{}X",
        &INTERNAL_SERVICE_TOKEN[..INTERNAL_SERVICE_TOKEN.len() - 1]
    );
    let wrong = "x".repeat(40);
    let body = || json!({ "fileId": Uuid::new_v4().to_string(), "key": random_key() });

    for state in [SealState::Unsealed, SealState::Sealed] {
        service.keys.set_state(state);
        for token in [None, Some(wrong.as_str()), Some(almost.as_str()), Some("")] {
            let answer = key_call(
                &service,
                "/internal/file-keys/wrap",
                TENANT_A,
                body(),
                token,
            )
            .await;
            assert_eq!(answer.status, 403);
            let signing = key_call(
                &service,
                "/internal/signing-keys/wrap",
                TENANT_A,
                json!({ "poolId": Uuid::new_v4().to_string(), "key": random_key() }),
                token,
            )
            .await;
            assert_eq!(signing.status, 403);
        }
        let without_bearer = send(
            &service,
            Call::new(Method::POST, "/internal/file-keys/wrap", TENANT_A)
                .json(&body())
                .header("authorization", INTERNAL_SERVICE_TOKEN),
        )
        .await;
        assert_eq!(without_bearer.status, 403);
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn key_routes_answer_503_sealed_with_the_right_token(db: PgPool) {
    let service = start(&db);
    service.keys.set_state(SealState::Sealed);

    let file = wrap_file(
        &service,
        TENANT_A,
        &Uuid::new_v4().to_string(),
        &random_key(),
    )
    .await;
    let signing = wrap_signing(
        &service,
        TENANT_A,
        &Uuid::new_v4().to_string(),
        &random_key(),
    )
    .await;

    for answer in [file, signing] {
        assert_eq!(answer.status, 503);
        assert_eq!(answer.error_code(), "SECRETS_SEALED");
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn signing_keys_wrap_and_unwrap_for_the_same_tenant_and_pool(db: PgPool) {
    let service = start(&db);
    let pool = Uuid::new_v4().to_string();
    let key = random_key();

    let wrapped = wrapped_of(&wrap_signing(&service, TENANT_A, &pool, &key).await);
    assert_eq!(
        unwrap_signing(&service, TENANT_A, &pool, &wrapped)
            .await
            .json(),
        json!({ "key": key })
    );

    for answer in [
        unwrap_signing(&service, TENANT_A, &Uuid::new_v4().to_string(), &wrapped).await,
        unwrap_signing(&service, TENANT_B, &pool, &wrapped).await,
        unwrap_file(&service, TENANT_A, &pool, &wrapped).await,
    ] {
        assert_eq!(answer.status, 500);
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn each_services_token_works_only_on_its_own_routes(db: PgPool) {
    let service = start(&db);
    let id = Uuid::new_v4().to_string();

    let storage_on_signing = key_call(
        &service,
        "/internal/signing-keys/wrap",
        TENANT_A,
        json!({ "poolId": id, "key": random_key() }),
        Some(INTERNAL_SERVICE_TOKEN),
    )
    .await;
    let identity_on_files = key_call(
        &service,
        "/internal/file-keys/wrap",
        TENANT_A,
        json!({ "fileId": id, "key": random_key() }),
        Some(IDENTITY_SERVICE_TOKEN),
    )
    .await;

    assert_eq!(
        (storage_on_signing.status, identity_on_files.status),
        (403, 403)
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn never_logs_keys_or_wrapped_keys(db: PgPool) {
    let (logs, _guard) = capture_logs();
    let service = start(&db);
    let file_key = random_key();
    let signing_key = random_key();
    let file = Uuid::new_v4().to_string();

    let wrapped_file = wrapped_of(&wrap_file(&service, TENANT_A, &file, &file_key).await);
    unwrap_file(&service, TENANT_A, &file, &wrapped_file).await;
    let wrapped_signing = wrapped_of(&wrap_signing(&service, TENANT_A, &file, &signing_key).await);
    unwrap_signing(&service, TENANT_A, &file, &wrapped_signing).await;

    let text = logs.text();
    assert!(text.contains("request completed"));
    for hidden in [&file_key, &signing_key, &wrapped_file, &wrapped_signing] {
        assert!(!text.contains(hidden.as_str()));
    }
    assert!(!text.contains(INTERNAL_SERVICE_TOKEN) && !text.contains(IDENTITY_SERVICE_TOKEN));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn crypto_shredding_makes_copies_of_wrapped_keys_useless_for_good(db: PgPool) {
    let service = start(&db);
    let file = Uuid::new_v4().to_string();
    let wrapped = wrapped_of(&wrap_file(&service, TENANT_A, &file, &random_key()).await);
    put(&service, TENANT_A, "a", "A's").await;
    put(&service, TENANT_B, "b", "B's").await;

    let shredded = send(
        &service,
        Call::new(Method::DELETE, "/internal/tenant", TENANT_A),
    )
    .await;
    let again = send(
        &service,
        Call::new(Method::DELETE, "/internal/tenant", TENANT_A),
    )
    .await;

    assert_eq!((shredded.status, again.status), (204, 204));
    assert_eq!(
        unwrap_file(&service, TENANT_A, &file, &wrapped)
            .await
            .status,
        404
    );
    assert_eq!(
        wrap_file(&service, TENANT_A, &file, &random_key())
            .await
            .status,
        404
    );
    assert_eq!(injected(&service, TENANT_A, "a").await.status, 404);
    assert_eq!(
        injected(&service, TENANT_B, "b").await.json()["value"],
        "B's"
    );
    let keys: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM tenant_keys WHERE tenant_id = '{TENANT_A}'"
    ))
    .fetch_one(&db)
    .await
    .expect("count");
    assert_eq!(keys, 0);
}
