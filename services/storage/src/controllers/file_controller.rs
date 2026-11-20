use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::app::AppState;
use crate::audit::AuditEvent;
use crate::context::RequestContext;
use crate::errors::AppError;
use crate::models::file_model::FileRow;
use crate::services::file_service::{Upload, iso_millis, parse_cursor};

const DISPOSITION_SAFE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~');

#[derive(Deserialize)]
pub struct ListQuery {
    limit: Option<String>,
    cursor: Option<String>,
}

fn describe(file: &FileRow) -> Value {
    json!({
        "id": file.id,
        "name": file.original_name,
        "contentType": file.content_type,
        "size": file.plain_size,
        "createdAt": iso_millis(&file.created_at),
    })
}

fn parse_file_name(headers: &HeaderMap) -> Result<Option<String>, AppError> {
    let invalid = || {
        AppError::bad_request(
            "X-File-Name must be 1-255 characters, without control characters or slashes",
        )
    };
    let mut values = headers.get_all("x-file-name").iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(invalid());
    }
    let raw = value.to_str().map_err(|_| invalid())?;
    let name = percent_decode_str(raw)
        .decode_utf8()
        .map_err(|_| invalid())?
        .into_owned();
    let length = name.encode_utf16().count();
    let unsafe_char = name
        .chars()
        .any(|c| c.is_ascii_control() || c == '/' || c == '\\');
    if !(1..=255).contains(&length) || unsafe_char {
        return Err(invalid());
    }
    Ok(Some(name))
}

fn parse_content_type(headers: &HeaderMap) -> String {
    let value = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let part_ok = |part: &str| {
        let bytes = part.as_bytes();
        (1..=64).contains(&bytes.len())
            && bytes[0].is_ascii_alphanumeric()
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(b))
    };
    match value.split_once('/') {
        Some((kind, sub)) if part_ok(kind) && part_ok(sub) => value,
        _ => "application/octet-stream".to_string(),
    }
}

fn content_disposition(file: &FileRow) -> String {
    let id = file.id.to_string();
    let name = file.original_name.as_deref().unwrap_or(&id);
    let mut ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    if ascii.is_empty() {
        ascii = "file".to_string();
    }
    let encoded = utf8_percent_encode(name, DISPOSITION_SAFE).to_string();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

fn audit_event(
    ctx: &RequestContext,
    action: &str,
    file_id: &str,
    outcome: &'static str,
) -> AuditEvent {
    AuditEvent {
        action: action.to_string(),
        outcome,
        actor_type: if ctx.actor_id.is_some() {
            ctx.actor_type
        } else {
            "service"
        },
        tenant_id: Some(ctx.tenant_id.to_string()),
        actor_id: ctx.actor_id.map(|id| id.to_string()),
        resource_id: Some(file_id.to_string()),
        request_id: Some(ctx.request_id.clone()),
        source_ip: ctx.client_ip.map(|ip| ip.to_string()),
    }
}

async fn record_if_denied(state: &AppState, ctx: &RequestContext, id: &str, error: &AppError) {
    if error.is_not_found() && state.files.is_another_tenants_file(ctx.tenant_id, id).await {
        state
            .audit
            .record_best_effort(audit_event(ctx, "file.access_denied", id, "denied"));
    }
}

pub async fn upload(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, AppError> {
    let mut stream = body.into_data_stream();
    let upload = match parse_file_name(&headers) {
        Ok(name) => Upload {
            name,
            content_type: parse_content_type(&headers),
            declared_bytes: headers
                .get(header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok()),
        },
        Err(error) => return Err(error),
    };
    match state
        .files
        .upload(ctx.tenant_id, upload, &mut stream, &ctx.request_id)
        .await
    {
        Ok(file) => {
            state.audit.record_best_effort(audit_event(
                &ctx,
                "file.uploaded",
                &file.id.to_string(),
                "success",
            ));
            Ok((StatusCode::CREATED, Json(describe(&file))).into_response())
        }
        Err(error) => {
            if error.status == StatusCode::PAYLOAD_TOO_LARGE {
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(5), async {
                        while stream.next().await.is_some() {}
                    })
                    .await;
                });
            }
            Err(error)
        }
    }
}

pub async fn download(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    let (file, stream) = match state
        .files
        .download(ctx.tenant_id, &id, &ctx.request_id)
        .await
    {
        Ok(found) => found,
        Err(error) => {
            record_if_denied(&state, &ctx, &id, &error).await;
            return Err(error);
        }
    };
    state.audit.record_best_effort(audit_event(
        &ctx,
        "file.downloaded",
        &file.id.to_string(),
        "success",
    ));
    let mut response = Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(file.plain_size));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(&file)).map_err(|_| AppError::internal())?,
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

pub async fn metadata(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    match state.files.metadata(ctx.tenant_id, &id).await {
        Ok(file) => Ok(Json(describe(&file))),
        Err(error) => {
            record_if_denied(&state, &ctx, &id, &error).await;
            Err(error)
        }
    }
}

pub async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = match query.limit {
        None => 20,
        Some(text) => text
            .parse::<i64>()
            .ok()
            .filter(|value| (1..=100).contains(value))
            .ok_or_else(|| AppError::bad_request("limit must be a whole number from 1 to 100"))?,
    };
    let after = match query.cursor {
        None => None,
        Some(text) => {
            Some(parse_cursor(&text).ok_or_else(|| AppError::bad_request("Invalid cursor"))?)
        }
    };
    let page = state
        .files
        .list(ctx.tenant_id, limit, after.as_ref())
        .await?;
    Ok(Json(json!({
        "files": page.files.iter().map(describe).collect::<Vec<_>>(),
        "nextCursor": page.next_cursor,
    })))
}

pub async fn usage(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<Json<Value>, AppError> {
    let (usage, limit) = state.files.usage(ctx.tenant_id).await?;
    Ok(Json(json!({
        "usedBytes": usage.used_bytes,
        "reservedBytes": usage.reserved_bytes,
        "limitBytes": limit,
    })))
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    match state.files.remove(ctx.tenant_id, &id).await {
        Ok(file) => {
            state.audit.record_best_effort(audit_event(
                &ctx,
                "file.deleted",
                &file.id.to_string(),
                "success",
            ));
            Ok(StatusCode::NO_CONTENT)
        }
        Err(error) => {
            record_if_denied(&state, &ctx, &id, &error).await;
            Err(error)
        }
    }
}

pub async fn remove_tenant(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<StatusCode, AppError> {
    let count = state.files.remove_tenant(ctx.tenant_id).await?;
    tracing::info!(
        requestId = ctx.request_id,
        files = count,
        "tenant deleted: file keys destroyed, data removed"
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}
