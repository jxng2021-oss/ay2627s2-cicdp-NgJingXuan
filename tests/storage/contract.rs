mod common;

use std::path::PathBuf;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};
use sqlx::PgPool;

fn spec() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../api/internal/storage.openapi.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("spec")).expect("spec json")
}

fn to_json_schema(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, inner) in map {
                if key == "nullable" {
                    continue;
                }
                out.insert(key.clone(), to_json_schema(inner));
            }
            if map.get("nullable") == Some(&Value::Bool(true))
                && let Some(Value::String(kind)) = map.get("type")
            {
                out.insert("type".into(), json!([kind, "null"]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(to_json_schema).collect()),
        other => other.clone(),
    }
}

fn check(schema_name: &str, body: &Value) {
    let spec = spec();
    let schema = json!({
        "$ref": format!("#/components/schemas/{schema_name}"),
        "components": to_json_schema(&spec["components"]),
    });
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .expect("schema");
    let errors: Vec<String> = validator
        .iter_errors(body)
        .map(|error| error.to_string())
        .collect();
    assert!(errors.is_empty(), "{schema_name}: {errors:?} in {body}");
}

fn documented(path: &str, method: &str, status: StatusCode) {
    let spec = spec();
    let responses = &spec["paths"][path][method]["responses"];
    assert!(
        responses.get(status.as_str()).is_some(),
        "{method} {path} answered {status}, which the contract doesn't list"
    );
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn file_routes_answer_as_the_contract_says(db: PgPool) {
    let storage = start(db, Settings::default());

    let uploaded = upload(&storage.app, b"contract check", Some("c.txt")).await;
    documented("/files", "post", uploaded.status);
    check("FileMetadata", &uploaded.json());
    let id = uploaded.json()["id"].as_str().expect("id").to_string();

    let list = send(&storage.app, Call::new(Method::GET, "/files?limit=1")).await;
    documented("/files", "get", list.status);
    check("FileList", &list.json());

    let metadata = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{id}/metadata")),
    )
    .await;
    documented("/files/{id}/metadata", "get", metadata.status);
    check("FileMetadata", &metadata.json());

    let usage = send(&storage.app, Call::new(Method::GET, "/usage")).await;
    documented("/usage", "get", usage.status);
    check("Usage", &usage.json());

    let download = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{id}")),
    )
    .await;
    documented("/files/{id}", "get", download.status);

    let deleted = send(
        &storage.app,
        Call::new(Method::DELETE, &format!("/files/{id}")),
    )
    .await;
    documented("/files/{id}", "delete", deleted.status);

    let tenant = send(&storage.app, Call::new(Method::DELETE, "/tenant")).await;
    documented("/tenant", "delete", tenant.status);

    let health = send(&storage.app, Call::new(Method::GET, "/health").tenant(None)).await;
    documented("/health", "get", health.status);
}

#[sqlx::test(migrator = "storage::db::MIGRATOR")]
async fn errors_use_the_documented_shape_and_codes(db: PgPool) {
    let storage = start(
        db,
        Settings {
            quota_bytes: 10,
            ..Settings::default()
        },
    );
    let missing = send(
        &storage.app,
        Call::new(Method::GET, &format!("/files/{}", uuid::Uuid::new_v4())),
    )
    .await;
    documented("/files/{id}", "get", missing.status);
    check("Error", &missing.json());

    let quota = upload(&storage.app, &[0u8; 50], None).await;
    documented("/files", "post", quota.status);
    check("Error", &quota.json());

    let no_tenant = send(&storage.app, Call::new(Method::GET, "/usage").tenant(None)).await;
    documented("/usage", "get", no_tenant.status);
    check("Error", &no_tenant.json());

    let outside = send(
        &storage.app,
        Call::new(Method::GET, "/files").peer("8.8.8.8:1"),
    )
    .await;
    documented("/files", "get", outside.status);
    check("Error", &outside.json());

    storage.keys.set(KeyMode::Sealed);
    let sealed = upload(&storage.app, b"x", None).await;
    documented("/files", "post", sealed.status);
    check("Error", &sealed.json());
}
