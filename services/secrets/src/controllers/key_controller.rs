use axum::Extension;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;
use zeroize::Zeroizing;

use crate::app::AppState;
use crate::context::RequestContext;
use crate::errors::AppError;
use crate::input::{KeyBody, key_body, read_json};
use crate::keys::{Key, key_from_slice};

const PLAIN_KEY_CHARACTERS: usize = 43;
const WRAPPED_KEY_CHARACTERS: usize = 87;

async fn body_of(
    state: &AppState,
    request: Request,
    id_field: &str,
    key_field: &str,
    characters: usize,
) -> Result<KeyBody, AppError> {
    let (parts, body): (_, Body) = request.into_parts();
    let limit = state.max_secret_bytes * 6 + 1024;
    key_body(
        &read_json(&parts.headers, body, limit).await?,
        id_field,
        key_field,
        characters,
    )
}

fn plain_key(text: &str) -> Result<Key, AppError> {
    let bytes = Zeroizing::new(
        STANDARD
            .decode(text)
            .map_err(|_| AppError::bad_request("body/key must be base64"))?,
    );
    key_from_slice(&bytes).ok_or_else(|| AppError::bad_request("body/key must be 32 bytes"))
}

fn wrapped_key(text: &str) -> Result<Vec<u8>, AppError> {
    STANDARD
        .decode(text)
        .map_err(|_| AppError::bad_request("body/wrappedKey must be base64"))
}

fn key_answer(key: &Key) -> Response {
    let body = Zeroizing::new(json!({ "key": STANDARD.encode(key.as_ref()) }).to_string());
    (
        [("content-type", "application/json; charset=utf-8")],
        body.to_string(),
    )
        .into_response()
}

pub async fn wrap_file_key(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> Result<Response, AppError> {
    let body = body_of(&state, request, "fileId", "key", PLAIN_KEY_CHARACTERS).await?;
    let key = plain_key(&body.key)?;
    let wrapped = state
        .secrets
        .wrap_file_key(context.tenant_id, &body.id, &key)
        .await?;
    Ok(axum::Json(json!({ "wrappedKey": STANDARD.encode(wrapped) })).into_response())
}

pub async fn unwrap_file_key(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> Result<Response, AppError> {
    let body = body_of(
        &state,
        request,
        "fileId",
        "wrappedKey",
        WRAPPED_KEY_CHARACTERS,
    )
    .await?;
    let key = state
        .secrets
        .unwrap_file_key(context.tenant_id, &body.id, &wrapped_key(&body.key)?)
        .await?;
    Ok(key_answer(&key))
}

pub async fn wrap_signing_key(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> Result<Response, AppError> {
    let body = body_of(&state, request, "poolId", "key", PLAIN_KEY_CHARACTERS).await?;
    let key = plain_key(&body.key)?;
    let wrapped = state
        .secrets
        .wrap_signing_key(context.tenant_id, &body.id, &key)
        .await?;
    Ok(axum::Json(json!({ "wrappedKey": STANDARD.encode(wrapped) })).into_response())
}

pub async fn unwrap_signing_key(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> Result<Response, AppError> {
    let body = body_of(
        &state,
        request,
        "poolId",
        "wrappedKey",
        WRAPPED_KEY_CHARACTERS,
    )
    .await?;
    let key = state
        .secrets
        .unwrap_signing_key(context.tenant_id, &body.id, &wrapped_key(&body.key)?)
        .await?;
    Ok(key_answer(&key))
}
