mod common;

use axum::http::Method;
use common::http::{Call, Service, capture_logs, injected, put, send, start};
use common::{TENANT_A, TENANT_B};
use secrets::audit::AuditEvent;
use serde_json::json;
use sqlx::PgPool;

const ACTOR: &str = "0e1d2c3b-4a59-4687-9a8b-1c2d3e4f5a6b";
const REQUEST_ID: &str = "7c41e9d2-2222-4000-8000-000000000000";

fn from_api_key(call: Call) -> Call {
    call.header("x-actor-id", ACTOR)
        .header("x-client-ip", "203.0.113.7")
        .header("x-request-id", REQUEST_ID)
}

async fn act(
    service: &Service,
    method: Method,
    path: &str,
    value: Option<&str>,
) -> common::http::Answer {
    let mut call = from_api_key(Call::new(method, path, TENANT_A));
    if let Some(value) = value {
        call = call.json(&json!({ "value": value }));
    }
    send(service, call).await
}

fn expected(action: &str) -> AuditEvent {
    AuditEvent {
        action: action.to_string(),
        outcome: "success",
        actor_type: "api_key",
        tenant_id: Some(TENANT_A.to_string()),
        actor_id: Some(ACTOR.to_string()),
        resource_id: Some("db-password".to_string()),
        request_id: Some(REQUEST_ID.to_string()),
        source_ip: Some("203.0.113.7".to_string()),
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn create_rotate_read_and_delete_each_make_the_right_event(db: PgPool) {
    let service = start(&db);

    act(
        &service,
        Method::PUT,
        "/secrets/db-password",
        Some("v1-value"),
    )
    .await;
    act(
        &service,
        Method::PUT,
        "/secrets/db-password",
        Some("v2-value"),
    )
    .await;
    act(
        &service,
        Method::POST,
        "/secrets/db-password/rotate",
        Some("v3-value"),
    )
    .await;
    act(&service, Method::GET, "/internal/secrets/db-password", None).await;
    act(&service, Method::DELETE, "/secrets/db-password", None).await;

    assert_eq!(
        service.audit.events(),
        [
            "secret.created",
            "secret.rotated",
            "secret.rotated",
            "secret.read",
            "secret.deleted"
        ]
        .map(expected)
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn records_nothing_for_lists_metadata_or_missing_secrets(db: PgPool) {
    let service = start(&db);
    act(&service, Method::PUT, "/secrets/db-password", Some("v")).await;
    service.audit.clear();

    act(&service, Method::GET, "/secrets", None).await;
    act(&service, Method::GET, "/secrets/db-password", None).await;
    act(&service, Method::GET, "/secrets/db-password/versions", None).await;
    act(&service, Method::GET, "/secrets/missing", None).await;
    act(&service, Method::DELETE, "/secrets/missing", None).await;
    act(&service, Method::POST, "/secrets/missing/rotate", Some("x")).await;
    act(&service, Method::GET, "/internal/secrets/missing", None).await;
    act(&service, Method::POST, "/secrets/db-password/reveal", None).await;

    assert!(service.audit.events().is_empty());
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn ignores_malformed_actor_and_ip_headers(db: PgPool) {
    let service = start(&db);

    send(
        &service,
        Call::new(Method::PUT, "/secrets/db-password", TENANT_A)
            .json(&json!({ "value": "v" }))
            .header("x-actor-id", "sk_live_not-an-id")
            .header("x-client-ip", "<script>"),
    )
    .await;

    let event = &service.audit.events()[0];
    assert_eq!(event.actor_type, "service");
    assert_eq!(
        (event.actor_id.as_deref(), event.source_ip.as_deref()),
        (None, None)
    );
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn records_a_dashboard_user_as_the_actor_and_anything_else_as_an_api_key(db: PgPool) {
    let service = start(&db);

    act(&service, Method::PUT, "/secrets/db-password", Some("v")).await;
    send(
        &service,
        from_api_key(Call::new(Method::PUT, "/secrets/db-password", TENANT_A))
            .json(&json!({ "value": "v" }))
            .header("x-actor-type", "user"),
    )
    .await;
    send(
        &service,
        from_api_key(Call::new(Method::PUT, "/secrets/db-password", TENANT_A))
            .json(&json!({ "value": "v" }))
            .header("x-actor-type", "admin"),
    )
    .await;

    let kinds: Vec<_> = service
        .audit
        .events()
        .iter()
        .map(|event| event.actor_type)
        .collect();
    assert_eq!(kinds, ["api_key", "user", "api_key"]);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn never_puts_a_value_in_an_event(db: PgPool) {
    let service = start(&db);

    act(
        &service,
        Method::PUT,
        "/secrets/db-password",
        Some("super-secret-value-123"),
    )
    .await;
    act(&service, Method::GET, "/internal/secrets/db-password", None).await;

    assert!(!format!("{:?}", service.audit.events()).contains("super-secret-value"));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn without_the_audit_log_an_injection_read_is_refused_and_no_value_returned(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "db-password", "must-not-leak").await;
    service.audit.fail(true);

    let answer = injected(&service, TENANT_A, "db-password").await;

    assert_eq!(answer.status, 503);
    assert_eq!(answer.error_code(), "SERVICE_UNAVAILABLE");
    assert!(!answer.text().contains("must-not-leak"));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn without_the_audit_log_changes_are_refused_and_rolled_back(db: PgPool) {
    let service = start(&db);
    put(&service, TENANT_A, "db-password", "kept").await;
    service.audit.fail(true);

    let answers = [
        put(&service, TENANT_A, "db-password", "refused").await,
        put(&service, TENANT_A, "new-one", "refused").await,
        send(
            &service,
            Call::new(Method::POST, "/secrets/db-password/rotate", TENANT_A)
                .json(&json!({ "value": "refused" })),
        )
        .await,
        send(
            &service,
            Call::new(Method::DELETE, "/secrets/db-password", TENANT_A),
        )
        .await,
    ];

    for answer in answers {
        assert_eq!(
            (answer.status, answer.error_code().as_str()),
            (503, "SERVICE_UNAVAILABLE")
        );
    }
    service.audit.fail(false);
    assert_eq!(
        injected(&service, TENANT_A, "db-password").await.json()["value"],
        "kept"
    );
    let versions: i64 = sqlx::query_scalar("SELECT count(*) FROM secret_versions")
        .fetch_one(&db)
        .await
        .expect("count");
    assert_eq!(versions, 1);
    assert_eq!(put(&service, TENANT_B, "fine", "v").await.status, 201);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn logs_one_json_line_per_request_without_values_or_tokens(db: PgPool) {
    let (logs, _guard) = capture_logs();
    let service = start(&db);

    put(
        &service,
        TENANT_A,
        "db-password",
        "logged-value-must-not-appear",
    )
    .await;
    send(
        &service,
        Call::new(Method::GET, "/secrets/db-password", TENANT_A).header("x-request-id", REQUEST_ID),
    )
    .await;
    put(
        &service,
        TENANT_A,
        "bad%20name",
        "logged-value-must-not-appear",
    )
    .await;

    let lines: Vec<_> = logs
        .lines()
        .into_iter()
        .filter(|line| line["message"] == "request completed")
        .collect();
    assert_eq!(lines.len(), 3);
    let read = &lines[1];
    assert_eq!(read["service"], "secrets");
    assert_eq!(read["version"], "dev");
    assert_eq!(read["requestId"], REQUEST_ID);
    assert_eq!(read["route"], "/secrets/:name");
    assert_eq!(read["method"], "GET");
    assert_eq!(read["status"], 200);
    assert!(read["durationMs"].is_number());
    assert!(!logs.text().contains("logged-value-must-not-appear"));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn logs_why_decryption_failed_but_answers_generically(db: PgPool) {
    let (logs, _guard) = capture_logs();
    let service = start(&db);
    put(
        &service,
        TENANT_A,
        "db-password",
        "value-that-must-stay-hidden",
    )
    .await;
    let wrong = common::http::start_with(
        &db,
        std::sync::Arc::new(common::StaticKeyProvider::random()),
    );

    let answer = injected(&wrong, TENANT_A, "db-password").await;

    assert_eq!(answer.status, 500);
    assert!(logs.text().contains("decryption failed"));
    assert!(!logs.text().contains("value-that-must-stay-hidden"));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn operator_actions_are_not_part_of_the_http_api(db: PgPool) {
    let service = start(&db);

    for (method, path) in [
        (Method::GET, "/status"),
        (Method::POST, "/init"),
        (Method::POST, "/unseal"),
        (Method::POST, "/seal"),
    ] {
        let answer = send(
            &service,
            Call::new(method, path, TENANT_A).json(&json!({ "share": "x" })),
        )
        .await;
        assert_eq!(answer.status, 404);
    }
}
