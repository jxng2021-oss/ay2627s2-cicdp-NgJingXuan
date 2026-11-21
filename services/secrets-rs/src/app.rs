use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::audit::AuditClient;
use crate::context::{RequestContext, is_uuid};
use crate::controllers::{key_controller, secret_controller};
use crate::errors::{AppError, ErrorBody, error_json};
use crate::keys::{KeyProvider, SealState};
use crate::services::secret_service::SecretService;

#[derive(Clone)]
pub struct AppState {
    pub secrets: Arc<SecretService>,
    pub keys: Arc<dyn KeyProvider>,
    pub audit: AuditClient,
    pub db: PgPool,
    pub max_secret_bytes: usize,
    pub internal_service_token: Arc<str>,
    pub identity_service_token: Arc<str>,
    pub shutting_down: Arc<AtomicBool>,
    pub version: Arc<str>,
}

pub fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/secrets", get(secret_controller::list))
        .route(
            "/secrets/{name}",
            put(secret_controller::save)
                .get(secret_controller::describe)
                .delete(secret_controller::remove),
        )
        .route("/secrets/{name}/versions", get(secret_controller::versions))
        .route("/secrets/{name}/rotate", post(secret_controller::rotate))
        .route(
            "/internal/secrets/{name}",
            get(secret_controller::read_for_injection),
        )
        .route(
            "/internal/tenant",
            axum::routing::delete(secret_controller::shred_tenant),
        )
        .route(
            "/internal/file-keys/wrap",
            post(key_controller::wrap_file_key),
        )
        .route(
            "/internal/file-keys/unwrap",
            post(key_controller::unwrap_file_key),
        )
        .route(
            "/internal/signing-keys/wrap",
            post(key_controller::wrap_signing_key),
        )
        .route(
            "/internal/signing-keys/unwrap",
            post(key_controller::unwrap_signing_key),
        )
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            request_context,
        ))
        .with_state(state)
}

async fn not_found() -> AppError {
    AppError::not_found()
}

async fn health() -> Response {
    axum::Json(json!({ "status": "ok" })).into_response()
}

async fn ready(State(state): State<AppState>) -> Response {
    let postgres = match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => "up",
        Err(_) => "down",
    };
    let seal = state.keys.state();
    let reason = if postgres == "down" {
        Some("postgres_down")
    } else {
        match seal {
            SealState::Uninitialised => Some("not_initialised"),
            SealState::Sealed => Some("sealed"),
            SealState::Unsealed => None,
        }
    };
    let checks = json!({ "postgres": postgres, "seal": seal.as_str() });
    match reason {
        Some(reason) => (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "status": "not_ready", "reason": reason, "checks": checks })),
        )
            .into_response(),
        None => axum::Json(json!({ "status": "ready", "checks": checks })).into_response(),
    }
}

pub fn route_of(method: &Method, path: &str) -> Option<&'static str> {
    let segments: Vec<&str> = path.strip_prefix('/')?.split('/').collect();
    let named = |segment: &str| !segment.is_empty();
    match (method.as_str(), segments.as_slice()) {
        ("GET", ["health"]) => Some("/health"),
        ("GET", ["ready"]) => Some("/ready"),
        ("GET", ["secrets"]) => Some("/secrets"),
        ("PUT" | "GET" | "DELETE", ["secrets", name]) if named(name) => Some("/secrets/:name"),
        ("GET", ["secrets", name, "versions"]) if named(name) => Some("/secrets/:name/versions"),
        ("POST", ["secrets", name, "rotate"]) if named(name) => Some("/secrets/:name/rotate"),
        ("GET", ["internal", "secrets", name]) if named(name) => Some("/internal/secrets/:name"),
        ("DELETE", ["internal", "tenant"]) => Some("/internal/tenant"),
        ("POST", ["internal", "file-keys", "wrap"]) => Some("/internal/file-keys/wrap"),
        ("POST", ["internal", "file-keys", "unwrap"]) => Some("/internal/file-keys/unwrap"),
        ("POST", ["internal", "signing-keys", "wrap"]) => Some("/internal/signing-keys/wrap"),
        ("POST", ["internal", "signing-keys", "unwrap"]) => Some("/internal/signing-keys/unwrap"),
        _ => None,
    }
}

pub fn is_internal_address(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        other => other,
    };
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn token_matches(headers: &HeaderMap, expected: &str) -> bool {
    let given = header_text(headers, "authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    let given_digest = Sha256::digest(given.as_bytes());
    let expected_digest = Sha256::digest(expected.as_bytes());
    let same = given_digest
        .iter()
        .zip(expected_digest.iter())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0;
    same && !given.is_empty()
}

fn context_from(headers: &HeaderMap, request_id: &str) -> Result<RequestContext, AppError> {
    let tenant_id = header_text(headers, "x-tenant-id")
        .filter(|value| is_uuid(value))
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| AppError::bad_request("A valid X-Tenant-Id header is required"))?;
    let actor_id = header_text(headers, "x-actor-id")
        .filter(|value| is_uuid(value))
        .and_then(|value| Uuid::parse_str(value).ok());
    let actor_type = if header_text(headers, "x-actor-type") == Some("user") {
        "user"
    } else {
        "api_key"
    };
    let client_ip =
        header_text(headers, "x-client-ip").and_then(|value| value.parse::<IpAddr>().ok());
    Ok(RequestContext {
        request_id: request_id.to_string(),
        tenant_id,
        actor_id,
        actor_type,
        client_ip,
    })
}

fn sealed_refusal(state: SealState) -> AppError {
    let message = if state == SealState::Uninitialised {
        "The secrets service hasn't been initialised yet"
    } else {
        "The secrets service is sealed until an operator unseals it"
    };
    AppError {
        retry_after: Some(30),
        ..AppError::sealed(message)
    }
}

enum Gate {
    Probe,
    Refused(AppError, bool),
    Through { counted: bool },
}

fn check(
    state: &AppState,
    peer: IpAddr,
    request: &mut Request,
    request_id: &str,
    route: Option<&str>,
) -> Gate {
    if state.shutting_down.load(Ordering::SeqCst) {
        return Gate::Refused(AppError::shutting_down(), false);
    }
    if !is_internal_address(peer) {
        return Gate::Refused(
            AppError::forbidden("Only internal traffic is accepted"),
            false,
        );
    }
    let target = request
        .uri()
        .path_and_query()
        .map_or("", |value| value.as_str());
    if target == "/health" || target == "/ready" {
        return Gate::Probe;
    }
    let context = match context_from(request.headers(), request_id) {
        Ok(context) => context,
        Err(error) => return Gate::Refused(error, true),
    };
    request.extensions_mut().insert(context);
    let route = route.unwrap_or("");
    if route.starts_with("/internal/file-keys/")
        && !token_matches(request.headers(), &state.internal_service_token)
        || route.starts_with("/internal/signing-keys/")
            && !token_matches(request.headers(), &state.identity_service_token)
    {
        return Gate::Refused(AppError::forbidden("Not allowed"), true);
    }
    if !route.starts_with("/secrets") && !route.starts_with("/internal/") {
        return Gate::Through { counted: false };
    }
    if !state.keys.begin_request() {
        return Gate::Refused(sealed_refusal(state.keys.state()), true);
    }
    Gate::Through { counted: true }
}

async fn request_context(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut request: Request,
    next: Next,
) -> Response {
    let started = Instant::now();
    let method = request.method().clone();
    let route = route_of(&method, request.uri().path());
    let request_id = header_text(request.headers(), "x-request-id")
        .filter(|value| is_uuid(value))
        .map_or_else(|| Uuid::new_v4().to_string(), str::to_string);

    let (response, no_store) = match check(&state, peer.ip(), &mut request, &request_id, route) {
        Gate::Probe => (next.run(request).await, false),
        Gate::Refused(error, no_store) => (error.into_response(), no_store),
        Gate::Through { counted } => {
            let response = next.run(request).await;
            if counted {
                state.keys.end_request();
            }
            (response, true)
        }
    };

    let mut response = finish(response, &request_id);
    if no_store {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    tracing::info!(
        service = "secrets",
        version = &*state.version,
        requestId = request_id,
        method = %method,
        route = route.unwrap_or("unmatched"),
        status = response.status().as_u16(),
        durationMs = (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0,
        "request completed"
    );
    response
}

fn finish(response: Response, request_id: &str) -> Response {
    let Some(error) = response.extensions().get::<ErrorBody>().cloned() else {
        return response;
    };
    let (mut parts, _) = response.into_parts();
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    parts.headers.remove(header::CONTENT_LENGTH);
    let body = error_json(error.code, &error.message, request_id).to_string();
    Response::from_parts(parts, Body::from(body))
}
