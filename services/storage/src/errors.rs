use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

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

    pub fn file_not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", "File not found")
    }

    pub fn upload_too_large() -> Self {
        Self {
            close_connection: true,
            ..Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "PAYLOAD_TOO_LARGE",
                "The upload is larger than the allowed maximum",
            )
        }
    }

    pub fn quota_exceeded() -> Self {
        Self {
            close_connection: true,
            ..Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "STORAGE_QUOTA_EXCEEDED",
                "This upload would go over the tenant's storage limit",
            )
        }
    }

    pub fn secrets_sealed() -> Self {
        Self {
            retry_after: Some(30),
            ..Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SECRETS_SEALED",
                "The secrets service is sealed, so files can't be encrypted or decrypted",
            )
        }
    }

    pub fn keys_unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            "Encryption keys are temporarily unavailable, try again",
        )
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

    pub fn is_not_found(&self) -> bool {
        self.status == StatusCode::NOT_FOUND
    }
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(error = %error, "database error");
        Self::internal()
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        tracing::error!(error = %error, "file system error");
        Self::internal()
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
