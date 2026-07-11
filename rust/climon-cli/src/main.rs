//! `climon` client bin entrypoint (Unix + local dev). Delegates to the shared
//! `climon_cli::run` so the Windows `climon.dll` cdylib dispatches identically.

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(climon_cli::run(&argv));
}
