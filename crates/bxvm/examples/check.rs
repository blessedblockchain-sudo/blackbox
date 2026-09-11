//! `cargo run -p bxvm --example check -- <n_markets> <hex>...`
//! For each hex blob prints `OK|<disassembly joined by ;>` or `ERR|<validation error>`.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let n_markets: u8 = args.first().and_then(|a| a.parse().ok()).unwrap_or(8);
    for hex in args.iter().skip(1) {
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
            .collect();
        match bxvm::validate(&bytes, n_markets) {
            Ok(()) => {
                let dis: Vec<String> = bxvm::disassemble(&bytes).map(|(o, i)| format!("{}:{}", o, i)).collect();
                println!("OK|{}", dis.join(";"));
            }
            Err(e) => println!("ERR|{:?}", e),
        }
    }
}
