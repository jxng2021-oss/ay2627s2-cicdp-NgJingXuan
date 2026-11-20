use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKeyError {
    Sealed,
    Rejected,
    Unavailable,
}

pub trait FileKeyService: Send + Sync {
    fn wrap<'a>(
        &'a self,
        tenant_id: Uuid,
        file_id: Uuid,
        key: &'a [u8],
        request_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, FileKeyError>>;

    fn unwrap<'a>(
        &'a self,
        tenant_id: Uuid,
        file_id: Uuid,
        wrapped: &'a [u8],
        request_id: &'a str,
    ) -> BoxFuture<'a, Result<Zeroizing<Vec<u8>>, FileKeyError>>;
}

pub struct HttpFileKeyService {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyAnswer {
    wrapped_key: Option<String>,
    key: Option<String>,
    error: Option<ErrorAnswer>,
}

#[derive(Deserialize)]
struct ErrorAnswer {
    code: Option<String>,
}

impl HttpFileKeyService {
    pub fn new(
        secrets_url: &str,
        token: String,
        timeout: Duration,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            http: reqwest::Client::builder().timeout(timeout).build()?,
            base_url: secrets_url.trim_end_matches('/').to_string(),
            token,
        })
    }

    async fn call(
        &self,
        action: &str,
        tenant_id: Uuid,
        request_id: &str,
        payload: serde_json::Value,
    ) -> Result<KeyAnswer, FileKeyError> {
        let response = self
            .http
            .post(format!("{}/internal/file-keys/{action}", self.base_url))
            .bearer_auth(&self.token)
            .header("x-tenant-id", tenant_id.to_string())
            .header("x-request-id", request_id)
            .json(&payload)
            .send()
            .await
            .map_err(|_| FileKeyError::Unavailable)?;
        let status = response.status().as_u16();
        let answer: KeyAnswer = response.json().await.unwrap_or(KeyAnswer {
            wrapped_key: None,
            key: None,
            error: None,
        });
        match status {
            200 => Ok(answer),
            503 if answer
                .error
                .as_ref()
                .and_then(|error| error.code.as_deref())
                == Some("SECRETS_SEALED") =>
            {
                Err(FileKeyError::Sealed)
            }
            500 if action == "unwrap" => Err(FileKeyError::Rejected),
            _ => Err(FileKeyError::Unavailable),
        }
    }
}

impl FileKeyService for HttpFileKeyService {
    fn wrap<'a>(
        &'a self,
        tenant_id: Uuid,
        file_id: Uuid,
        key: &'a [u8],
        request_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, FileKeyError>> {
        Box::pin(async move {
            let encoded = Zeroizing::new(STANDARD.encode(key));
            let answer = self
                .call(
                    "wrap",
                    tenant_id,
                    request_id,
                    json!({ "fileId": file_id, "key": encoded.as_str() }),
                )
                .await?;
            let wrapped = answer.wrapped_key.ok_or(FileKeyError::Unavailable)?;
            STANDARD
                .decode(wrapped)
                .map_err(|_| FileKeyError::Unavailable)
        })
    }

    fn unwrap<'a>(
        &'a self,
        tenant_id: Uuid,
        file_id: Uuid,
        wrapped: &'a [u8],
        request_id: &'a str,
    ) -> BoxFuture<'a, Result<Zeroizing<Vec<u8>>, FileKeyError>> {
        Box::pin(async move {
            let answer = self
                .call(
                    "unwrap",
                    tenant_id,
                    request_id,
                    json!({ "fileId": file_id, "wrappedKey": STANDARD.encode(wrapped) }),
                )
                .await?;
            let key = Zeroizing::new(answer.key.ok_or(FileKeyError::Unavailable)?);
            STANDARD
                .decode(key.as_bytes())
                .map(Zeroizing::new)
                .map_err(|_| FileKeyError::Unavailable)
        })
    }
}
