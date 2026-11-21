use std::io::IsTerminal;
use std::process::ExitCode;

use secrets::operator::DEFAULT_OPERATOR_SOCKET;
use secrets::operator::cli::{HiddenPrompt, OperatorIo};

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let socket =
        std::env::var("OPERATOR_SOCKET").unwrap_or_else(|_| DEFAULT_OPERATOR_SOCKET.to_string());
    let stdin = std::io::stdin();
    let terminal = stdin.is_terminal();
    let mut input = stdin.lock();
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    let hidden_prompt: Option<HiddenPrompt> = if terminal {
        Some(Box::new(rpassword::read_password))
    } else {
        None
    };
    let mut io = OperatorIo {
        stdin: &mut input,
        stdout: &mut stdout,
        stderr: &mut stderr,
        hidden_prompt,
    };
    let code = run(&args, &mut io, &socket).await;
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

#[cfg(unix)]
async fn run(args: &[String], io: &mut OperatorIo<'_>, socket: &str) -> i32 {
    let transport = secrets::operator::client::SocketTransport::new(socket);
    secrets::operator::cli::run_operator_command(args, io, &transport).await
}

#[cfg(not(unix))]
async fn run(_args: &[String], io: &mut OperatorIo<'_>, socket: &str) -> i32 {
    let _ = writeln!(
        io.stderr,
        "The operator socket ({socket}) only exists inside the secrets container on Linux."
    );
    1
}
