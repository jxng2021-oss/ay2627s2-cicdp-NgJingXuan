use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use secrets::keys::{KeyProvider, SealState};
use secrets::operator::app::operator_router;
use secrets::operator::cli::{
    CallFuture, HiddenPrompt, OperatorIo, Reply, Transport, run_operator_command,
};
use secrets::operator::wire::parse_response;
use secrets::seal::seal_manager::{SealManager, SealSettings, no_audit, system_clock};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

struct RouterTransport {
    router: Router,
}

impl Transport for RouterTransport {
    fn call<'a>(&'a self, method: &'a str, path: &'a str, body: Option<Value>) -> CallFuture<'a> {
        Box::pin(async move {
            let body = body.map(|body| body.to_string()).unwrap_or_default();
            let request = Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .map_err(|error| error.to_string())?;
            let response = self
                .router
                .clone()
                .oneshot(request)
                .await
                .map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let bytes = response
                .into_body()
                .collect()
                .await
                .map_err(|error| error.to_string())?
                .to_bytes();
            Ok(Reply {
                status,
                body: serde_json::from_slice(&bytes).unwrap_or(json!({})),
            })
        })
    }

    fn describe(&self) -> String {
        "/run/secrets-operator/operator.sock".to_string()
    }
}

struct Unreachable;

impl Transport for Unreachable {
    fn call<'a>(
        &'a self,
        _method: &'a str,
        _path: &'a str,
        _body: Option<Value>,
    ) -> CallFuture<'a> {
        Box::pin(async { Err("connection refused".to_string()) })
    }

    fn describe(&self) -> String {
        "/run/secrets-operator/operator.sock".to_string()
    }
}

struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}

async fn operator_with(
    transport: &dyn Transport,
    args: &[&str],
    input: &str,
    prompt: Option<HiddenPrompt<'_>>,
) -> Output {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let mut stdin = Cursor::new(input.as_bytes().to_vec());
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let code = {
        let mut io = OperatorIo {
            stdin: &mut stdin,
            stdout: &mut stdout,
            stderr: &mut stderr,
            hidden_prompt: prompt,
        };
        run_operator_command(&args, &mut io, transport).await
    };
    Output {
        code,
        stdout: String::from_utf8(stdout).expect("utf-8"),
        stderr: String::from_utf8(stderr).expect("utf-8"),
    }
}

async fn setup(db: &PgPool) -> (Arc<SealManager>, RouterTransport) {
    let settings = SealSettings {
        unseal_timeout: Duration::from_secs(60),
        max_failed_attempts: 5,
        lockout: Duration::from_secs(60),
        drain_timeout: Duration::from_secs(1),
    };
    let manager = Arc::new(SealManager::new(
        db.clone(),
        settings,
        system_clock(),
        no_audit(),
    ));
    manager.load().await.expect("load");
    let transport = RouterTransport {
        router: operator_router(manager.clone()),
    };
    (manager, transport)
}

async fn initialise(transport: &RouterTransport) -> Vec<String> {
    let init = operator_with(transport, &["init", "--json"], "", None).await;
    assert_eq!(init.code, 0);
    let body: Value = serde_json::from_str(init.stdout.trim()).expect("JSON");
    body["shares"]
        .as_array()
        .expect("shares")
        .iter()
        .map(|s| s.as_str().expect("text").to_string())
        .collect()
}

async fn raw(
    router: &Router,
    method: &str,
    path: &str,
    body: &str,
) -> (u16, Value, Option<String>) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("request");
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .map(|value| value.to_str().expect("text").to_string());
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(json!({})),
        retry_after,
    )
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn status_init_with_shares_shown_once_unseal_one_at_a_time_and_seal(db: PgPool) {
    let (manager, transport) = setup(&db).await;

    assert!(
        operator_with(&transport, &["status"], "", None)
            .await
            .stdout
            .contains("Not initialised")
    );

    let init = operator_with(&transport, &["init"], "", None).await;
    assert_eq!(init.code, 0);
    assert!(init.stdout.contains("shown ONCE"));
    let shares: Vec<String> = init
        .stdout
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("Share ")
                .and_then(|rest| rest.split_once(": "))
                .map(|(_, share)| share.to_string())
        })
        .collect();
    assert_eq!(shares.len(), 5);
    assert!(
        operator_with(&transport, &["init"], "", None)
            .await
            .stderr
            .contains("already initialised")
    );

    let status = operator_with(&transport, &["status"], "", None).await;
    assert!(
        status
            .stdout
            .contains("Sealed. Unseal progress: 0 of 3 shares.")
    );

    let first = operator_with(&transport, &["unseal"], &format!("{}\n", shares[0]), None).await;
    assert!(
        first
            .stdout
            .contains("Sealed. Unseal progress: 1 of 3 shares.")
    );
    let again = operator_with(&transport, &["unseal"], &format!("{}\n", shares[0]), None).await;
    assert!(again.stdout.contains("already submitted; it was ignored"));
    operator_with(&transport, &["unseal"], &format!("{}\n", shares[3]), None).await;
    let last = operator_with(&transport, &["unseal"], &format!("{}\n", shares[4]), None).await;
    assert_eq!(last.code, 0);
    assert!(last.stdout.contains("Unsealed: secrets are available."));
    assert_eq!(manager.state(), SealState::Unsealed);

    let sealed = operator_with(&transport, &["seal"], "", None).await;
    assert!(sealed.stdout.contains("Sealed. Secrets are refused"));
    assert_eq!(manager.state(), SealState::Sealed);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn prints_json_for_scripts(db: PgPool) {
    let (_, transport) = setup(&db).await;

    let init = operator_with(&transport, &["init", "--json"], "", None).await;
    let body: Value = serde_json::from_str(init.stdout.trim()).expect("JSON");
    assert_eq!(
        (body["threshold"].as_u64(), body["shareCount"].as_u64()),
        (Some(3), Some(5))
    );
    let share = body["shares"][0].as_str().expect("share").to_string();

    let status: Value = serde_json::from_str(
        operator_with(&transport, &["status", "--json"], "", None)
            .await
            .stdout
            .trim(),
    )
    .expect("JSON");
    assert_eq!(
        status,
        json!({ "initialised": true, "sealed": true, "shares": 5, "threshold": 3, "progress": 0 })
    );

    let unseal: Value = serde_json::from_str(
        operator_with(&transport, &["unseal", "--json"], &share, None)
            .await
            .stdout
            .trim(),
    )
    .expect("JSON");
    assert_eq!(unseal["progress"], 1);
    assert_eq!(unseal["duplicate"], false);

    let failed = operator_with(&transport, &["init", "--json"], "", None).await;
    assert_eq!(failed.code, 1);
    let error: Value = serde_json::from_str(failed.stdout.trim()).expect("JSON");
    assert_eq!(error["statusCode"], 409);
    assert_eq!(error["error"]["code"], "ALREADY_INITIALISED");
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn never_accepts_a_share_on_the_command_line(db: PgPool) {
    let (manager, transport) = setup(&db).await;
    let shares = initialise(&transport).await;

    let output = operator_with(&transport, &["unseal", &shares[0]], "", None).await;

    assert_eq!(output.code, 2);
    assert!(output.stderr.contains("never accepted on the command line"));
    assert!(!output.stdout.contains(&shares[0]) && !output.stderr.contains(&shares[0]));
    assert_eq!(manager.status().progress, 0);
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn reports_a_wrong_share_generically_without_repeating_it(db: PgPool) {
    let (_, transport) = setup(&db).await;
    initialise(&transport).await;
    let wrong = "bm90LWEtcmVhbC1zaGFyZS1idXQtbG9va3MtbGlrZS1vbmU=";

    let output = operator_with(&transport, &["unseal"], wrong, None).await;

    assert_eq!(output.code, 1);
    assert!(
        output
            .stderr
            .contains("Failed: That isn't a valid unseal key share")
    );
    assert!(!output.stdout.contains(wrong) && !output.stderr.contains(wrong));
    let empty = operator_with(&transport, &["unseal"], "\n", None).await;
    assert_eq!(empty.code, 2);
    assert!(empty.stderr.contains("No share entered."));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn reads_a_share_from_a_hidden_prompt_on_a_terminal(db: PgPool) {
    let (manager, transport) = setup(&db).await;
    let shares = initialise(&transport).await;
    let typed = shares[1].clone();

    let output = operator_with(
        &transport,
        &["unseal"],
        "",
        Some(Box::new(move || Ok(format!("{typed}\r\n")))),
    )
    .await;

    assert_eq!(output.code, 0);
    assert!(output.stdout.contains("Unseal key share (input hidden): "));
    assert!(!output.stdout.contains(&shares[1]));
    assert_eq!(manager.status().progress, 1);
}

#[tokio::test]
async fn explains_when_the_service_cant_be_reached() {
    let output = operator_with(&Unreachable, &["status"], "", None).await;

    assert_eq!(output.code, 1);
    assert!(output.stderr.contains("Could not reach the secrets service's operator socket (/run/secrets-operator/operator.sock)"));
    assert!(output.stderr.contains("connection refused"));
}

#[tokio::test]
async fn shows_usage_for_an_unknown_or_missing_command() {
    for args in [vec![], vec!["reveal"]] {
        let output = operator_with(&Unreachable, &args, "", None).await;
        assert_eq!(output.code, 2);
        assert!(output.stderr.contains("Usage: secrets-operator"));
    }
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn the_socket_api_answers_with_stable_error_codes(db: PgPool) {
    let (_, transport) = setup(&db).await;
    let router = transport.router.clone();

    assert_eq!(
        raw(&router, "POST", "/unseal", r#"{"share":"x"}"#).await.1["error"]["code"],
        "NOT_INITIALISED"
    );
    initialise(&transport).await;

    let (status, body, _) = raw(&router, "GET", "/reveal", "").await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (404, Some("NOT_FOUND"))
    );
    let (status, body, _) = raw(&router, "POST", "/unseal", "not json").await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (400, Some("BAD_REQUEST"))
    );
    let (status, body, _) = raw(&router, "POST", "/unseal", r#"{"share":42}"#).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (400, Some("INVALID_SHARE"))
    );
    let (status, body, _) = raw(
        &router,
        "POST",
        "/unseal",
        &format!(r#"{{"share":"{}"}}"#, "A".repeat(5000)),
    )
    .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (400, Some("BAD_REQUEST"))
    );
    let (status, body, _) = raw(&router, "POST", "/init", "").await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (409, Some("ALREADY_INITIALISED"))
    );

    for _ in 0..4 {
        raw(&router, "POST", "/unseal", r#"{"share":"bad"}"#).await;
    }
    let (status, body, retry_after) = raw(&router, "POST", "/unseal", r#"{"share":"bad"}"#).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (400, Some("INVALID_SHARE"))
    );
    let (status, body, retry_after_locked) =
        raw(&router, "POST", "/unseal", r#"{"share":"bad"}"#).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (429, Some("TOO_MANY_ATTEMPTS"))
    );
    assert!(retry_after.is_none());
    assert_eq!(retry_after_locked.as_deref(), Some("60"));
}

#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn refuses_to_initialise_over_leftover_data(db: PgPool) {
    sqlx::query(
        "INSERT INTO secrets (tenant_id, name, latest_version) VALUES (gen_random_uuid(), 'old', 1)",
    )
    .execute(&db)
    .await
    .expect("insert");
    let (_, transport) = setup(&db).await;

    let (status, body, _) = raw(&transport.router, "POST", "/init", "").await;

    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (409, Some("LEFTOVER_DATA"))
    );
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("message")
            .contains("pnpm local:reset")
    );
}

#[test]
fn reads_plain_and_chunked_socket_answers() {
    let plain = parse_response(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 13\r\n\r\n{\"sealed\":true}")
        .expect("parse");
    assert_eq!(
        plain,
        Reply {
            status: 200,
            body: json!({ "sealed": true })
        }
    );

    let chunked = parse_response(b"HTTP/1.1 409 Conflict\r\ntransfer-encoding: chunked\r\n\r\n6\r\n{\"a\":1\r\n1\r\n}\r\n0\r\n\r\n").expect("parse");
    assert_eq!(
        chunked,
        Reply {
            status: 409,
            body: json!({ "a": 1 })
        }
    );

    assert!(parse_response(b"HTTP/1.1 200 OK\r\n").is_err());
}

#[cfg(unix)]
#[sqlx::test(migrator = "secrets::db::MIGRATOR")]
async fn works_over_a_real_unix_socket(db: PgPool) {
    use secrets::operator::client::SocketTransport;

    let (manager, transport) = setup(&db).await;
    let path = std::env::temp_dir().join(format!("secrets-operator-{}.sock", uuid::Uuid::new_v4()));
    let listener = tokio::net::UnixListener::bind(&path).expect("bind");
    let server = tokio::spawn(axum::serve(listener, transport.router.clone()).into_future());
    let socket = SocketTransport::new(&path);

    let init = operator_with(&socket, &["init", "--json"], "", None).await;
    let body: Value = serde_json::from_str(init.stdout.trim()).expect("JSON");
    let shares: Vec<String> = body["shares"]
        .as_array()
        .expect("shares")
        .iter()
        .map(|s| s.as_str().expect("text").to_string())
        .collect();
    for share in &shares[..3] {
        assert_eq!(
            operator_with(&socket, &["unseal"], share, None).await.code,
            0
        );
    }
    assert_eq!(manager.state(), SealState::Unsealed);
    let failed = operator_with(&socket, &["init"], "", None).await;
    assert!(failed.stderr.contains("already initialised"));

    server.abort();
    let _ = std::fs::remove_file(&path);
    let gone = operator_with(&socket, &["status"], "", None).await;
    assert_eq!(gone.code, 1);
    assert!(gone.stderr.contains("Could not reach"));
}
