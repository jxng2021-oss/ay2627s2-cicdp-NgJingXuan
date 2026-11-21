use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use crate::operator::cli::{CallFuture, Reply, Transport};
use crate::operator::wire::parse_response;

const TIMEOUT: Duration = Duration::from_secs(30);

pub struct SocketTransport {
    path: PathBuf,
}

impl SocketTransport {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    async fn exchange(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Reply, String> {
        let mut stream = UnixStream::connect(&self.path)
            .await
            .map_err(|error| error.to_string())?;
        let payload = body.map(|body| body.to_string()).unwrap_or_default();
        let mut request =
            format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
        if !payload.is_empty() {
            request.push_str("Content-Type: application/json\r\n");
        }
        request.push_str(&format!("Content-Length: {}\r\n\r\n", payload.len()));
        request.push_str(&payload);
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|error| error.to_string())?;

        let mut raw = Vec::new();
        stream
            .read_to_end(&mut raw)
            .await
            .map_err(|error| error.to_string())?;
        parse_response(&raw)
    }
}

impl Transport for SocketTransport {
    fn call<'a>(&'a self, method: &'a str, path: &'a str, body: Option<Value>) -> CallFuture<'a> {
        Box::pin(async move {
            tokio::time::timeout(TIMEOUT, self.exchange(method, path, body))
                .await
                .map_err(|_| "timed out".to_string())?
        })
    }

    fn describe(&self) -> String {
        self.path.display().to_string()
    }
}
