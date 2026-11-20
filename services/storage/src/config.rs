use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub database_url: String,
    pub secrets_url: String,
    pub internal_service_token: String,
    pub max_upload_bytes: u64,
    pub quota_bytes: u64,
    pub secrets_timeout: Duration,
    pub audit_url: String,
    pub audit_token: String,
    pub audit_timeout: Duration,
    pub version: String,
    pub request_timeout: Duration,
    pub shutdown_timeout: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    pub fn from_vars(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let text = |name: &str, fallback: &str| {
            get(name)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| fallback.to_string())
        };
        let required = |name: &str| {
            get(name)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{name} must be set"))
        };
        let number = |name: &str, fallback: u64| -> Result<u64, String> {
            match get(name).filter(|value| !value.is_empty()) {
                None => Ok(fallback),
                Some(raw) => raw
                    .parse::<u64>()
                    .ok()
                    .filter(|value| *value > 0)
                    .ok_or_else(|| format!("{name} must be a positive number")),
            }
        };
        let token = |name: &str| -> Result<String, String> {
            let value = required(name)?;
            if value.len() < 32 {
                return Err(format!("{name} must be at least 32 characters"));
            }
            Ok(value)
        };

        let port = number("STORAGE_PORT", 3001)?;
        Ok(Self {
            host: text("HOST", "0.0.0.0"),
            port: u16::try_from(port)
                .map_err(|_| "STORAGE_PORT must be a valid port".to_string())?,
            data_dir: PathBuf::from(text("DATA_DIR", "./data")),
            database_url: required("DATABASE_URL")?,
            secrets_url: text("SECRETS_URL", "http://localhost:3002"),
            internal_service_token: token("INTERNAL_SERVICE_TOKEN")?,
            max_upload_bytes: number("MAX_UPLOAD_BYTES", 1024 * 1024 * 1024)?,
            quota_bytes: number("STORAGE_QUOTA_BYTES", 5 * 1024 * 1024 * 1024)?,
            secrets_timeout: Duration::from_millis(number("SECRETS_TIMEOUT_MS", 10_000)?),
            audit_url: text("AUDIT_URL", "http://localhost:3003"),
            audit_token: token("AUDIT_TOKEN")?,
            audit_timeout: Duration::from_millis(number("AUDIT_TIMEOUT_MS", 2_000)?),
            version: text("SERVICE_VERSION", "dev"),
            request_timeout: Duration::from_millis(number("REQUEST_TIMEOUT_MS", 600_000)?),
            shutdown_timeout: Duration::from_millis(number("SHUTDOWN_TIMEOUT_MS", 25_000)?),
        })
    }
}
