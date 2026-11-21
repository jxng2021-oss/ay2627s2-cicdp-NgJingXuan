use std::collections::HashMap;

use axum::body::Body;
use axum::extract::{FromRequestParts, Path};
use axum::http::request::Parts;
use axum::http::{HeaderMap, header};
use percent_encoding::percent_decode_str;
use serde_json::{Map, Value};

use crate::context::{is_base64_of_length, is_secret_name, is_uuid};
use crate::errors::AppError;

pub const SECRET_NAME_PATTERN: &str = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$";
const VERSION_CURSOR_PATTERN: &str = "^[1-9][0-9]{0,9}$";
const UUID_PATTERN: &str = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const MAX_VERSION: i64 = 2_147_483_647;

fn is_json(headers: &HeaderMap) -> Option<bool> {
    let value = headers.get(header::CONTENT_TYPE)?.to_str().unwrap_or("");
    let media = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Some(media == "application/json")
}

pub async fn read_json(
    headers: &HeaderMap,
    body: Body,
    limit: usize,
) -> Result<Map<String, Value>, AppError> {
    let bytes = axum::body::to_bytes(body, limit)
        .await
        .map_err(|_| AppError::too_large("Request body is too large"))?;
    match is_json(headers) {
        Some(false) => return Err(AppError::unsupported_media_type()),
        Some(true) if bytes.is_empty() => {
            return Err(AppError::bad_request(
                "Body cannot be empty when content-type is set to 'application/json'",
            ));
        }
        None if bytes.is_empty() => return Err(AppError::bad_request("body must be object")),
        None => return Err(AppError::unsupported_media_type()),
        Some(true) => {}
    }
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| {
        AppError::bad_request(
            "Body is not valid JSON but content-type is set to 'application/json'",
        )
    })?;
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err(AppError::bad_request("body must be object")),
    }
}

fn only_fields(body: &Map<String, Value>, allowed: &[&str]) -> Result<(), AppError> {
    for field in allowed {
        if !body.contains_key(*field) {
            return Err(AppError::bad_request(format!(
                "body must have required property '{field}'"
            )));
        }
    }
    if body.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(AppError::bad_request(
            "body must NOT have additional properties",
        ));
    }
    Ok(())
}

fn string_field<'a>(body: &'a Map<String, Value>, field: &str) -> Result<&'a str, AppError> {
    body[field]
        .as_str()
        .ok_or_else(|| AppError::bad_request(format!("body/{field} must be string")))
}

pub fn value_body(body: &Map<String, Value>) -> Result<String, AppError> {
    only_fields(body, &["value"])?;
    Ok(string_field(body, "value")?.to_string())
}

pub struct KeyBody {
    pub id: String,
    pub key: String,
}

pub fn key_body(
    body: &Map<String, Value>,
    id_field: &str,
    key_field: &str,
    key_characters: usize,
) -> Result<KeyBody, AppError> {
    only_fields(body, &[id_field, key_field])?;
    let id = string_field(body, id_field)?;
    if !is_uuid(id) {
        return Err(AppError::bad_request(format!(
            "body/{id_field} must match pattern \"{UUID_PATTERN}\""
        )));
    }
    let key = string_field(body, key_field)?;
    if !is_base64_of_length(key, key_characters) {
        return Err(AppError::bad_request(format!(
            "body/{key_field} must match pattern \"^[A-Za-z0-9+/]{{{key_characters}}}=$\""
        )));
    }
    Ok(KeyBody {
        id: id.to_string(),
        key: key.to_string(),
    })
}

pub struct SecretName(pub String);

impl<S: Send + Sync> FromRequestParts<S> for SecretName {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let Path(name) = Path::<String>::from_request_parts(parts, state)
            .await
            .map_err(|_| AppError::bad_request("params/name must be a valid string"))?;
        if !is_secret_name(&name) {
            return Err(AppError::bad_request(format!(
                "params/name must match pattern \"{SECRET_NAME_PATTERN}\""
            )));
        }
        Ok(Self(name))
    }
}

pub struct Query(HashMap<String, Vec<String>>);

impl Query {
    pub fn parse(raw: Option<&str>) -> Self {
        let mut values: HashMap<String, Vec<String>> = HashMap::new();
        for pair in raw.unwrap_or("").split('&').filter(|pair| !pair.is_empty()) {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let decode = |text: &str| {
                percent_decode_str(&text.replace('+', " "))
                    .decode_utf8_lossy()
                    .into_owned()
            };
            values.entry(decode(key)).or_default().push(decode(value));
        }
        Self(values)
    }

    fn one(&self, name: &str) -> Result<Option<&str>, AppError> {
        match self.0.get(name).map(Vec::as_slice) {
            None => Ok(None),
            Some([value]) => Ok(Some(value.as_str())),
            Some(_) => Err(AppError::bad_request(format!(
                "querystring/{name} must be string"
            ))),
        }
    }

    fn integer(&self, name: &str, minimum: i64, maximum: i64) -> Result<Option<i64>, AppError> {
        let Some(raw) = self.one(name)? else {
            return Ok(None);
        };
        let number = raw
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && value.fract() == 0.0)
            .ok_or_else(|| AppError::bad_request(format!("querystring/{name} must be integer")))?;
        if number < minimum as f64 {
            return Err(AppError::bad_request(format!(
                "querystring/{name} must be >= {minimum}"
            )));
        }
        if number > maximum as f64 {
            return Err(AppError::bad_request(format!(
                "querystring/{name} must be <= {maximum}"
            )));
        }
        Ok(Some(number as i64))
    }

    pub fn limit(&self) -> Result<i64, AppError> {
        Ok(self.integer("limit", 1, 100)?.unwrap_or(20))
    }

    pub fn version(&self) -> Result<Option<i32>, AppError> {
        Ok(self
            .integer("version", 1, MAX_VERSION)?
            .map(|version| i32::try_from(version).unwrap_or(i32::MAX)))
    }

    pub fn name_cursor(&self) -> Result<Option<String>, AppError> {
        match self.one("cursor")? {
            None => Ok(None),
            Some(cursor) if is_secret_name(cursor) => Ok(Some(cursor.to_string())),
            Some(_) => Err(AppError::bad_request(format!(
                "querystring/cursor must match pattern \"{SECRET_NAME_PATTERN}\""
            ))),
        }
    }

    pub fn version_cursor(&self) -> Result<Option<i64>, AppError> {
        match self.one("cursor")? {
            None => Ok(None),
            Some(cursor)
                if !cursor.is_empty()
                    && cursor.len() <= 10
                    && !cursor.starts_with('0')
                    && cursor.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                Ok(cursor.parse::<i64>().ok())
            }
            Some(_) => Err(AppError::bad_request(format!(
                "querystring/cursor must match pattern \"{VERSION_CURSOR_PATTERN}\""
            ))),
        }
    }
}
