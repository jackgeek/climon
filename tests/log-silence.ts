// Preloaded before every test (registered in bunfig.toml). Silences climon
// logging so tests produce no output and no log files. Respects an explicit
// override so `CLIMON_LOG_LEVEL=debug bun test` still works.
process.env.CLIMON_LOG_LEVEL ??= "silent";
