use std::collections::HashMap;
use std::time::Duration;

use secrets::config::Config;

const TOKEN: &str = "a-token-that-is-at-least-32-characters-long";
const OTHER: &str = "another-token-that-is-at-least-32-characters";

fn load(pairs: &[(&str, &str)]) -> Result<Config, String> {
    let mut map: HashMap<String, String> = [
        ("DATABASE_URL", "postgres://secrets@db/secrets"),
        ("INTERNAL_SERVICE_TOKEN", TOKEN),
        ("IDENTITY_SERVICE_TOKEN", OTHER),
        ("AUDIT_TOKEN", TOKEN),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    for (key, value) in pairs {
        map.insert(key.to_string(), value.to_string());
    }
    Config::from_vars(|name| map.get(name).cloned())
}

#[test]
fn uses_safe_defaults() {
    let config = load(&[]).expect("config");
    assert_eq!(config.host, "0.0.0.0");
    assert_eq!(config.port, 3002);
    assert_eq!(config.audit_url, "http://localhost:3003");
    assert_eq!(config.audit_timeout, Duration::from_millis(2_000));
    assert_eq!(config.version, "dev");
    assert_eq!(config.max_secret_bytes, 64 * 1024);
    assert_eq!(config.seal.unseal_timeout, Duration::from_secs(600));
    assert_eq!(config.seal.max_failed_attempts, 5);
    assert_eq!(config.seal.lockout, Duration::from_secs(300));
    assert_eq!(config.seal.drain_timeout, Duration::from_secs(10));
    assert_eq!(config.shutdown_timeout, Duration::from_secs(25));
    assert!(!config.operator_socket.is_empty());
}

#[test]
fn reads_settings_from_the_environment() {
    let config = load(&[
        ("HOST", "127.0.0.1"),
        ("SECRETS_PORT", "4002"),
        ("AUDIT_URL", "http://audit:3003"),
        ("AUDIT_TIMEOUT_MS", "500"),
        ("SERVICE_VERSION", "1.2.3"),
        ("OPERATOR_SOCKET", "/run/test/operator.sock"),
        ("MAX_SECRET_BYTES", "1024"),
        ("UNSEAL_TIMEOUT_MS", "1000"),
        ("UNSEAL_MAX_FAILED_ATTEMPTS", "3"),
        ("UNSEAL_LOCKOUT_MS", "2000"),
        ("SEAL_DRAIN_TIMEOUT_MS", "3000"),
        ("SHUTDOWN_TIMEOUT_MS", ""),
    ])
    .expect("config");
    assert_eq!(config.host, "127.0.0.1");
    assert_eq!(config.port, 4002);
    assert_eq!(config.audit_url, "http://audit:3003");
    assert_eq!(config.audit_timeout, Duration::from_millis(500));
    assert_eq!(config.version, "1.2.3");
    assert_eq!(config.operator_socket, "/run/test/operator.sock");
    assert_eq!(config.max_secret_bytes, 1024);
    assert_eq!(config.seal.unseal_timeout, Duration::from_secs(1));
    assert_eq!(config.seal.max_failed_attempts, 3);
    assert_eq!(config.seal.lockout, Duration::from_secs(2));
    assert_eq!(config.seal.drain_timeout, Duration::from_secs(3));
    assert_eq!(config.shutdown_timeout, Duration::from_secs(25));
}

#[test]
fn refuses_missing_or_short_settings() {
    assert_eq!(
        load(&[("DATABASE_URL", "")]).expect_err("refused"),
        "DATABASE_URL must be set"
    );
    for name in [
        "INTERNAL_SERVICE_TOKEN",
        "IDENTITY_SERVICE_TOKEN",
        "AUDIT_TOKEN",
    ] {
        assert_eq!(
            load(&[(name, "short")]).expect_err("refused"),
            format!("{name} must be set, at least 32 characters")
        );
    }
}

#[test]
fn refuses_numbers_that_are_not_positive_or_too_big() {
    for value in ["0", "-1", "abc", "1.5"] {
        assert_eq!(
            load(&[("AUDIT_TIMEOUT_MS", value)]).expect_err("refused"),
            "AUDIT_TIMEOUT_MS must be a positive whole number"
        );
    }
    assert_eq!(
        load(&[("SECRETS_PORT", "70000")]).expect_err("refused"),
        "SECRETS_PORT must be a valid port"
    );
    assert_eq!(
        load(&[("UNSEAL_MAX_FAILED_ATTEMPTS", "99999999999")]).expect_err("refused"),
        "UNSEAL_MAX_FAILED_ATTEMPTS is too large"
    );
}

#[test]
fn reads_the_process_environment() {
    let error = Config::from_env().err();
    if std::env::var("INTERNAL_SERVICE_TOKEN").is_err() {
        assert!(error.is_some());
    }
}

#[tokio::test]
async fn connects_with_the_database_url() {
    secrets::logging::init("secrets", "test");
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL for the tests");
    let pool = secrets::db::connect(&url).await.expect("works");
    let one: i32 = sqlx::query_scalar("select 1")
        .fetch_one(&pool)
        .await
        .expect("works");
    assert_eq!(one, 1);
    pool.close().await;
}

#[sqlx::test(migrations = false)]
async fn applies_every_migration_to_an_empty_database(pool: sqlx::PgPool) {
    secrets::db::migrate(&pool).await.expect("works");
    secrets::db::MIGRATOR.run(&pool).await.expect("works");
}

#[derive(Clone, Default)]
struct Seen {
    requests: std::sync::Arc<std::sync::Mutex<Vec<axum::http::HeaderMap>>>,
    status: std::sync::Arc<std::sync::Mutex<u16>>,
}

async fn events(
    axum::extract::State(seen): axum::extract::State<Seen>,
    headers: axum::http::HeaderMap,
) -> axum::http::StatusCode {
    seen.requests.lock().expect("lock").push(headers);
    axum::http::StatusCode::from_u16(*seen.status.lock().expect("lock")).expect("works")
}

fn audit_event(request_id: Option<&str>) -> secrets::audit::AuditEvent {
    secrets::audit::AuditEvent {
        action: "secret.read".to_string(),
        outcome: "success",
        actor_type: "api_key",
        tenant_id: None,
        actor_id: None,
        resource_id: Some("db-password".to_string()),
        request_id: request_id.map(str::to_string),
        source_ip: None,
    }
}

#[tokio::test]
async fn sends_audit_events_and_refuses_the_action_when_they_fail() {
    use secrets::audit::{AuditClient, AuditTransport, AuditUnavailable, HttpAuditTransport};

    let seen = Seen::default();
    *seen.status.lock().expect("lock") = 201;
    let app = axum::Router::new()
        .route("/internal/events", axum::routing::post(events))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("works");
    let url = format!("http://{}/", listener.local_addr().expect("works"));
    tokio::spawn(async move { axum::serve(listener, app).await.expect("works") });

    let transport = std::sync::Arc::new(
        HttpAuditTransport::new(&url, TOKEN.to_string(), Duration::from_secs(2)).expect("works"),
    );
    let client = AuditClient::new(transport.clone());
    assert_eq!(client.record(audit_event(Some("req-1"))).await, Ok(()));
    transport.send(&audit_event(None)).await.expect("works");
    {
        let requests = seen.requests.lock().expect("lock");
        assert_eq!(requests[0]["x-audit-service"], "secrets");
        assert_eq!(requests[0]["authorization"], format!("Bearer {TOKEN}"));
        assert_eq!(requests[0]["x-request-id"], "req-1");
        assert!(!requests[1].contains_key("x-request-id"));
    }

    *seen.status.lock().expect("lock") = 503;
    assert_eq!(
        transport
            .send(&audit_event(None))
            .await
            .expect_err("refused"),
        "the audit service answered 503"
    );
    assert_eq!(
        client.record(audit_event(None)).await,
        Err(AuditUnavailable)
    );

    let unreachable = HttpAuditTransport::new(
        "http://127.0.0.1:1",
        TOKEN.to_string(),
        Duration::from_secs(2),
    )
    .expect("works");
    assert!(unreachable.send(&audit_event(None)).await.is_err());
}
