use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::routing::post;
use futures_util::future::BoxFuture;
use storage::audit::{AuditClient, AuditEvent, AuditTransport, HttpAuditTransport};
use storage::services::file_key_service::{FileKeyError, FileKeyService, HttpFileKeyService};
use uuid::Uuid;

const TOKEN: &str = "a-token-that-is-at-least-32-characters-long";

#[derive(Clone, Default)]
struct Seen {
    requests: Arc<Mutex<Vec<(String, HeaderMap, String)>>>,
    answer: Arc<Mutex<(u16, String)>>,
}

async fn answer(
    State(seen): State<Seen>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    seen.requests.lock().expect("lock").push((
        uri.path().to_string(),
        headers,
        String::from_utf8_lossy(&body).to_string(),
    ));
    let (status, text) = seen.answer.lock().expect("lock").clone();
    (StatusCode::from_u16(status).expect("works"), text)
}

async fn fake_service(status: u16, text: &str) -> (String, Seen) {
    let seen = Seen::default();
    *seen.answer.lock().expect("lock") = (status, text.to_string());
    let app = Router::new()
        .route("/internal/file-keys/{action}", post(answer))
        .route("/internal/events", post(answer))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("works");
    let url = format!("http://{}/", listener.local_addr().expect("works"));
    tokio::spawn(async move { axum::serve(listener, app).await.expect("works") });
    (url, seen)
}

fn set_answer(seen: &Seen, status: u16, text: &str) {
    *seen.answer.lock().expect("lock") = (status, text.to_string());
}

fn key_service(url: &str) -> HttpFileKeyService {
    HttpFileKeyService::new(url, TOKEN.to_string(), Duration::from_secs(2)).expect("works")
}

#[tokio::test]
async fn wraps_and_unwraps_file_keys_through_the_secrets_service() {
    let (url, seen) = fake_service(200, r#"{"wrappedKey":"d3JhcHBlZA=="}"#).await;
    let keys = key_service(&url);
    let tenant = Uuid::new_v4();
    let file = Uuid::new_v4();

    let wrapped = keys
        .wrap(tenant, file, &[1, 2, 3], "req-1")
        .await
        .expect("works");
    assert_eq!(wrapped, b"wrapped");

    set_answer(&seen, 200, r#"{"key":"cGxhaW4="}"#);
    let key = keys
        .unwrap(tenant, file, &wrapped, "req-2")
        .await
        .expect("works");
    assert_eq!(key.as_slice(), b"plain");

    let requests = seen.requests.lock().expect("lock");
    let (path, headers, body) = &requests[0];
    assert_eq!(path, "/internal/file-keys/wrap");
    assert_eq!(headers["authorization"], format!("Bearer {TOKEN}"));
    assert_eq!(headers["x-tenant-id"], tenant.to_string());
    assert_eq!(headers["x-request-id"], "req-1");
    assert!(body.contains(&file.to_string()));
    assert!(body.contains("AQID"));
    assert_eq!(requests[1].0, "/internal/file-keys/unwrap");
}

#[tokio::test]
async fn reports_a_sealed_vault_a_refused_key_and_other_failures() {
    let (url, seen) = fake_service(503, r#"{"error":{"code":"SECRETS_SEALED"}}"#).await;
    let keys = key_service(&url);
    let (tenant, file) = (Uuid::new_v4(), Uuid::new_v4());

    assert_eq!(
        keys.wrap(tenant, file, b"k", "r").await,
        Err(FileKeyError::Sealed)
    );
    assert_eq!(
        keys.unwrap(tenant, file, b"k", "r")
            .await
            .expect_err("refused"),
        FileKeyError::Sealed
    );

    set_answer(&seen, 500, r#"{"error":{"code":"INTERNAL_ERROR"}}"#);
    assert_eq!(
        keys.unwrap(tenant, file, b"k", "r")
            .await
            .expect_err("refused"),
        FileKeyError::Rejected
    );
    assert_eq!(
        keys.wrap(tenant, file, b"k", "r").await,
        Err(FileKeyError::Unavailable)
    );

    set_answer(&seen, 503, "not json");
    assert_eq!(
        keys.wrap(tenant, file, b"k", "r").await,
        Err(FileKeyError::Unavailable)
    );

    set_answer(&seen, 200, "{}");
    assert_eq!(
        keys.wrap(tenant, file, b"k", "r").await,
        Err(FileKeyError::Unavailable)
    );
    assert_eq!(
        keys.unwrap(tenant, file, b"k", "r")
            .await
            .expect_err("refused"),
        FileKeyError::Unavailable
    );

    set_answer(&seen, 200, r#"{"wrappedKey":"!!!","key":"!!!"}"#);
    assert_eq!(
        keys.wrap(tenant, file, b"k", "r").await,
        Err(FileKeyError::Unavailable)
    );
    assert_eq!(
        keys.unwrap(tenant, file, b"k", "r")
            .await
            .expect_err("refused"),
        FileKeyError::Unavailable
    );
}

#[tokio::test]
async fn an_unreachable_secrets_service_is_unavailable() {
    let keys = key_service("http://127.0.0.1:1");
    assert_eq!(
        keys.wrap(Uuid::new_v4(), Uuid::new_v4(), b"k", "r").await,
        Err(FileKeyError::Unavailable)
    );
}

fn event(request_id: Option<&str>) -> AuditEvent {
    AuditEvent {
        action: "file.uploaded".to_string(),
        outcome: "success",
        actor_type: "api_key",
        tenant_id: Some(Uuid::new_v4().to_string()),
        actor_id: None,
        resource_id: Some(Uuid::new_v4().to_string()),
        request_id: request_id.map(str::to_string),
        source_ip: None,
    }
}

#[tokio::test]
async fn sends_audit_events_with_the_service_name_and_token() {
    let (url, seen) = fake_service(201, "{}").await;
    let transport =
        HttpAuditTransport::new(&url, TOKEN.to_string(), Duration::from_secs(2)).expect("works");

    transport.send(&event(Some("req-9"))).await.expect("works");
    transport.send(&event(None)).await.expect("works");
    set_answer(&seen, 503, "{}");
    assert_eq!(
        transport.send(&event(None)).await.expect_err("refused"),
        "the audit service answered 503"
    );

    let requests = seen.requests.lock().expect("lock");
    let (path, headers, body) = &requests[0];
    assert_eq!(path, "/internal/events");
    assert_eq!(headers["x-audit-service"], "storage");
    assert_eq!(headers["authorization"], format!("Bearer {TOKEN}"));
    assert_eq!(headers["x-request-id"], "req-9");
    assert!(body.contains(r#""action":"file.uploaded""#));
    assert!(!requests[1].1.contains_key("x-request-id"));
}

#[tokio::test]
async fn an_unreachable_audit_service_is_an_error() {
    let transport = HttpAuditTransport::new(
        "http://127.0.0.1:1",
        TOKEN.to_string(),
        Duration::from_secs(2),
    )
    .expect("works");
    assert!(transport.send(&event(None)).await.is_err());
}

struct Flaky {
    failures: AtomicUsize,
    calls: AtomicUsize,
}

impl AuditTransport for Flaky {
    fn send<'a>(&'a self, _event: &'a AuditEvent) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.failures.load(Ordering::SeqCst) > 0 {
                self.failures.fetch_sub(1, Ordering::SeqCst);
                Err("down".to_string())
            } else {
                Ok(())
            }
        })
    }
}

#[tokio::test]
async fn retries_best_effort_events_then_gives_up() {
    let recovers = Arc::new(Flaky {
        failures: AtomicUsize::new(1),
        calls: AtomicUsize::new(0),
    });
    AuditClient::new(recovers.clone(), vec![Duration::from_millis(1)])
        .record_best_effort(event(None))
        .await
        .expect("works");
    assert_eq!(recovers.calls.load(Ordering::SeqCst), 2);

    let lost = Arc::new(Flaky {
        failures: AtomicUsize::new(10),
        calls: AtomicUsize::new(0),
    });
    AuditClient::new(lost.clone(), vec![Duration::from_millis(1)])
        .record_best_effort(event(Some("req-lost")))
        .await
        .expect("works");
    assert_eq!(lost.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn connects_with_the_database_url() {
    storage::logging::init("storage", "test");
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL for the tests");
    let pool = storage::db::connect(&url).await.expect("works");
    let one: i32 = sqlx::query_scalar("select 1")
        .fetch_one(&pool)
        .await
        .expect("works");
    assert_eq!(one, 1);
    pool.close().await;
}

#[sqlx::test(migrations = false)]
async fn applies_every_migration_to_an_empty_database(pool: sqlx::PgPool) {
    storage::db::migrate(&pool).await.expect("works");
    let files: i64 = sqlx::query_scalar("select count(*) from files")
        .fetch_one(&pool)
        .await
        .expect("works");
    assert_eq!(files, 0);
}
