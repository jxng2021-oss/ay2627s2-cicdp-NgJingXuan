use std::time::Duration;

use crate::operator::DEFAULT_OPERATOR_SOCKET;
use crate::seal::seal_manager::SealSettings;

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub database_url: String,
    pub internal_service_token: String,
    pub identity_service_token: String,
    pub audit_url: String,
    pub audit_token: String,
    pub audit_timeout: Duration,
    pub version: String,
    pub operator_socket: String,
    pub max_secret_bytes: usize,
    pub seal: SealSettings,
    pub shutdown_timeout: Duration,
}

fn positive(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &str,
    fallback: u64,
) -> Result<u64, String> {
    match lookup(name).filter(|value| !value.is_empty()) {
        None => Ok(fallback),
        Some(raw) => match raw.parse::<u64>() {
            Ok(value) if value > 0 => Ok(value),
            _ => Err(format!("{name} must be a positive whole number")),
        },
    }
}

fn token(lookup: &impl Fn(&str) -> Option<String>, name: &str) -> Result<String, String> {
    let value = lookup(name).unwrap_or_default();
    if value.chars().count() < 32 {
        return Err(format!("{name} must be set, at least 32 characters"));
    }
    Ok(value)
}

fn millis(value: u64) -> Duration {
    Duration::from_millis(value)
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    pub fn from_vars(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let database_url = lookup("DATABASE_URL")
            .filter(|value| !value.is_empty())
            .ok_or("DATABASE_URL must be set")?;
        let port = positive(&lookup, "SECRETS_PORT", 3002)?;
        Ok(Self {
            host: lookup("HOST").unwrap_or_else(|| "0.0.0.0".to_string()),
            port: u16::try_from(port).map_err(|_| "SECRETS_PORT must be a valid port")?,
            database_url,
            internal_service_token: token(&lookup, "INTERNAL_SERVICE_TOKEN")?,
            identity_service_token: token(&lookup, "IDENTITY_SERVICE_TOKEN")?,
            audit_url: lookup("AUDIT_URL").unwrap_or_else(|| "http://localhost:3003".to_string()),
            audit_token: token(&lookup, "AUDIT_TOKEN")?,
            audit_timeout: millis(positive(&lookup, "AUDIT_TIMEOUT_MS", 2_000)?),
            version: lookup("SERVICE_VERSION").unwrap_or_else(|| "dev".to_string()),
            operator_socket: lookup("OPERATOR_SOCKET")
                .unwrap_or_else(|| DEFAULT_OPERATOR_SOCKET.to_string()),
            max_secret_bytes: usize::try_from(positive(&lookup, "MAX_SECRET_BYTES", 64 * 1024)?)
                .map_err(|_| "MAX_SECRET_BYTES is too large")?,
            seal: SealSettings {
                unseal_timeout: millis(positive(&lookup, "UNSEAL_TIMEOUT_MS", 10 * 60_000)?),
                max_failed_attempts: u32::try_from(positive(
                    &lookup,
                    "UNSEAL_MAX_FAILED_ATTEMPTS",
                    5,
                )?)
                .map_err(|_| "UNSEAL_MAX_FAILED_ATTEMPTS is too large")?,
                lockout: millis(positive(&lookup, "UNSEAL_LOCKOUT_MS", 5 * 60_000)?),
                drain_timeout: millis(positive(&lookup, "SEAL_DRAIN_TIMEOUT_MS", 10_000)?),
            },
            shutdown_timeout: millis(positive(&lookup, "SHUTDOWN_TIMEOUT_MS", 25_000)?),
        })
    }
}
