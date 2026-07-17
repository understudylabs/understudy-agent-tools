fn main() {
    // `cargo test` and `cargo clippy` validate the native code without running
    // Tauri's beforeBuildCommand, so the generated self-contained CLI is not
    // present in a fresh checkout. The Tauri CLI supplies TAURI_CONFIG for
    // real app/dev builds after preparing the bundle; direct Cargo invocations
    // intentionally omit only those generated packaging inputs.
    if std::env::var_os("TAURI_CONFIG").is_none() {
        std::env::set_var(
            "TAURI_CONFIG",
            r#"{"bundle":{"externalBin":null,"resources":null}}"#,
        );
    }
    tauri_build::build()
}
