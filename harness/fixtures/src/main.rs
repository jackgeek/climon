use std::io;

fn main() {
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();

    let code = match climon_harness_fixture::run(
        std::env::args(),
        io::stdin(),
        &mut stdout,
        &mut stderr,
    ) {
        Ok(code) => code,
        Err(error) => {
            let _ = climon_harness_fixture::cli::write_error(&error, &mut stderr);
            error.exit_code()
        }
    };

    std::process::exit(code);
}
