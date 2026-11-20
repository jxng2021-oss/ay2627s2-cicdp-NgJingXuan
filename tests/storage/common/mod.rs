#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use futures_util::future::BoxFuture;
use http_body_util::BodyExt;
use sqlx::PgPool;
use storage::app::{AppState, build_app};
use storage::audit::{AuditClient, AuditEvent, AuditTransport};
use storage::services::file_key_service::{FileKeyError, FileKeyService};
use storage::services::file_service::{FileService, FileServiceOptions};
use tower::ServiceExt;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const TENANT_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
pub const TENANT_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
pub const INTERNAL: &str = "172.18.0.5:40000";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum KeyMode {
    Working,
    Sealed,
    Unavailable,
}

pub struct FakeFileKeys {
    pub mode: Mutex<KeyMode>,
}

impl FakeFileKeys {
    pub fn set(&self, mode: KeyMode) {
        *self.mode.lock().expect("lock") = mode;
    }

    fn check(&self) -> Result<(), FileKeyError> {
        match *self.mode.lock().expect("lock") {
            KeyMode::Working => Ok(()),
            KeyMode::Sealed => Err(FileKeyError::Sealed),
            KeyMode::Unavailable => Err(FileKeyError::Unavailable),
        }
    }
}

fn binding(tenant_id: Uuid, file_id: Uuid) -> Vec<u8> {
    format!("{tenant_id}:{file_id}:").into_bytes()
}

impl FileKeyService for FakeFileKeys {
    fn wrap<'a>(
        &'a self,
        tenant_id: Uuid,
        file_id: Uuid,
        key: &'a [u8],
        _request_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, FileKeyError>> {
        Box::pin(async move {
            self.check()?;
            let mut wrapped = binding(tenant_id, file_id);
            wrapped.extend(key.iter().map(|byte| byte ^ 0x5a));
            Ok(wrapped)
        })
    }

    fn unwrap<'a>(
        &'a self,
        tenant_id: Uuid,
        file_id: Uuid,
        wrapped: &'a [u8],
        _request_id: &'a str,
    ) -> BoxFuture<'a, Result<Zeroizing<Vec<u8>>, FileKeyError>> {
        Box::pin(async move {
            self.check()?;
            let prefix = binding(tenant_id, file_id);
            if !wrapped.starts_with(&prefix) {
                return Err(FileKeyError::Rejected);
            }
            Ok(Zeroizing::new(
                wrapped[prefix.len()..]
                    .iter()
                    .map(|byte| byte ^ 0x5a)
                    .collect(),
            ))
        })
    }
}

#[derive(Default)]
pub struct FakeAudit {
    pub events: Mutex<Vec<AuditEvent>>,
    pub down: AtomicBool,
}

impl AuditTransport for FakeAudit {
    fn send<'a>(&'a self, event: &'a AuditEvent) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if self.down.load(Ordering::SeqCst) {
                return Err("audit service is down".into());
            }
            self.events.lock().expect("lock").push(event.clone());
            Ok(())
        })
    }
}

impl FakeAudit {
    pub async fn actions(&self) -> Vec<String> {
        tokio::time::sleep(Duration::from_millis(30)).await;
        self.events
            .lock()
            .expect("lock")
            .iter()
            .map(|event| format!("{}:{}", event.action, event.outcome))
            .collect()
    }
}

pub struct Settings {
    pub max_upload_bytes: u64,
    pub quota_bytes: u64,
    pub chunk_size: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_upload_bytes: 1024 * 1024,
            quota_bytes: 4 * 1024 * 1024,
            chunk_size: 64,
        }
    }
}

pub struct TestStorage {
    pub app: Router,
    pub db: PgPool,
    pub data_dir: PathBuf,
    pub keys: Arc<FakeFileKeys>,
    pub audit: Arc<FakeAudit>,
    pub shutting_down: Arc<AtomicBool>,
}

impl Drop for TestStorage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

pub fn start(db: PgPool, settings: Settings) -> TestStorage {
    let data_dir = std::env::temp_dir().join(format!("storage-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).expect("data dir");
    let keys = Arc::new(FakeFileKeys {
        mode: Mutex::new(KeyMode::Working),
    });
    let audit = Arc::new(FakeAudit::default());
    let shutting_down = Arc::new(AtomicBool::new(false));
    let state = AppState {
        files: Arc::new(FileService::new(FileServiceOptions {
            db: db.clone(),
            data_dir: data_dir.clone(),
            max_upload_bytes: settings.max_upload_bytes,
            quota_bytes: settings.quota_bytes,
            file_keys: keys.clone(),
            chunk_size: settings.chunk_size,
        })),
        audit: AuditClient::new(
            audit.clone(),
            vec![Duration::from_millis(1), Duration::from_millis(1)],
        ),
        shutting_down: shutting_down.clone(),
        version: Arc::from("test"),
    };
    TestStorage {
        app: build_app(state),
        db,
        data_dir,
        keys,
        audit,
        shutting_down,
    }
}

pub struct Answer {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Answer {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("json body")
    }

    pub fn code(&self) -> String {
        self.json()["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }
}

pub struct Call<'a> {
    pub method: Method,
    pub uri: &'a str,
    pub tenant: Option<&'a str>,
    pub headers: Vec<(&'a str, String)>,
    pub body: Body,
    pub peer: &'a str,
}

impl<'a> Call<'a> {
    pub fn new(method: Method, uri: &'a str) -> Self {
        Self {
            method,
            uri,
            tenant: Some(TENANT_A),
            headers: Vec::new(),
            body: Body::empty(),
            peer: INTERNAL,
        }
    }

    pub fn tenant(mut self, tenant: Option<&'a str>) -> Self {
        self.tenant = tenant;
        self
    }

    pub fn header(mut self, name: &'a str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    pub fn body(mut self, body: impl Into<Body>) -> Self {
        self.body = body.into();
        self
    }

    pub fn peer(mut self, peer: &'a str) -> Self {
        self.peer = peer;
        self
    }
}

pub async fn send(app: &Router, call: Call<'_>) -> Answer {
    let mut builder = Request::builder().method(call.method).uri(call.uri);
    if let Some(tenant) = call.tenant {
        builder = builder.header("x-tenant-id", tenant);
    }
    for (name, value) in call.headers {
        builder = builder.header(name, value);
    }
    let mut request = builder.body(call.body).expect("request");
    let peer: SocketAddr = call.peer.parse().expect("peer");
    request.extensions_mut().insert(ConnectInfo(peer));
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = match response.into_body().collect().await {
        Ok(collected) => collected.to_bytes().to_vec(),
        Err(_) => b"<aborted>".to_vec(),
    };
    Answer {
        status,
        headers,
        body,
    }
}

pub async fn upload(app: &Router, content: &[u8], name: Option<&str>) -> Answer {
    let mut call = Call::new(Method::POST, "/files")
        .header("content-type", "text/plain")
        .header("content-length", content.len().to_string())
        .body(content.to_vec());
    if let Some(name) = name {
        call = call.header("x-file-name", name.to_string());
    }
    send(app, call).await
}

pub fn files_on_disk(data_dir: &std::path::Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut folders = vec![data_dir.to_path_buf()];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                folders.push(path);
            } else {
                found.push(path);
            }
        }
    }
    found
}
