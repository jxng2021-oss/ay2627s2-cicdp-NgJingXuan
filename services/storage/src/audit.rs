use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
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

pub trait AuditTransport: Send + Sync {
    fn send<'a>(&'a self, event: &'a AuditEvent) -> BoxFuture<'a, Result<(), String>>;
}

#[derive(Clone)]
pub struct AuditClient {
    transport: Arc<dyn AuditTransport>,
    retry_delays: Vec<Duration>,
}

impl AuditClient {
    pub fn new(transport: Arc<dyn AuditTransport>, retry_delays: Vec<Duration>) -> Self {
        Self {
            transport,
            retry_delays,
        }
    }

    pub fn record_best_effort(&self, event: AuditEvent) -> tokio::task::JoinHandle<()> {
        let client = self.clone();
        tokio::spawn(async move { client.send_with_retries(event).await })
    }

    async fn send_with_retries(&self, event: AuditEvent) {
        let mut attempt = 0;
        loop {
            match self.transport.send(&event).await {
                Ok(()) => return,
                Err(error) => match self.retry_delays.get(attempt) {
                    Some(delay) => {
                        tokio::time::sleep(*delay).await;
                        attempt += 1;
                    }
                    None => {
                        tracing::warn!(
                            error,
                            action = event.action,
                            auditRequestId = event.request_id,
                            "AUDIT EVENT LOST: it could not be saved after retrying; the action itself went ahead"
                        );
                        return;
                    }
                },
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
    fn send<'a>(&'a self, event: &'a AuditEvent) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let mut request = self
                .http
                .post(&self.url)
                .bearer_auth(&self.token)
                .header("x-audit-service", "storage")
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
