use tracing_subscriber::EnvFilter;

pub fn init(service: &'static str, version: &str) {
    let filter = EnvFilter::try_from_env("LOG_LEVEL").unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_span_list(false)
        .with_target(false)
        .with_env_filter(filter)
        .try_init();
    tracing::info!(service, version, "logging started");
}
