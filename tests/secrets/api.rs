mod common;

use std::sync::Arc;

use axum::http::Method;
use common::http::{Call, MAX_SECRET_BYTES, get, injected, put, send, start, start_with};
use common::{StaticKeyProvider, TENANT_A, TENANT_B};
use serde_json::{Value, json};
use sqlx::PgPool;

type StoredVersion = (i16, i32, Vec<u8>, Vec<u8>, Vec<u8>);

fn expect_error(answer: &common::http::Answer, status: u16, code: &str) {
    assert_eq!(answer.status, status, "{}", answer.text());
    assert_eq!(answer.error_code(), code);
    assert!(answer.json()["error"]["requestId"].is_string());
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn put_creates_version_1_then_adds_versions_and_get_returns_metadata_never_the_value(
    db: PgPool,
) {
    let service = start(&db);

    let created = put(&service, TENANT_A, "db-password", "first-value").await;
    let updated = put(&service, TENANT_A, "db-password", "second-value").await;
    let read = get(&service, TENANT_A, "/secrets/db-password").await;

    assert_eq!(
        (created.status, updated.status, read.status),
        (201, 200, 200)
    );
    assert_eq!(created.json()["version"], 1);
    assert_eq!(updated.json()["version"], 2);
    let body = read.json();
    assert_eq!(body["version"], 2);
    let mut keys: Vec<_> = body.as_object().expect("object").keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["createdAt", "name", "version"]);
    assert!(!read.text().contains("value"));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn there_is_no_reveal_route(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "db-password", "never-revealed").await;

    for path in ["/secrets/db-password/reveal", "/secrets/db-password/value"] {
        for method in [Method::GET, Method::POST] {
            let answer = send(&service, Call::new(method, path, TENANT_A)).await;
            assert_eq!(answer.status, 404);
            assert!(!answer.text().contains("never-revealed"));
        }
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn get_with_a_version_returns_that_versions_metadata(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "token", "one").await;
    put(&service, TENANT_A, "token", "two").await;

    assert_eq!(
        get(&service, TENANT_A, "/secrets/token?version=1")
            .await
            .json()["version"],
        1
    );
    expect_error(
        &get(&service, TENANT_A, "/secrets/token?version=3").await,
        404,
        "NOT_FOUND",
    );
    for bad in ["0", "abc", "1.5", "2147483648"] {
        expect_error(
            &get(&service, TENANT_A, &format!("/secrets/token?version={bad}")).await,
            400,
            "BAD_REQUEST",
        );
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn rotate_saves_the_next_version_only_for_an_existing_secret(db: PgPool) {
    let service = start(&db);
    let rotate = |name: &str| {
        Call::new(Method::POST, &format!("/secrets/{name}/rotate"), TENANT_A)
            .json(&json!({ "value": "new" }))
    };

    expect_error(&send(&service, rotate("missing")).await, 404, "NOT_FOUND");
    put(&service, TENANT_A, "token", "old").await;
    let rotated = send(&service, rotate("token")).await;

    assert_eq!(rotated.status, 200);
    assert_eq!(rotated.json()["version"], 2);
    assert_eq!(
        injected(&service, TENANT_A, "token").await.json()["value"],
        "new"
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn delete_removes_the_secret_and_every_encrypted_version(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "token", "one").await;
    put(&service, TENANT_A, "token", "two").await;

    let deleted = send(
        &service,
        Call::new(Method::DELETE, "/secrets/token", TENANT_A),
    )
    .await;

    assert_eq!(deleted.status, 204);
    assert!(deleted.body.is_empty());
    expect_error(
        &get(&service, TENANT_A, "/secrets/token").await,
        404,
        "NOT_FOUND",
    );
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM secret_versions")
        .fetch_one(&db)
        .await
        .expect("count");
    assert_eq!(left, 0);
    expect_error(
        &send(
            &service,
            Call::new(Method::DELETE, "/secrets/token", TENANT_A),
        )
        .await,
        404,
        "NOT_FOUND",
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn sets_cache_control_no_store_on_every_secrets_response(db: PgPool) {
    let service = start(&db);

    let saved = put(&service, TENANT_A, "cached", "value").await;
    let read = get(&service, TENANT_A, "/secrets/cached").await;
    let missing = get(&service, TENANT_A, "/secrets/missing").await;
    let unknown = get(&service, TENANT_A, "/nothing-here").await;

    for answer in [saved, read, missing, unknown] {
        assert_eq!(answer.header("cache-control").as_deref(), Some("no-store"));
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn accepts_values_up_to_the_limit_and_refuses_bigger_ones(db: PgPool) {
    let service = start(&db);

    let at_limit = put(&service, TENANT_A, "big", &"x".repeat(MAX_SECRET_BYTES)).await;
    let over_limit = put(
        &service,
        TENANT_A,
        "big",
        &"é".repeat(MAX_SECRET_BYTES / 2 + 1),
    )
    .await;
    let huge_body = send(
        &service,
        Call::new(Method::PUT, "/secrets/big", TENANT_A)
            .json(&json!({ "value": "x".repeat(MAX_SECRET_BYTES * 7) })),
    )
    .await;

    assert_eq!(at_limit.status, 201);
    expect_error(&over_limit, 413, "PAYLOAD_TOO_LARGE");
    expect_error(&huge_body, 413, "PAYLOAD_TOO_LARGE");
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn refuses_invalid_names(db: PgPool) {
    let service = start(&db);
    let long = "x".repeat(129);
    for name in [
        "-starts-with-dash",
        ".hidden",
        "has%20space",
        "has%2Fslash",
        &long,
        "semi;colon",
        "%C3%A9",
        "%FF",
    ] {
        expect_error(
            &put(&service, TENANT_A, name, "v").await,
            400,
            "BAD_REQUEST",
        );
    }
    assert_eq!(
        put(&service, TENANT_A, "Valid_name.v-2", "v").await.status,
        201
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn refuses_bad_bodies(db: PgPool) {
    let service = start(&db);
    let call = || Call::new(Method::PUT, "/secrets/name", TENANT_A);

    expect_error(
        &send(&service, call().raw_body("", Some("application/json"))).await,
        400,
        "BAD_REQUEST",
    );
    expect_error(&send(&service, call()).await, 400, "BAD_REQUEST");
    expect_error(
        &send(&service, call().json(&json!({ "value": 42 }))).await,
        400,
        "BAD_REQUEST",
    );
    expect_error(
        &send(
            &service,
            call().json(&json!({ "value": "v", "tenantId": TENANT_B })),
        )
        .await,
        400,
        "BAD_REQUEST",
    );
    expect_error(
        &send(&service, call().json(&json!({}))).await,
        400,
        "BAD_REQUEST",
    );
    expect_error(
        &send(&service, call().json(&json!(["v"]))).await,
        400,
        "BAD_REQUEST",
    );
    expect_error(
        &send(
            &service,
            call().raw_body("{\"value\": \"v", Some("application/json")),
        )
        .await,
        400,
        "BAD_REQUEST",
    );
    expect_error(
        &send(&service, call().raw_body("value", Some("text/plain"))).await,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM secrets")
        .fetch_one(&db)
        .await
        .expect("count");
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn requires_a_uuid_x_tenant_id(db: PgPool) {
    let service = start(&db);

    let missing = send(
        &service,
        Call::new(Method::GET, "/secrets", TENANT_A).without_tenant(),
    )
    .await;
    let invalid = send(&service, Call::new(Method::GET, "/secrets", "tenant-a")).await;
    let upper = send(
        &service,
        Call::new(Method::GET, "/secrets", &TENANT_A.to_uppercase()),
    )
    .await;

    for answer in [missing, invalid, upper] {
        expect_error(&answer, 400, "BAD_REQUEST");
        assert_eq!(answer.header("cache-control").as_deref(), Some("no-store"));
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn lists_names_and_metadata_only_a_page_at_a_time(db: PgPool) {
    let service = start(&db);
    for name in ["c", "a", "e", "b", "d"] {
        put(&service, TENANT_A, name, &format!("value-of-{name}")).await;
    }

    let first = get(&service, TENANT_A, "/secrets?limit=2").await;
    let cursor = first.json()["nextCursor"]
        .as_str()
        .expect("cursor")
        .to_string();
    let second = get(
        &service,
        TENANT_A,
        &format!("/secrets?limit=2&cursor={cursor}"),
    )
    .await;
    let cursor = second.json()["nextCursor"]
        .as_str()
        .expect("cursor")
        .to_string();
    let last = get(
        &service,
        TENANT_A,
        &format!("/secrets?limit=2&cursor={cursor}"),
    )
    .await;

    let names = |answer: &common::http::Answer| -> Vec<String> {
        answer.json()["secrets"]
            .as_array()
            .expect("list")
            .iter()
            .map(|s| s["name"].as_str().expect("name").to_string())
            .collect()
    };
    assert_eq!(names(&first), ["a", "b"]);
    assert_eq!(names(&second), ["c", "d"]);
    assert_eq!(names(&last), ["e"]);
    assert_eq!(last.json()["nextCursor"], Value::Null);
    let mut keys: Vec<_> = first.json()["secrets"][0]
        .as_object()
        .expect("object")
        .keys()
        .cloned()
        .collect();
    keys.sort();
    assert_eq!(keys, ["createdAt", "latestVersion", "name", "updatedAt"]);
    for answer in [first, second, last] {
        assert!(!answer.text().contains("value-of-"));
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn uses_a_default_page_size_of_20_and_a_maximum_of_100(db: PgPool) {
    let service = start(&db);
    for index in 0..21 {
        put(&service, TENANT_A, &format!("s{index:02}"), "v").await;
    }

    let page = get(&service, TENANT_A, "/secrets").await.json();

    assert_eq!(page["secrets"].as_array().expect("list").len(), 20);
    assert_eq!(page["nextCursor"], "s19");
    assert_eq!(
        get(&service, TENANT_A, "/secrets?limit=100").await.status,
        200
    );
    expect_error(
        &get(&service, TENANT_A, "/secrets?limit=101").await,
        400,
        "BAD_REQUEST",
    );
    expect_error(
        &get(&service, TENANT_A, "/secrets?limit=0").await,
        400,
        "BAD_REQUEST",
    );
    expect_error(
        &get(&service, TENANT_A, "/secrets?cursor=-bad").await,
        400,
        "BAD_REQUEST",
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn lists_version_metadata_newest_first_a_page_at_a_time(db: PgPool) {
    let service = start(&db);
    for index in 1..=5 {
        put(&service, TENANT_A, "rotating", &format!("value-{index}")).await;
    }

    let first = get(&service, TENANT_A, "/secrets/rotating/versions?limit=2")
        .await
        .json();
    let second = get(
        &service,
        TENANT_A,
        "/secrets/rotating/versions?limit=2&cursor=4",
    )
    .await
    .json();
    let huge = get(
        &service,
        TENANT_A,
        "/secrets/rotating/versions?cursor=9999999999",
    )
    .await
    .json();

    let versions = |body: &Value| -> Vec<i64> {
        body["versions"]
            .as_array()
            .expect("list")
            .iter()
            .map(|v| v["version"].as_i64().expect("number"))
            .collect()
    };
    assert_eq!(first["name"], "rotating");
    assert_eq!(versions(&first), [5, 4]);
    assert_eq!(first["nextCursor"], "4");
    assert_eq!(versions(&second), [3, 2]);
    assert_eq!(versions(&huge), [5, 4, 3, 2, 1]);
    expect_error(
        &get(&service, TENANT_A, "/secrets/rotating/versions?cursor=0").await,
        400,
        "BAD_REQUEST",
    );
    expect_error(
        &get(&service, TENANT_A, "/secrets/missing/versions").await,
        404,
        "NOT_FOUND",
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn another_tenants_secret_is_the_same_404_as_a_missing_one_on_every_route(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "shared-name", "tenant A's value").await;
    let routes = [
        Call::new(Method::GET, "/secrets/shared-name", TENANT_B),
        Call::new(Method::GET, "/secrets/shared-name/versions", TENANT_B),
        Call::new(Method::POST, "/secrets/shared-name/rotate", TENANT_B)
            .json(&json!({ "value": "x" })),
        Call::new(Method::DELETE, "/secrets/shared-name", TENANT_B),
        Call::new(Method::GET, "/internal/secrets/shared-name", TENANT_B),
    ];

    for call in routes {
        let other = send(&service, call).await;
        expect_error(&other, 404, "NOT_FOUND");
        assert!(!other.text().contains("tenant A"));
    }
    assert_eq!(
        injected(&service, TENANT_A, "shared-name").await.json()["value"],
        "tenant A's value"
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn two_tenants_use_the_same_name_with_their_own_keys(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "api-key", "A's").await;
    put(&service, TENANT_B, "api-key", "B's").await;

    assert_eq!(
        injected(&service, TENANT_A, "api-key").await.json()["value"],
        "A's"
    );
    assert_eq!(
        injected(&service, TENANT_B, "api-key").await.json()["value"],
        "B's"
    );
    let keys: Vec<Vec<u8>> = sqlx::query_scalar("SELECT ciphertext FROM tenant_keys")
        .fetch_all(&db)
        .await
        .expect("keys");
    assert_eq!(keys.len(), 2);
    assert_ne!(keys[0], keys[1]);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn simultaneous_writes_get_consecutive_versions_and_one_tenant_key(db: PgPool) {
    let service = Arc::new(start(&db));
    let writes = (0..10).map(|index| {
        let service = service.clone();
        tokio::spawn(async move {
            put(&service, TENANT_A, "busy", &format!("v{index}"))
                .await
                .json()["version"]
                .as_i64()
        })
    });
    let mut versions = Vec::new();
    for write in writes.collect::<Vec<_>>() {
        versions.push(write.await.expect("task").expect("version"));
    }
    versions.sort_unstable();

    assert_eq!(versions, (1..=10).collect::<Vec<i64>>());
    let keys: i64 = sqlx::query_scalar("SELECT count(*) FROM tenant_keys")
        .fetch_one(&db)
        .await
        .expect("count");
    assert_eq!(keys, 1);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn stores_only_ciphertext(db: PgPool) {
    let service = start(&db);
    let value = "correct-horse-battery-staple-1234";
    put(&service, TENANT_A, "stored", value).await;
    put(&service, TENANT_A, "stored", value).await;

    let rows: Vec<StoredVersion> =
        sqlx::query_as("SELECT format_version, tenant_key_version, nonce, auth_tag, ciphertext FROM secret_versions")
            .fetch_all(&db)
            .await
            .expect("rows");
    assert_eq!(rows.len(), 2);
    for (format, key_version, nonce, tag, ciphertext) in &rows {
        assert_eq!(
            (*format, *key_version, nonce.len(), tag.len()),
            (1, 1, 12, 16)
        );
        assert!(
            !ciphertext
                .windows(value.len())
                .any(|window| window == value.as_bytes())
        );
    }
    assert_ne!(rows[0].4, rows[1].4);
    let everything: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT nonce || ciphertext || auth_tag FROM tenant_keys UNION ALL SELECT convert_to(name, 'UTF8') FROM secrets",
    )
    .fetch_all(&db)
    .await
    .expect("dump");
    assert!(everything.iter().all(|bytes| {
        !bytes
            .windows(value.len())
            .any(|window| window == value.as_bytes())
    }));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn never_echoes_the_value_in_error_responses(db: PgPool) {
    let service = start(&db);
    let value = "correct-horse-battery-staple-1234";
    let call = || Call::new(Method::PUT, "/secrets/x", TENANT_A);

    let answers = [
        send(
            &service,
            call().raw_body(&format!("{{\"value\": \"{value}"), Some("application/json")),
        )
        .await,
        put(
            &service,
            TENANT_A,
            "x",
            &format!("{value}{}", "x".repeat(MAX_SECRET_BYTES)),
        )
        .await,
        send(&service, call().json(&json!({ "value": [value] }))).await,
        send(&service, call().raw_body(value, Some("text/plain"))).await,
    ];

    for answer in answers {
        assert!(answer.status >= 400);
        assert!(!answer.text().contains(value));
    }
}

async fn expect_generic_failure(answer: common::http::Answer) {
    expect_error(&answer, 500, "INTERNAL_ERROR");
    assert_eq!(answer.json()["error"]["message"], "Something went wrong");
    let lower = answer.text().to_lowercase();
    for word in ["decrypt", "auth", "tag", "nonce", "key"] {
        assert!(!lower.contains(word), "{lower}");
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn changed_ciphertext_nonce_or_tag_is_refused_generically(db: PgPool) {
    let service = start(&db);
    for column in ["ciphertext", "nonce", "auth_tag"] {
        let name = format!("tampered-{column}");
        put(&service, TENANT_A, &name, "value").await;
        sqlx::query(&format!(
            "UPDATE secret_versions SET {column} = set_byte({column}, 0, get_byte({column}, 0) # 1) \
             WHERE secret_id = (SELECT id FROM secrets WHERE name = $1)"
        ))
        .bind(&name)
        .execute(&db)
        .await
        .expect("tamper");

        expect_generic_failure(injected(&service, TENANT_A, &name).await).await;
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn a_changed_tenant_key_is_refused_for_reads_and_writes(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "x", "value").await;
    sqlx::query(
        "UPDATE tenant_keys SET ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)",
    )
    .execute(&db)
    .await
    .expect("tamper");

    expect_generic_failure(injected(&service, TENANT_A, "x").await).await;
    expect_generic_failure(put(&service, TENANT_A, "y", "value").await).await;
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn values_moved_to_another_tenant_name_or_version_are_refused(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "a", "tenant A's value").await;
    put(&service, TENANT_B, "a", "B's own value").await;
    put(&service, TENANT_A, "original", "the value").await;
    put(&service, TENANT_A, "copy", "something else").await;
    put(&service, TENANT_A, "versioned", "version one").await;
    put(&service, TENANT_A, "versioned", "version two").await;
    let copy = |from: &str, to: &str| {
        format!(
            "UPDATE secret_versions SET nonce = src.nonce, ciphertext = src.ciphertext, auth_tag = src.auth_tag \
             FROM (SELECT v.* FROM secret_versions v JOIN secrets s ON s.id = v.secret_id WHERE {from}) src \
             WHERE secret_versions.secret_id = (SELECT id FROM secrets WHERE {to}) AND secret_versions.version = src.version"
        )
    };
    for sql in [
        copy(&format!("s.tenant_id = '{TENANT_A}' AND s.name = 'a'"), &format!("tenant_id = '{TENANT_B}' AND name = 'a'")),
        copy("s.name = 'original'", "name = 'copy'"),
        "UPDATE secret_versions SET nonce = src.nonce, ciphertext = src.ciphertext, auth_tag = src.auth_tag \
         FROM (SELECT * FROM secret_versions WHERE version = 1 AND secret_id = (SELECT id FROM secrets WHERE name = 'versioned')) src \
         WHERE secret_versions.version = 2 AND secret_versions.secret_id = src.secret_id"
            .to_string(),
    ] {
        sqlx::query(&sql).execute(&db).await.expect("move");
    }

    expect_generic_failure(injected(&service, TENANT_B, "a").await).await;
    expect_generic_failure(injected(&service, TENANT_A, "copy").await).await;
    expect_generic_failure(injected(&service, TENANT_A, "versioned").await).await;
    assert_eq!(
        injected(&service, TENANT_A, "original").await.json()["value"],
        "the value"
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn a_tenant_key_copied_to_another_tenant_is_refused(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "a", "value").await;
    put(&service, TENANT_B, "b", "value").await;
    sqlx::query(&format!(
        "UPDATE tenant_keys SET nonce = src.nonce, ciphertext = src.ciphertext, auth_tag = src.auth_tag \
         FROM (SELECT * FROM tenant_keys WHERE tenant_id = '{TENANT_A}') src WHERE tenant_keys.tenant_id = '{TENANT_B}'"
    ))
    .execute(&db)
    .await
    .expect("copy");

    expect_generic_failure(injected(&service, TENANT_B, "b").await).await;
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn the_wrong_master_key_cant_decrypt_but_metadata_still_works(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "x", "value").await;
    let wrong = start_with(&db, Arc::new(StaticKeyProvider::random()));

    expect_generic_failure(injected(&wrong, TENANT_A, "x").await).await;
    assert_eq!(get(&wrong, TENANT_A, "/secrets/x").await.status, 200);
    assert_eq!(get(&wrong, TENANT_A, "/secrets").await.status, 200);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn health_and_ready_need_no_tenant(db: PgPool) {
    let service = start(&db);

    let health = send(
        &service,
        Call::new(Method::GET, "/health", TENANT_A).without_tenant(),
    )
    .await;
    let ready = send(
        &service,
        Call::new(Method::GET, "/ready", TENANT_A).without_tenant(),
    )
    .await;

    assert_eq!(health.json(), json!({ "status": "ok" }));
    assert_eq!(
        ready.json(),
        json!({ "status": "ready", "checks": { "postgres": "up", "seal": "unsealed" } })
    );
    assert_eq!(health.header("cache-control"), None);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn ready_reports_why_it_isnt_ready(db: PgPool) {
    let service = start(&db);
    service.keys.set_state(secrets::keys::SealState::Sealed);
    let sealed = send(
        &service,
        Call::new(Method::GET, "/ready", TENANT_A).without_tenant(),
    )
    .await;
    assert_eq!(sealed.status, 503);
    assert_eq!(
        sealed.json(),
        json!({ "status": "not_ready", "reason": "sealed", "checks": { "postgres": "up", "seal": "sealed" } })
    );

    service.keys.set_state(secrets::keys::SealState::Unsealed);
    db.close().await;
    let down = send(
        &service,
        Call::new(Method::GET, "/ready", TENANT_A).without_tenant(),
    )
    .await;
    assert_eq!(down.status, 503);
    assert_eq!(
        down.json(),
        json!({ "status": "not_ready", "reason": "postgres_down", "checks": { "postgres": "down", "seal": "unsealed" } })
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn refuses_traffic_from_outside_the_internal_network(db: PgPool) {
    let service = start(&db);

    for peer in ["203.0.113.10:5000", "[2001:db8::1]:5000", "8.8.8.8:443"] {
        let answer = send(
            &service,
            Call::new(Method::GET, "/secrets", TENANT_A).sent_from(peer),
        )
        .await;
        expect_error(&answer, 403, "FORBIDDEN");
    }
    for peer in [
        "10.0.0.4:5000",
        "192.168.1.2:5000",
        "127.0.0.1:5000",
        "[::1]:5000",
        "[fd00::2]:5000",
        "[::ffff:172.18.0.9]:5000",
    ] {
        assert_eq!(
            send(
                &service,
                Call::new(Method::GET, "/secrets", TENANT_A).sent_from(peer)
            )
            .await
            .status,
            200
        );
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn a_sealed_or_uninitialised_service_refuses_every_secrets_route(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "x", "value").await;

    for (state, message) in [
        (
            secrets::keys::SealState::Sealed,
            "sealed until an operator unseals it",
        ),
        (
            secrets::keys::SealState::Uninitialised,
            "hasn't been initialised yet",
        ),
    ] {
        service.keys.set_state(state);
        for call in [
            Call::new(Method::GET, "/secrets", TENANT_A),
            Call::new(Method::GET, "/secrets/x", TENANT_A),
            Call::new(Method::PUT, "/secrets/x", TENANT_A).json(&json!({ "value": "v" })),
            Call::new(Method::PUT, "/secrets/x", TENANT_A).json(&json!({ "value": 42 })),
            Call::new(Method::GET, "/internal/secrets/x", TENANT_A),
            Call::new(Method::DELETE, "/internal/tenant", TENANT_A),
        ] {
            let answer = send(&service, call).await;
            expect_error(&answer, 503, "SECRETS_SEALED");
            assert_eq!(answer.header("retry-after").as_deref(), Some("30"));
            assert!(
                answer.json()["error"]["message"]
                    .as_str()
                    .expect("message")
                    .contains(message)
            );
        }
    }
    let health = send(
        &service,
        Call::new(Method::GET, "/health", TENANT_A).without_tenant(),
    )
    .await;
    assert_eq!(health.status, 200);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn refuses_new_requests_while_shutting_down(db: PgPool) {
    let service = start(&db);
    service
        .shutting_down
        .store(true, std::sync::atomic::Ordering::SeqCst);

    let answer = send(&service, Call::new(Method::GET, "/secrets", TENANT_A)).await;

    expect_error(&answer, 503, "SERVICE_UNAVAILABLE");
    assert_eq!(answer.header("connection").as_deref(), Some("close"));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn returns_its_request_id_and_keeps_a_valid_incoming_one(db: PgPool) {
    let service = start(&db);
    let given = "7c41e9d2-1111-4000-8000-000000000000";

    let kept = send(
        &service,
        Call::new(Method::GET, "/secrets/missing", TENANT_A).header("x-request-id", given),
    )
    .await;
    let replaced = send(
        &service,
        Call::new(Method::GET, "/secrets/missing", TENANT_A).header("x-request-id", "not-a-uuid"),
    )
    .await;

    assert_eq!(kept.header("x-request-id").as_deref(), Some(given));
    assert_eq!(kept.json()["error"]["requestId"], given);
    let new_id = replaced.header("x-request-id").expect("id");
    assert_ne!(new_id, "not-a-uuid");
    assert_eq!(replaced.json()["error"]["requestId"], new_id);
}
