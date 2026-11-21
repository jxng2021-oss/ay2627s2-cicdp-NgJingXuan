use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Method, Request};
use http_body_util::BodyExt;
use secrets::app::{AppState, build_app, route_of};
use secrets::audit::{AuditClient, AuditEvent, AuditTransport, SendFuture};
use secrets::services::secret_service::SecretService;
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;

use super::StaticKeyProvider;
use super::contract;

pub const INTERNAL_SERVICE_TOKEN: &str = "test-internal-service-token-0123456789abcdef";
pub const IDENTITY_SERVICE_TOKEN: &str = "test-identity-service-token-0123456789abcdef";
pub const MAX_SECRET_BYTES: usize = 1024;
pub const INTERNAL_PEER: &str = "172.18.0.5:40000";

#[derive(Default)]
pub struct FakeAudit {
    pub events: Mutex<Vec<AuditEvent>>,
    pub failing: AtomicBool,
}

impl FakeAudit {
    pub fn events(&self) -> Vec<AuditEvent> {
        self.events.lock().expect("lock").clone()
    }

    pub fn actions(&self) -> Vec<String> {
        self.events()
            .into_iter()
            .map(|event| event.action)
            .collect()
    }

    pub fn clear(&self) {
        self.events.lock().expect("lock").clear();
    }

    pub fn fail(&self, failing: bool) {
        self.failing.store(failing, Ordering::SeqCst);
    }
}

impl AuditTransport for FakeAudit {
    fn send<'a>(&'a self, event: &'a AuditEvent) -> SendFuture<'a> {
        Box::pin(async move {
            if self.failing.load(Ordering::SeqCst) {
                return Err("the audit service is down".to_string());
            }
            self.events.lock().expect("lock").push(event.clone());
            Ok(())
        })
    }
}

pub struct Service {
    pub app: Router,
    pub keys: Arc<StaticKeyProvider>,
    pub audit: Arc<FakeAudit>,
    pub db: PgPool,
    pub shutting_down: Arc<AtomicBool>,
}

pub fn start(db: &PgPool) -> Service {
    start_with(db, Arc::new(StaticKeyProvider::random()))
}

pub fn start_with(db: &PgPool, keys: Arc<StaticKeyProvider>) -> Service {
    let audit = Arc::new(FakeAudit::default());
    let shutting_down = Arc::new(AtomicBool::new(false));
    let state = AppState {
        secrets: Arc::new(SecretService::new(db.clone(), keys.clone())),
        keys: keys.clone(),
        audit: AuditClient::new(audit.clone()),
        db: db.clone(),
        max_secret_bytes: MAX_SECRET_BYTES,
        internal_service_token: Arc::from(INTERNAL_SERVICE_TOKEN),
        identity_service_token: Arc::from(IDENTITY_SERVICE_TOKEN),
        shutting_down: shutting_down.clone(),
        version: Arc::from("dev"),
    };
    Service {
        app: build_app(state),
        keys,
        audit,
        db: db.clone(),
        shutting_down,
    }
}

pub struct Call {
    pub method: Method,
    pub path: String,
    pub tenant: Option<String>,
    pub body: Option<String>,
    pub content_type: Option<String>,
    pub headers: Vec<(String, String)>,
    pub peer: SocketAddr,
}

impl Call {
    pub fn new(method: Method, path: &str, tenant: &str) -> Self {
        Self {
            method,
            path: path.to_string(),
            tenant: Some(tenant.to_string()),
            body: None,
            content_type: None,
            headers: Vec::new(),
            peer: INTERNAL_PEER.parse().expect("address"),
        }
    }

    pub fn json(mut self, body: &Value) -> Self {
        self.body = Some(body.to_string());
        self.content_type = Some("application/json".to_string());
        self
    }

    pub fn raw_body(mut self, body: &str, content_type: Option<&str>) -> Self {
        self.body = Some(body.to_string());
        self.content_type = content_type.map(str::to_string);
        self
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn token(self, token: &str) -> Self {
        self.header("authorization", &format!("Bearer {token}"))
    }

    pub fn without_tenant(mut self) -> Self {
        self.tenant = None;
        self
    }

    pub fn sent_from(mut self, peer: &str) -> Self {
        self.peer = peer.parse().expect("address");
        self
    }
}

pub struct Answer {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Answer {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .map(|value| value.to_str().expect("text").to_string())
    }

    pub fn error_code(&self) -> String {
        self.json()["error"]["code"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }
}

pub async fn send(service: &Service, call: Call) -> Answer {
    let route = route_of(&call.method, call.path.split('?').next().unwrap_or(""));
    let method = call.method.clone();
    let mut builder = Request::builder().method(call.method).uri(&call.path);
    if let Some(tenant) = &call.tenant {
        builder = builder.header("x-tenant-id", tenant);
    }
    if let Some(content_type) = &call.content_type {
        builder = builder.header("content-type", content_type);
    }
    for (name, value) in &call.headers {
        builder = builder.header(name, value);
    }
    let mut request = builder
        .body(Body::from(call.body.unwrap_or_default()))
        .expect("request");
    request.extensions_mut().insert(ConnectInfo(call.peer));
    let response = service
        .app
        .clone()
        .oneshot(request)
        .await
        .expect("response");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    let answer = Answer {
        status,
        headers,
        body,
    };
    if let Some(route) = route {
        contract::check(&method, route, &answer);
    }
    answer
}

pub async fn put(service: &Service, tenant: &str, name: &str, value: &str) -> Answer {
    send(
        service,
        Call::new(Method::PUT, &format!("/secrets/{name}"), tenant)
            .json(&serde_json::json!({ "value": value })),
    )
    .await
}

pub async fn get(service: &Service, tenant: &str, path: &str) -> Answer {
    send(service, Call::new(Method::GET, path, tenant)).await
}

pub async fn injected(service: &Service, tenant: &str, name: &str) -> Answer {
    get(service, tenant, &format!("/internal/secrets/{name}")).await
}

#[derive(Clone, Default)]
pub struct Logs(Arc<Mutex<Vec<u8>>>);

impl Logs {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("lock")).into_owned()
    }

    pub fn lines(&self) -> Vec<Value> {
        self.text()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
}

thread_local! {
    static CAPTURING: std::cell::RefCell<Option<Logs>> = const { std::cell::RefCell::new(None) };
}

struct ThreadWriter;

impl std::io::Write for ThreadWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        CAPTURING.with(|capturing| {
            if let Some(logs) = capturing.borrow().as_ref() {
                logs.0.lock().expect("lock").extend_from_slice(bytes);
            }
        });
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub struct Capture;

impl Drop for Capture {
    fn drop(&mut self) {
        CAPTURING.with(|capturing| *capturing.borrow_mut() = None);
    }
}

pub fn capture_logs() -> (Logs, Capture) {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        let subscriber = tracing_subscriber::fmt()
            .json()
            .flatten_event(true)
            .with_current_span(false)
            .with_span_list(false)
            .with_target(false)
            .with_writer(|| ThreadWriter)
            .finish();
        let _ = tracing::subscriber::set_global_default(subscriber);
    });
    let logs = Logs::default();
    CAPTURING.with(|capturing| *capturing.borrow_mut() = Some(logs.clone()));
    (logs, Capture)
}
