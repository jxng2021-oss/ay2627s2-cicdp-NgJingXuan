use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, MatchedPath, Request, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::audit::AuditClient;
use crate::context::{RequestContext, is_uuid};
use crate::errors::{AppError, ErrorBody, error_json};
use crate::routes::file_routes::file_routes;
use crate::services::file_service::FileService;

#[derive(Clone)]
pub struct AppState {
    pub files: Arc<FileService>,
    pub audit: AuditClient,
    pub shutting_down: Arc<AtomicBool>,
    pub version: Arc<str>,
}

#[derive(Clone)]
struct RouteName(String);

pub fn build_app(state: AppState) -> Router {
    file_routes()
        .route_layer(middleware::from_fn(remember_route))
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

async fn remember_route(request: Request, next: Next) -> Response {
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| path.as_str().to_string());
    let mut response = next.run(request).await;
    if let Some(route) = route {
        response.extensions_mut().insert(RouteName(route));
    }
    response
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

async fn request_context(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut request: Request,
    next: Next,
) -> Response {
    let started = Instant::now();
    let method = request.method().clone();
    let request_id = header_text(request.headers(), "x-request-id")
        .filter(|value| is_uuid(value))
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let refused = if state.shutting_down.load(Ordering::SeqCst) {
        Some(AppError::shutting_down())
    } else if !is_internal_address(peer.ip()) {
        Some(AppError::forbidden("Only internal traffic is accepted"))
    } else if request.uri().path() == "/health" {
        None
    } else {
        match context_from(request.headers(), &request_id) {
            Ok(context) => {
                request.extensions_mut().insert(context);
                None
            }
            Err(error) => Some(error),
        }
    };

    let response = match refused {
        Some(error) => error.into_response(),
        None => next.run(request).await,
    };
    let mut response = finish(response, &request_id);

    let route = response
        .extensions()
        .get::<RouteName>()
        .map(|route| route.0.clone())
        .unwrap_or_else(|| "unmatched".to_string());
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    tracing::info!(
        service = "storage",
        version = &*state.version,
        requestId = request_id,
        method = %method,
        route,
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
