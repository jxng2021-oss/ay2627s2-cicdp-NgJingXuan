use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};

use crate::seal::seal_manager::{SealError, SealManager, SealReason};

pub const OPERATOR_BODY_LIMIT: usize = 4096;

struct OperatorError {
    status: StatusCode,
    code: &'static str,
    message: String,
    retry_after: Option<u64>,
}

impl OperatorError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retry_after: None,
        }
    }

    fn bad_request() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", "Invalid request")
    }
}

impl From<SealError> for OperatorError {
    fn from(error: SealError) -> Self {
        match error {
            SealError::AlreadyInitialised => Self::new(
                StatusCode::CONFLICT,
                "ALREADY_INITIALISED",
                "The secrets service is already initialised (or being initialised)",
            ),
            SealError::LeftoverData => Self::new(
                StatusCode::CONFLICT,
                "LEFTOVER_DATA",
                "The secrets database still has keys or secrets from an earlier setup, which can't be decrypted by new keys. Locally, reset it with `pnpm local:reset` (deletes all local data).",
            ),
            SealError::NotInitialised => {
                Self::new(StatusCode::CONFLICT, "NOT_INITIALISED", error.to_string())
            }
            SealError::InvalidShare => {
                Self::new(StatusCode::BAD_REQUEST, "INVALID_SHARE", error.to_string())
            }
            SealError::UnsealFailed => {
                Self::new(StatusCode::BAD_REQUEST, "UNSEAL_FAILED", error.to_string())
            }
            SealError::AuditUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "AUDIT_UNAVAILABLE",
                "The audit log is unavailable, so nothing was changed. Check the audit service (docs/runbook.md); to seal in an emergency, stop the secrets container.",
            ),
            SealError::TooManyAttempts {
                retry_after_seconds,
            } => Self {
                retry_after: Some(retry_after_seconds),
                ..Self::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "TOO_MANY_ATTEMPTS",
                    error.to_string(),
                )
            },
            SealError::Internal(_) | SealError::Database(_) => {
                tracing::error!(error = %error, "operator command failed");
                Self::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "Something went wrong",
                )
            }
        }
    }
}

impl IntoResponse for OperatorError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            axum::Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response();
        if let Some(seconds) = self.retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
        }
        response
    }
}

pub fn operator_router(seal: Arc<SealManager>) -> Router {
    Router::new()
        .route("/status", get(status))
        .route("/init", post(init))
        .route("/unseal", post(unseal))
        .route("/seal", post(seal_now))
        .fallback(unknown_command)
        .method_not_allowed_fallback(unknown_command)
        .layer(DefaultBodyLimit::max(OPERATOR_BODY_LIMIT))
        .with_state(seal)
}

async fn unknown_command() -> OperatorError {
    OperatorError::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        "Unknown operator command",
    )
}

async fn status(State(seal): State<Arc<SealManager>>) -> Response {
    axum::Json(seal.status()).into_response()
}

async fn init(State(seal): State<Arc<SealManager>>) -> Result<Response, OperatorError> {
    let initialised = seal.initialise().await?;
    let shares: Vec<&str> = initialised
        .shares
        .iter()
        .map(|share| share.as_str())
        .collect();
    let body = json!({
        "shares": shares,
        "threshold": initialised.threshold,
        "shareCount": shares.len(),
    });
    Ok((StatusCode::CREATED, axum::Json(body)).into_response())
}

async fn unseal(
    State(seal): State<Arc<SealManager>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, OperatorError> {
    let body = body.map_err(|_| OperatorError::bad_request())?;
    let parsed: Value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).map_err(|_| OperatorError::bad_request())?
    };
    let Some(share) = parsed.get("share").and_then(Value::as_str) else {
        return Err(SealError::InvalidShare.into());
    };
    let result = seal.submit_share(share).await?;
    Ok(axum::Json(result).into_response())
}

async fn seal_now(State(seal): State<Arc<SealManager>>) -> Result<Response, OperatorError> {
    seal.seal(SealReason::Operator).await?;
    Ok(axum::Json(seal.status()).into_response())
}
