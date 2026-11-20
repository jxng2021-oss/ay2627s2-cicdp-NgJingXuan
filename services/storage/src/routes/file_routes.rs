use axum::Router;
use axum::routing::{delete, get};

use crate::app::AppState;
use crate::controllers::file_controller as files;

pub fn file_routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(files::health))
        .route("/files", get(files::list).post(files::upload))
        .route("/files/{id}", get(files::download).delete(files::remove))
        .route("/files/{id}/metadata", get(files::metadata))
        .route("/usage", get(files::usage))
        .route("/tenant", delete(files::remove_tenant))
}
