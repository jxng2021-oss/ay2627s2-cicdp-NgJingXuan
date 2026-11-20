use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use storage::app::{AppState, build_app};
use storage::audit::{AuditClient, HttpAuditTransport};
use storage::cleanup::clean_up_on_start;
use storage::config::Config;
use storage::crypto::chunks::CHUNK_SIZE;
use storage::services::file_key_service::HttpFileKeyService;
use storage::services::file_service::{FileService, FileServiceOptions};
use storage::{db, logging};

#[tokio::main]
async fn main() -> ExitCode {
    let command = std::env::args().nth(1);
    let result = match command.as_deref() {
        Some("migrate") => migrate().await,
        None | Some("serve") => serve().await,
        Some(other) => Err(format!("unknown command {other}; use serve or migrate").into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(error = %error, "storage stopped");
            eprintln!("storage: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn migrate() -> Result<(), Box<dyn std::error::Error>> {
    logging::init("storage", "migrate");
    let url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL must be set")?;
    let pool = db::connect(&url).await?;
    db::migrate(&pool).await?;
    tracing::info!("storage migrations applied");
    Ok(())
}

async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    logging::init("storage", &config.version);
    tokio::fs::create_dir_all(&config.data_dir).await?;
    let pool = db::connect(&config.database_url).await?;

    let file_keys = HttpFileKeyService::new(
        &config.secrets_url,
        config.internal_service_token.clone(),
        config.secrets_timeout,
    )?;
    let audit_transport = HttpAuditTransport::new(
        &config.audit_url,
        config.audit_token.clone(),
        config.audit_timeout,
    )?;
    let audit = AuditClient::new(
        Arc::new(audit_transport),
        vec![Duration::from_millis(200), Duration::from_millis(800)],
    );

    clean_up_on_start(&pool, &config.data_dir).await?;

    let shutting_down = Arc::new(AtomicBool::new(false));
    let state = AppState {
        files: Arc::new(FileService::new(FileServiceOptions {
            db: pool.clone(),
            data_dir: config.data_dir.clone(),
            max_upload_bytes: config.max_upload_bytes,
            quota_bytes: config.quota_bytes,
            file_keys: Arc::new(file_keys),
            chunk_size: CHUNK_SIZE,
        })),
        audit,
        shutting_down: shutting_down.clone(),
        version: Arc::from(config.version.as_str()),
    };

    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    tracing::info!(port = config.port, "storage service started");
    let shutdown_timeout = config.shutdown_timeout;
    axum::serve(
        listener,
        build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        stop_signal().await;
        tracing::info!("shutting down");
        shutting_down.store(true, Ordering::SeqCst);
        tokio::spawn(async move {
            tokio::time::sleep(shutdown_timeout).await;
            tracing::error!("shutdown took too long, exiting");
            std::process::exit(1);
        });
    })
    .await?;
    pool.close().await;
    Ok(())
}

async fn stop_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
}
