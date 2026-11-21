mod common;

use std::collections::BTreeSet;

use axum::http::Method;
use common::contract::spec;
use common::http::{Call, injected, put, send, start};
use common::{TENANT_A, TENANT_B};
use serde_json::{Value, json};
use sqlx::PgPool;

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn every_route_answers_as_the_contract_says(db: PgPool) {
    let service = start(&db);

    assert_eq!(put(&service, TENANT_A, "contract", "one").await.status, 201);
    assert_eq!(put(&service, TENANT_A, "contract", "two").await.status, 200);
    for path in [
        "/secrets/contract",
        "/secrets/contract?version=1",
        "/secrets/contract/versions",
        "/secrets",
    ] {
        assert_eq!(
            send(&service, Call::new(Method::GET, path, TENANT_A))
                .await
                .status,
            200
        );
    }
    let rotate = Call::new(Method::POST, "/secrets/contract/rotate", TENANT_A)
        .json(&json!({ "value": "three" }));
    assert_eq!(send(&service, rotate).await.status, 200);
    assert_eq!(injected(&service, TENANT_A, "contract").await.status, 200);
    assert_eq!(
        send(
            &service,
            Call::new(Method::DELETE, "/secrets/contract", TENANT_A)
        )
        .await
        .status,
        204
    );
    for path in ["/health", "/ready"] {
        assert_eq!(
            send(
                &service,
                Call::new(Method::GET, path, TENANT_A).without_tenant()
            )
            .await
            .status,
            200
        );
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn errors_are_documented_on_every_route(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "mine", "v").await;

    for call in [
        Call::new(Method::GET, "/secrets/mine", TENANT_B),
        Call::new(Method::GET, "/secrets/mine?version=9", TENANT_A),
        Call::new(Method::GET, "/secrets/mine/versions", TENANT_B),
        Call::new(Method::DELETE, "/secrets/mine", TENANT_B),
        Call::new(Method::GET, "/secrets/-bad", TENANT_A),
        Call::new(Method::GET, "/secrets?limit=500", TENANT_A),
        Call::new(Method::GET, "/secrets", "not-a-uuid"),
        Call::new(Method::GET, "/secrets", TENANT_A).sent_from("198.51.100.4:80"),
        Call::new(Method::PUT, "/secrets/x", TENANT_A).raw_body("v", Some("text/plain")),
        Call::new(Method::PUT, "/secrets/x", TENANT_A).json(&json!({ "value": "x".repeat(2000) })),
        Call::new(Method::GET, "/health", TENANT_A)
            .without_tenant()
            .sent_from("198.51.100.4:80"),
    ] {
        let answer = send(&service, call).await;
        assert!(answer.status >= 400);
    }
}

fn error_codes(spec: &Value, codes: &mut BTreeSet<String>) {
    match spec {
        Value::Object(map) => {
            for (key, inner) in map {
                if key == "code"
                    && let Some(values) = inner["enum"].as_array()
                {
                    codes.extend(values.iter().filter_map(Value::as_str).map(str::to_string));
                }
                error_codes(inner, codes);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| error_codes(item, codes)),
        _ => {}
    }
}

#[test]
fn only_uses_error_codes_that_the_public_api_also_documents() {
    let mut internal = BTreeSet::new();
    let mut public = BTreeSet::new();
    error_codes(&spec("api/internal/secrets.openapi.json"), &mut internal);
    error_codes(&spec("api/openapi.v1.json"), &mut public);

    assert!(!internal.is_empty());
    assert_eq!(
        internal.difference(&public).collect::<Vec<_>>(),
        Vec::<&String>::new()
    );
}
