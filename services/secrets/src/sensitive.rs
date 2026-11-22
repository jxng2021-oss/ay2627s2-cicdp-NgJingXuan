use axum::body::Body;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::errors::AppError;

const JSON_OVERHEAD: usize = 256;

pub fn capacity_for(sensitive_bytes: usize) -> usize {
    sensitive_bytes * 6 + JSON_OVERHEAD
}

pub fn sensitive_json<T: Serialize>(body: &T, capacity: usize) -> Response {
    let mut buffer = Zeroizing::new(Vec::with_capacity(capacity));
    if serde_json::to_writer(&mut *buffer, body).is_err() || buffer.len() > capacity {
        return AppError::internal().into_response();
    }
    let mut response = Response::new(Body::from(Bytes::from_owner(buffer)));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}
