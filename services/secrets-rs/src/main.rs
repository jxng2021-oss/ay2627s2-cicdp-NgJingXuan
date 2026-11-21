use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use secrets::app::{AppState, build_app};
use secrets::audit::{AuditClient, AuditEvent, HttpAuditTransport};
use secrets::config::Config;
use secrets::keys::{KeyProvider, SealState};
use secrets::seal::seal_manager::{SealAudit, SealManager, SealReason, system_clock};
use secrets::services::secret_service::SecretService;
use secrets::{db, logging};

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
            tracing::error!(error = %error, "secrets stopped");
            eprintln!("secrets: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn migrate() -> Result<(), Box<dyn std::error::Error>> {
    logging::init("secrets", "migrate");
    let url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL must be set")?;
    let pool = db::connect(&url).await?;
    db::migrate(&pool).await?;
    tracing::info!("Database migrations are up to date");
    Ok(())
}

fn seal_audit(audit: AuditClient) -> SealAudit {
    Arc::new(move |action| {
        let audit = audit.clone();
        Box::pin(async move {
            audit
                .record(AuditEvent {
                    action: action.to_string(),
                    outcome: "success",
                    actor_type: "operator",
                    tenant_id: None,
                    actor_id: None,
                    resource_id: None,
                    request_id: None,
                    source_ip: None,
                })
                .await
                .map_err(|_| ())
        })
    })
}

async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    logging::init("secrets", &config.version);
    let pool = db::connect(&config.database_url).await?;

    let transport = HttpAuditTransport::new(
        &config.audit_url,
        config.audit_token.clone(),
        config.audit_timeout,
    )?;
    let audit = AuditClient::new(Arc::new(transport));
    let manager = Arc::new(SealManager::new(
        pool.clone(),
        config.seal.clone(),
        system_clock(),
        seal_audit(audit.clone()),
    ));
    manager.load().await?;
    let keys: Arc<dyn KeyProvider> = manager.clone();

    let shutting_down = Arc::new(AtomicBool::new(false));
    let state = AppState {
        secrets: Arc::new(SecretService::new(pool.clone(), keys.clone())),
        keys: keys.clone(),
        audit,
        db: pool.clone(),
        max_secret_bytes: config.max_secret_bytes,
        internal_service_token: Arc::from(config.internal_service_token.as_str()),
        identity_service_token: Arc::from(config.identity_service_token.as_str()),
        shutting_down: shutting_down.clone(),
        version: Arc::from(config.version.as_str()),
    };

    let operator = start_operator(&config.operator_socket, manager.clone()).await?;

    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    if manager.state() == SealState::Uninitialised {
        tracing::info!(
            seal = "uninitialised",
            "secrets service started: NOT INITIALISED (an operator must run `init`)"
        );
    } else {
        tracing::info!(
            seal = "sealed",
            "secrets service started SEALED: an operator must unseal it with 3 shares"
        );
    }
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

    if let Some(operator) = operator {
        operator.abort();
    }
    let _ = std::fs::remove_file(&config.operator_socket);
    manager.seal(SealReason::Shutdown).await?;
    pool.close().await;
    Ok(())
}

#[cfg(unix)]
async fn start_operator(
    path: &str,
    manager: Arc<SealManager>,
) -> Result<Option<tokio::task::JoinHandle<()>>, Box<dyn std::error::Error>> {
    use std::os::unix::fs::PermissionsExt;

    let _ = std::fs::remove_file(path);
    let listener = tokio::net::UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    let router = secrets::operator::app::operator_router(manager);
    Ok(Some(tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!(error = %error, "the operator socket stopped");
        }
    })))
}

#[cfg(not(unix))]
async fn start_operator(
    path: &str,
    _manager: Arc<SealManager>,
) -> Result<Option<tokio::task::JoinHandle<()>>, Box<dyn std::error::Error>> {
    tracing::warn!(path, "operator socket not started: Unix sockets need Linux");
    Ok(None)
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
