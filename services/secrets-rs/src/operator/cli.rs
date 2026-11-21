use std::future::Future;
use std::io::{BufRead, Write};
use std::pin::Pin;

use serde_json::{Value, json};
use zeroize::Zeroizing;

pub const USAGE: &str = "Usage: secrets-operator <status|init|unseal|seal> [--json]

  status   show whether the service is initialised and sealed
  init     create the keys and show the 5 unseal key shares ONCE
  unseal   submit ONE share (from a hidden prompt, or one line on stdin);
           run it again for each share until 3 have been accepted
  seal     seal now: secrets are refused until unsealed again
";

#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

pub type CallFuture<'a> = Pin<Box<dyn Future<Output = Result<Reply, String>> + Send + 'a>>;

pub trait Transport: Sync {
    fn call<'a>(&'a self, method: &'a str, path: &'a str, body: Option<Value>) -> CallFuture<'a>;
    fn describe(&self) -> String;
}

pub type HiddenPrompt<'a> = Box<dyn FnMut() -> std::io::Result<String> + 'a>;

pub struct OperatorIo<'a> {
    pub stdin: &'a mut dyn BufRead,
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
    pub hidden_prompt: Option<HiddenPrompt<'a>>,
}

fn line(out: &mut dyn Write, text: &str) {
    let _ = writeln!(out, "{text}");
}

pub async fn run_operator_command(
    args: &[String],
    io: &mut OperatorIo<'_>,
    transport: &dyn Transport,
) -> i32 {
    let json_output = args.iter().any(|arg| arg == "--json");
    let rest: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|arg| *arg != "--json")
        .collect();
    let Some((command, extra)) = rest.split_first() else {
        line(io.stderr, USAGE);
        return 2;
    };
    if !extra.is_empty() {
        line(
            io.stderr,
            "Unexpected arguments. Shares are never accepted on the command line: run `unseal` and enter the share when asked (or pipe it on stdin).",
        );
        return 2;
    }

    match run(command, json_output, io, transport).await {
        Ok(code) => code,
        Err(error) => {
            line(
                io.stderr,
                &format!(
                    "Could not reach the secrets service's operator socket ({}). Run this inside the secrets container while the service is running. ({error})",
                    transport.describe()
                ),
            );
            1
        }
    }
}

async fn run(
    command: &str,
    json_output: bool,
    io: &mut OperatorIo<'_>,
    transport: &dyn Transport,
) -> Result<i32, String> {
    match command {
        "status" => {
            let reply = transport.call("GET", "/status", None).await?;
            if json_output {
                line(io.stdout, &reply.body.to_string());
            } else {
                line(io.stdout, &describe_status(&reply.body));
            }
            Ok(if reply.status == 200 { 0 } else { 1 })
        }
        "init" => {
            let reply = transport.call("POST", "/init", None).await?;
            if reply.status != 201 {
                return Ok(report_error(&reply, json_output, io));
            }
            let printed = Zeroizing::new(reply.body.to_string());
            if json_output {
                line(io.stdout, &printed);
            } else {
                print_shares(&reply.body, io.stdout);
            }
            Ok(0)
        }
        "unseal" => {
            let share = read_share(io);
            if share.is_empty() {
                line(io.stderr, "No share entered.");
                return Ok(2);
            }
            let reply = transport
                .call("POST", "/unseal", Some(json!({ "share": share.as_str() })))
                .await?;
            if reply.status != 200 {
                return Ok(report_error(&reply, json_output, io));
            }
            if json_output {
                line(io.stdout, &reply.body.to_string());
            } else {
                if reply.body["duplicate"] == Value::Bool(true) {
                    line(
                        io.stdout,
                        "That share was already submitted; it was ignored.",
                    );
                }
                line(io.stdout, &describe_status(&reply.body));
            }
            Ok(0)
        }
        "seal" => {
            let reply = transport.call("POST", "/seal", None).await?;
            if json_output {
                line(io.stdout, &reply.body.to_string());
            } else {
                line(
                    io.stdout,
                    "Sealed. Secrets are refused until 3 shares are entered again.",
                );
            }
            Ok(if reply.status == 200 { 0 } else { 1 })
        }
        _ => {
            line(io.stderr, USAGE);
            Ok(2)
        }
    }
}

fn describe_status(body: &Value) -> String {
    if body["initialised"] == Value::Bool(false) {
        return "Not initialised. Run `init` to create the keys.".to_string();
    }
    if body["sealed"] == Value::Bool(false) {
        return "Unsealed: secrets are available.".to_string();
    }
    format!(
        "Sealed. Unseal progress: {} of {} shares.",
        body["progress"], body["threshold"]
    )
}

fn print_shares(body: &Value, out: &mut dyn Write) {
    line(
        out,
        "Initialised. These are the unseal key shares. They are shown ONCE and stored nowhere.",
    );
    line(
        out,
        &format!(
            "Any {} of them unseal the service. Give each to a different person and keep them safe.",
            body["threshold"]
        ),
    );
    line(
        out,
        "If more than 2 are lost, every stored secret is PERMANENTLY unrecoverable.\n",
    );
    let shares = body["shares"].as_array().cloned().unwrap_or_default();
    for (index, share) in shares.iter().enumerate() {
        let share = Zeroizing::new(share.as_str().unwrap_or_default().to_string());
        line(out, &format!("  Share {}: {}", index + 1, share.as_str()));
    }
    line(
        out,
        "\nThe service is still sealed: run `unseal` 3 times, with 3 different shares.",
    );
}

fn report_error(reply: &Reply, json_output: bool, io: &mut OperatorIo<'_>) -> i32 {
    if json_output {
        let mut body = reply.body.clone();
        if let Value::Object(map) = &mut body {
            map.insert("statusCode".to_string(), json!(reply.status));
        } else {
            body = json!({ "statusCode": reply.status });
        }
        line(io.stdout, &body.to_string());
    }
    let message = reply.body["error"]["message"]
        .as_str()
        .map_or_else(|| format!("HTTP {}", reply.status), str::to_string);
    line(io.stderr, &format!("Failed: {message}"));
    1
}

fn read_share(io: &mut OperatorIo<'_>) -> Zeroizing<String> {
    if let Some(prompt) = io.hidden_prompt.as_mut() {
        let _ = write!(io.stdout, "Unseal key share (input hidden): ");
        let _ = io.stdout.flush();
        let typed = Zeroizing::new(prompt().unwrap_or_default());
        line(io.stdout, "");
        return Zeroizing::new(typed.trim().to_string());
    }
    let mut first = Zeroizing::new(String::new());
    if io.stdin.read_line(&mut first).is_err() {
        return Zeroizing::new(String::new());
    }
    Zeroizing::new(first.trim().to_string())
}
