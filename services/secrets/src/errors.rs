use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::services::secret_service::ServiceError;

#[derive(Debug, Clone)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retry_after: Option<u64>,
    pub close_connection: bool,
}

#[derive(Debug, Clone)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retry_after: None,
            close_connection: false,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "FORBIDDEN", message)
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found")
    }

    pub fn secret_not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Secret not found")
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", message)
    }

    pub fn unsupported_media_type() -> Self {
        Self::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_MEDIA_TYPE",
            "Send the request body as application/json",
        )
    }

    pub fn sealed(message: &str) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "SECRETS_SEALED", message)
    }

    pub fn shutting_down() -> Self {
        Self {
            close_connection: true,
            ..Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_UNAVAILABLE",
                "The server is shutting down",
            )
        }
    }

    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Something went wrong",
        )
    }
}

impl From<ServiceError> for AppError {
    fn from(error: ServiceError) -> Self {
        match error {
            ServiceError::Sealed => {
                Self::sealed("The secrets service is sealed until an operator unseals it")
            }
            ServiceError::AuditUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_UNAVAILABLE",
                "The audit log is unavailable, so this action was refused. Try again later.",
            ),
            ServiceError::TenantShredded => Self::not_found(),
            ServiceError::Decryption(reason) => {
                tracing::error!(reason = reason.0, "decryption failed");
                Self::internal()
            }
            ServiceError::Database(error) => {
                tracing::error!(error = %error, "request failed");
                Self::internal()
            }
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut response = self.status.into_response();
        if let Some(seconds) = self.retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
        }
        if self.close_connection {
            response
                .headers_mut()
                .insert(header::CONNECTION, HeaderValue::from_static("close"));
        }
        response.extensions_mut().insert(ErrorBody {
            code: self.code,
            message: self.message,
        });
        response
    }
}

pub fn error_json(code: &str, message: &str, request_id: &str) -> serde_json::Value {
    json!({ "error": { "code": code, "message": message, "requestId": request_id } })
}
