mod common;

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use common::StaticKeyProvider;
use secrets::crypto::envelope::{
    EncryptedData, decode_wrapped_key, decrypt_value, unwrap_file_key, unwrap_signing_key,
    unwrap_tenant_key,
};
use secrets::keys::key_from_slice;
use secrets::services::secret_service::SecretService;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

fn read_fixture(file: &str) -> Value {
    let path = format!("{}/../../tests/{file}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).expect("the fixture is readable");
    serde_json::from_str(&text).expect("the fixture is JSON")
}

fn secrets_fixture() -> Value {
    read_fixture("secrets/fixtures/compatibility-v1.json")
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().expect("a text field")
}

fn number(value: &Value, field: &str) -> i32 {
    i32::try_from(value[field].as_i64().expect("a number field")).expect("fits in i32")
}

fn hex_field(value: &Value, field: &str) -> Vec<u8> {
    hex::decode(text(value, field)).expect("a hex field")
}

fn encrypted(value: &Value, key_version_field: &str) -> EncryptedData {
    EncryptedData {
        format_version: i16::try_from(number(value, "formatVersion")).expect("fits in i16"),
        key_version: number(value, key_version_field),
        nonce: hex_field(value, "nonce"),
        ciphertext: hex_field(value, "ciphertext"),
        auth_tag: hex_field(value, "authTag"),
    }
}

fn master_keys(fixture: &Value) -> StaticKeyProvider {
    let master = &fixture["masterKey"];
    let key = STANDARD
        .decode(text(master, "base64"))
        .expect("base64 master key");
    StaticKeyProvider::with_versions(
        &[(number(master, "version"), &key)],
        number(master, "version"),
    )
}

#[test]
fn uses_the_fake_test_key_it_says_it_uses() {
    let fixture = secrets_fixture();
    let master = &fixture["masterKey"];
    let key = STANDARD
        .decode(text(master, "base64"))
        .expect("base64 master key");

    assert_eq!(String::from_utf8(key).expect("utf-8"), text(master, "text"));
    assert!(text(master, "text").starts_with("fake-test-"));
}

#[test]
fn decrypts_every_stored_value_with_the_rust_code() {
    let fixture = secrets_fixture();
    let keys = master_keys(&fixture);
    let tenant_id = text(&fixture, "tenantId");
    let tenant_key_row = &fixture["tenantKey"];

    let tenant_key = unwrap_tenant_key(
        &keys,
        tenant_id,
        number(tenant_key_row, "keyVersion"),
        &encrypted(tenant_key_row, "masterKeyVersion"),
    )
    .expect("the tenant key unwraps");

    let mut checked = 0;
    for secret in fixture["secrets"].as_array().expect("secrets") {
        for version in secret["versions"].as_array().expect("versions") {
            let value = decrypt_value(
                &tenant_key,
                tenant_id,
                text(secret, "name"),
                number(version, "version"),
                &encrypted(version, "tenantKeyVersion"),
            )
            .expect("the value decrypts");
            assert_eq!(value.as_str(), text(version, "expectedValue"));
            checked += 1;
        }
    }
    assert!(checked > 0);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn decrypts_every_stored_value_when_loaded_into_the_database(db: PgPool) {
    let fixture = secrets_fixture();
    let tenant_id = Uuid::parse_str(text(&fixture, "tenantId")).expect("uuid");
    let tenant_key_row = &fixture["tenantKey"];
    let tenant_key_data = encrypted(tenant_key_row, "masterKeyVersion");
    sqlx::query(
        "INSERT INTO tenant_keys (tenant_id, key_version, master_key_version, format_version, \
         nonce, ciphertext, auth_tag) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(tenant_id)
    .bind(number(tenant_key_row, "keyVersion"))
    .bind(tenant_key_data.key_version)
    .bind(tenant_key_data.format_version)
    .bind(&tenant_key_data.nonce)
    .bind(&tenant_key_data.ciphertext)
    .bind(&tenant_key_data.auth_tag)
    .execute(&db)
    .await
    .expect("insert the tenant key");

    for secret in fixture["secrets"].as_array().expect("secrets") {
        let versions = secret["versions"].as_array().expect("versions");
        let secret_id: Uuid = sqlx::query_scalar(
            "INSERT INTO secrets (tenant_id, name, latest_version) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(tenant_id)
        .bind(text(secret, "name"))
        .bind(i32::try_from(versions.len()).expect("fits"))
        .fetch_one(&db)
        .await
        .expect("insert the secret");
        for version in versions {
            let data = encrypted(version, "tenantKeyVersion");
            sqlx::query(
                "INSERT INTO secret_versions (secret_id, version, tenant_key_version, \
                 format_version, nonce, ciphertext, auth_tag) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(secret_id)
            .bind(number(version, "version"))
            .bind(data.key_version)
            .bind(data.format_version)
            .bind(&data.nonce)
            .bind(&data.ciphertext)
            .bind(&data.auth_tag)
            .execute(&db)
            .await
            .expect("insert the version");
        }
    }

    let service = SecretService::new(db, Arc::new(master_keys(&fixture)));
    for secret in fixture["secrets"].as_array().expect("secrets") {
        let name = text(secret, "name");
        let versions = secret["versions"].as_array().expect("versions");
        for version in versions {
            let stored = service
                .read(tenant_id, name, Some(number(version, "version")))
                .await
                .expect("read")
                .expect("found");
            assert_eq!(stored.value.as_str(), text(version, "expectedValue"));
        }
        let latest = service
            .read(tenant_id, name, None)
            .await
            .expect("read")
            .expect("found");
        let expected = versions.last().expect("at least one version");
        assert_eq!(latest.value.as_str(), text(expected, "expectedValue"));
    }

    let added = service
        .save(
            tenant_id,
            "added-after-the-rewrite",
            "new value",
            |_| async { Ok(()) },
        )
        .await
        .expect("a new secret saves with the old tenant key");
    assert_eq!(added.version, 1);
    let read_back = service
        .read(tenant_id, "added-after-the-rewrite", None)
        .await
        .expect("read")
        .expect("found");
    assert_eq!(read_back.value.as_str(), "new value");
}

#[test]
fn unwraps_file_and_signing_keys_wrapped_by_the_typescript_service() {
    let fixture = read_fixture("secrets/fixtures/wrapped-keys-v1.json");
    let tenant_id = text(&fixture, "tenantId");
    let tenant_key_bytes = STANDARD
        .decode(text(&fixture["tenantKey"], "base64"))
        .expect("base64 tenant key");
    assert_eq!(
        String::from_utf8(tenant_key_bytes.clone()).expect("utf-8"),
        text(&fixture["tenantKey"], "text")
    );
    assert!(text(&fixture["tenantKey"], "text").starts_with("fake-test-"));
    let tenant_key = key_from_slice(&tenant_key_bytes).expect("32 bytes");

    let file = &fixture["fileKey"];
    let wrapped = STANDARD.decode(text(file, "wrappedKey")).expect("base64");
    let file_key = unwrap_file_key(
        &tenant_key,
        tenant_id,
        text(file, "fileId"),
        &decode_wrapped_key(&wrapped).expect("decode"),
    )
    .expect("the file key unwraps");
    assert_eq!(file_key.as_ref(), text(file, "expectedText").as_bytes());

    let signing = &fixture["signingKey"];
    let wrapped = STANDARD
        .decode(text(signing, "wrappedKey"))
        .expect("base64");
    let signing_key = unwrap_signing_key(
        &tenant_key,
        tenant_id,
        text(signing, "poolId"),
        &decode_wrapped_key(&wrapped).expect("decode"),
    )
    .expect("the signing key unwraps");
    assert_eq!(
        signing_key.as_ref(),
        text(signing, "expectedText").as_bytes()
    );
}
