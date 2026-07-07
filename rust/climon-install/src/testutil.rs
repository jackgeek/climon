pub(crate) mod tempdir {
    use std::path::{Path, PathBuf};

    /// A throwaway `$CLIMON_HOME` directory removed on drop.
    pub struct TempHome {
        path: PathBuf,
    }

    impl TempHome {
        pub fn new() -> TempHome {
            let mut buf = [0u8; 8];
            getrandom::fill(&mut buf).expect("getrandom for temp dir");
            let suffix: String = buf.iter().map(|b| format!("{b:02x}")).collect();
            let path = std::env::temp_dir().join(format!("climon-install-{suffix}"));
            std::fs::create_dir_all(&path).unwrap();
            TempHome { path }
        }

        pub fn path(&self) -> &Path {
            &self.path
        }

        pub fn path_str(&self) -> &str {
            self.path.to_str().unwrap()
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
