use std::io::{self, BufReader};

fn main() -> io::Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            println!("sumi-runtime-supervisor {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("--protocol-version") => {
            println!("{}", sumi_runtime_supervisor::PROTOCOL_VERSION);
            Ok(())
        }
        Some(_) => {
            eprintln!("unsupported argument");
            std::process::exit(2);
        }
        None => {
            sumi_runtime_supervisor::serve(BufReader::new(io::stdin().lock()), io::stdout().lock())
        }
    }
}
