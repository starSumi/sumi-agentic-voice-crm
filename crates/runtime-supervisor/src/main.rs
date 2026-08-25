use std::io::{self, BufReader};
use std::path::Path;

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
        Some("--generate-protocol") => {
            let output_root =
                std::env::var_os("PROTOCOL_OUTPUT_ROOT").unwrap_or_else(|| ".".into());
            sumi_runtime_supervisor::generate_protocol_outputs(Path::new(&output_root))
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
