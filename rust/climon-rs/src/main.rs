//! climon-rs — Rust climon client, terminal-shadowing PoC.
//!
//! Subcommands:
//!   run [--socket PATH] -- <cmd> [args...]   Host a command in a PTY and shadow it.
//!   view [--socket PATH] | view <PATH>       Attach to a hosted session and shadow it.

mod frame;
mod host;
mod json;
mod meta;
mod scrollback;
mod term;
mod viewer;

use std::path::PathBuf;
use std::process::ExitCode;

const DEFAULT_SESSION: &str = "default";

fn usage() -> String {
    "climon-rs — terminal shadowing PoC\n\
     \n\
     USAGE:\n\
     \u{20}\u{20}climon-rs run  [--socket PATH] [--climon] [--] <command> [args...]\n\
     \u{20}\u{20}\u{20}\u{20}Host <command> in a PTY and shadow it. With --climon, register the\n\
     \u{20}\u{20}\u{20}\u{20}session under $CLIMON_HOME so the dashboard server discovers it.\n\
     \u{20}\u{20}climon-rs view [--socket PATH | <PATH>]\n\
     \u{20}\u{20}\u{20}\u{20}Attach to a hosted session and shadow it.\n\
     \n\
     The default socket lives in the system temp dir (climon-rs-default.sock).\n"
        .to_string()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => ExitCode::from((code & 0xff) as u8),
        Err(message) => {
            eprintln!("climon-rs: {}", message);
            ExitCode::from(1)
        }
    }
}

fn run(args: &[String]) -> Result<i32, String> {
    let mut iter = args.iter();
    let command = match iter.next() {
        Some(c) => c.as_str(),
        None => {
            print!("{}", usage());
            return Ok(0);
        }
    };

    match command {
        "run" => run_host(&args[1..]),
        "view" => run_view(&args[1..]),
        "-h" | "--help" | "help" => {
            print!("{}", usage());
            Ok(0)
        }
        other => Err(format!("unknown command '{}'\n\n{}", other, usage())),
    }
}

fn run_host(args: &[String]) -> Result<i32, String> {
    let mut socket: Option<PathBuf> = None;
    let mut climon = false;
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--socket" => {
                i += 1;
                let path = args.get(i).ok_or("--socket requires a path")?;
                socket = Some(PathBuf::from(path));
            }
            "--climon" => {
                climon = true;
            }
            "--" => {
                rest.extend_from_slice(&args[i + 1..]);
                break;
            }
            _ => {
                rest.extend_from_slice(&args[i..]);
                break;
            }
        }
        i += 1;
    }

    if rest.is_empty() {
        return Err("run requires a command, e.g. `climon-rs run -- bash`".to_string());
    }

    if climon {
        // Register with the climon dashboard server under $CLIMON_HOME.
        let home = meta::climon_home();
        let (cols, rows) = term::terminal_size(libc::STDIN_FILENO);
        let mut session = meta::Session::register_pending(&home, &rest, cols, rows)
            .map_err(|e| format!("failed to register session: {}", e))?;
        let socket_path =
            socket.unwrap_or_else(|| meta::registered_socket_path(&home, session.id()));
        session
            .activate(&socket_path)
            .map_err(|e| format!("failed to write session metadata: {}", e))?;
        eprintln!(
            "climon-rs: session {} registered under {} — open the climon dashboard to view it",
            session.id(),
            home.display()
        );
        let session = std::sync::Arc::new(session);
        return host::run(&rest, &socket_path, Some(session)).map_err(|e| e.to_string());
    }

    let socket_path = socket.unwrap_or_else(|| host::default_socket_path(DEFAULT_SESSION));
    eprintln!(
        "climon-rs: hosting `{}` — shadow socket at {}",
        rest.join(" "),
        socket_path.display()
    );
    host::run(&rest, &socket_path, None).map_err(|e| e.to_string())
}

fn run_view(args: &[String]) -> Result<i32, String> {
    let mut socket: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--socket" => {
                i += 1;
                let path = args.get(i).ok_or("--socket requires a path")?;
                socket = Some(PathBuf::from(path));
            }
            other => {
                socket = Some(PathBuf::from(other));
            }
        }
        i += 1;
    }

    let socket_path = socket.unwrap_or_else(|| host::default_socket_path(DEFAULT_SESSION));
    viewer::view(&socket_path).map_err(|e| e.to_string())
}
