pub mod app;
pub mod cli;
#[cfg(unix)]
pub mod client;
pub mod wire;

pub const DEFAULT_OPERATOR_SOCKET: &str = "/run/secrets-operator/operator.sock";
