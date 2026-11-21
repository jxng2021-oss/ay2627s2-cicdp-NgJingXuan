use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub action: String,
    pub outcome: &'static str,
    pub actor_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ip: Option<String>,
}

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

pub trait AuditTransport: Send + Sync {
    fn send<'a>(&'a self, event: &'a AuditEvent) -> SendFuture<'a>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditUnavailable;

#[derive(Clone)]
pub struct AuditClient {
    transport: Arc<dyn AuditTransport>,
}

impl AuditClient {
    pub fn new(transport: Arc<dyn AuditTransport>) -> Self {
        Self { transport }
    }

    pub async fn record(&self, event: AuditEvent) -> Result<(), AuditUnavailable> {
        match self.transport.send(&event).await {
            Ok(()) => Ok(()),
            Err(error) => {
                tracing::error!(
                    error,
                    action = event.action,
                    "audit event could not be saved, so the action was refused"
                );
                Err(AuditUnavailable)
            }
        }
    }
}

pub struct HttpAuditTransport {
    http: reqwest::Client,
    url: String,
    token: String,
}

impl HttpAuditTransport {
    pub fn new(base_url: &str, token: String, timeout: Duration) -> Result<Self, reqwest::Error> {
        Ok(Self {
            http: reqwest::Client::builder().timeout(timeout).build()?,
            url: format!("{}/internal/events", base_url.trim_end_matches('/')),
            token,
        })
    }
}

impl AuditTransport for HttpAuditTransport {
    fn send<'a>(&'a self, event: &'a AuditEvent) -> SendFuture<'a> {
        Box::pin(async move {
            let mut request = self
                .http
                .post(&self.url)
                .bearer_auth(&self.token)
                .header("x-audit-service", "secrets")
                .json(event);
            if let Some(request_id) = &event.request_id {
                request = request.header("x-request-id", request_id);
            }
            let response = request.send().await.map_err(|error| error.to_string())?;
            if response.status().as_u16() == 201 {
                Ok(())
            } else {
                Err(format!(
                    "the audit service answered {}",
                    response.status().as_u16()
                ))
            }
        })
    }
}
