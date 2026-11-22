use axum::Extension;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::app::AppState;
use crate::audit::AuditEvent;
use crate::context::RequestContext;
use crate::errors::AppError;
use crate::input::{Query, SecretName, read_json, value_body};
use crate::sensitive::{capacity_for, sensitive_json};
use crate::services::secret_service::{SavedVersion, ServiceError};
use crate::time::iso;

#[derive(serde::Serialize)]
struct InjectionAnswer<'a> {
    name: &'a str,
    version: i32,
    value: &'a str,
}

fn metadata(saved: &SavedVersion) -> serde_json::Value {
    json!({ "name": saved.name, "version": saved.version, "createdAt": iso(&saved.created_at) })
}

pub fn event(context: &RequestContext, action: &str, name: &str) -> AuditEvent {
    AuditEvent {
        action: action.to_string(),
        outcome: "success",
        actor_type: if context.actor_id.is_some() {
            context.actor_type
        } else {
            "service"
        },
        tenant_id: Some(context.tenant_id.to_string()),
        actor_id: context.actor_id.map(|id| id.to_string()),
        resource_id: Some(name.to_string()),
        request_id: Some(context.request_id.clone()),
        source_ip: context.client_ip.map(|ip| ip.to_string()),
    }
}

async fn record(
    state: &AppState,
    context: &RequestContext,
    action: &str,
    name: &str,
) -> Result<(), ServiceError> {
    state
        .audit
        .record(event(context, action, name))
        .await
        .map_err(|_| ServiceError::AuditUnavailable)
}

async fn value_from(state: &AppState, request: Request) -> Result<String, AppError> {
    let limit = state.max_secret_bytes * 6 + 1024;
    let (parts, body): (_, Body) = request.into_parts();
    let value = value_body(&read_json(&parts.headers, body, limit).await?)?;
    if value.len() > state.max_secret_bytes {
        return Err(AppError::too_large(
            "The secret value is larger than the allowed maximum",
        ));
    }
    Ok(value)
}

pub async fn list(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    uri: Uri,
) -> Result<Response, AppError> {
    let query = Query::parse(uri.query());
    let limit = query.limit()?;
    let cursor = query.name_cursor()?;
    let page = state
        .secrets
        .list(context.tenant_id, limit, cursor.as_deref())
        .await?;
    let secrets: Vec<_> = page
        .items
        .iter()
        .map(|secret| {
            json!({
                "name": secret.name,
                "latestVersion": secret.latest_version,
                "createdAt": iso(&secret.created_at),
                "updatedAt": iso(&secret.updated_at),
            })
        })
        .collect();
    Ok(axum::Json(json!({ "secrets": secrets, "nextCursor": page.next_cursor })).into_response())
}

pub async fn save(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    SecretName(name): SecretName,
    request: Request,
) -> Result<Response, AppError> {
    let value = zeroize::Zeroizing::new(value_from(&state, request).await?);
    let saved = state
        .secrets
        .save(context.tenant_id, &name, &value, |saved| {
            let action = if saved.version == 1 {
                "secret.created"
            } else {
                "secret.rotated"
            };
            let state = state.clone();
            let context = context.clone();
            async move { record(&state, &context, action, &saved.name).await }
        })
        .await?;
    let status = if saved.version == 1 {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, axum::Json(metadata(&saved))).into_response())
}

pub async fn rotate(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    SecretName(name): SecretName,
    request: Request,
) -> Result<Response, AppError> {
    let value = zeroize::Zeroizing::new(value_from(&state, request).await?);
    let saved = state
        .secrets
        .rotate(context.tenant_id, &name, &value, |saved| {
            let state = state.clone();
            let context = context.clone();
            async move { record(&state, &context, "secret.rotated", &saved.name).await }
        })
        .await?
        .ok_or_else(AppError::secret_not_found)?;
    Ok(axum::Json(metadata(&saved)).into_response())
}

pub async fn describe(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    SecretName(name): SecretName,
    uri: Uri,
) -> Result<Response, AppError> {
    let version = Query::parse(uri.query()).version()?;
    let found = state
        .secrets
        .describe(context.tenant_id, &name, version)
        .await?
        .ok_or_else(AppError::secret_not_found)?;
    Ok(axum::Json(metadata(&found)).into_response())
}

pub async fn versions(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    SecretName(name): SecretName,
    uri: Uri,
) -> Result<Response, AppError> {
    let query = Query::parse(uri.query());
    let limit = query.limit()?;
    let cursor = query.version_cursor()?;
    let page = state
        .secrets
        .versions(context.tenant_id, &name, limit, cursor)
        .await?
        .ok_or_else(AppError::secret_not_found)?;
    let versions: Vec<_> = page
        .items
        .iter()
        .map(|version| json!({ "version": version.version, "createdAt": iso(&version.created_at) }))
        .collect();
    Ok(
        axum::Json(json!({ "name": name, "versions": versions, "nextCursor": page.next_cursor }))
            .into_response(),
    )
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    SecretName(name): SecretName,
) -> Result<Response, AppError> {
    let deleted = state
        .secrets
        .delete(context.tenant_id, &name, || {
            let state = state.clone();
            let context = context.clone();
            let name = name.clone();
            async move { record(&state, &context, "secret.deleted", &name).await }
        })
        .await?;
    if !deleted {
        return Err(AppError::secret_not_found());
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn read_for_injection(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    SecretName(name): SecretName,
) -> Result<Response, AppError> {
    let found = state
        .secrets
        .read(context.tenant_id, &name, None)
        .await?
        .ok_or_else(AppError::secret_not_found)?;
    record(&state, &context, "secret.read", &found.name).await?;
    let body = InjectionAnswer {
        name: &found.name,
        version: found.version,
        value: found.value.as_str(),
    };
    Ok(sensitive_json(
        &body,
        capacity_for(found.value.len() + found.name.len()),
    ))
}

pub async fn shred_tenant(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
) -> Result<Response, AppError> {
    state.secrets.shred(context.tenant_id).await?;
    tracing::info!(
        requestId = context.request_id,
        "tenant crypto-shredded: its key was destroyed"
    );
    Ok(StatusCode::NO_CONTENT.into_response())
}
