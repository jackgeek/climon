//! Client stub -> `climon.exe`. Resolves `climon-<ver>.dll` via the pointer and
//! calls its exported `climon_main(argc, argv)` IN-PROCESS (no child process).
//! Zero dependencies: raw FFI to kernel32 on Windows; a plain error on Unix
//! (the client stub is never shipped on Unix).

fn main() {
    std::process::exit(real_main());
}

#[cfg(windows)]
fn real_main() -> i32 {
    use climon_stub::pointer::{resolve_artifact, CLIENT};

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("climon: cannot resolve own path: {e}");
            return 1;
        }
    };
    let dir = match exe.parent() {
        Some(d) => d,
        None => {
            eprintln!("climon: cannot resolve install directory");
            return 1;
        }
    };
    let dll = match resolve_artifact(dir, CLIENT) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("climon: {e}");
            return 1;
        }
    };
    win::load_and_run(&dll)
}

#[cfg(not(windows))]
fn real_main() -> i32 {
    eprintln!("climon: the DLL-loader stub is a Windows-only artifact");
    1
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::raw::{c_int, c_ushort};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    type HModule = *mut c_void;
    type FarProc = *mut c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryW(lp_lib_file_name: *const c_ushort) -> HModule;
        fn GetProcAddress(h_module: HModule, lp_proc_name: *const u8) -> FarProc;
        fn GetLastError() -> u32;
    }

    // The frozen C ABI entrypoint exported by climon-<ver>.dll.
    type ClimonMain = extern "C" fn(argc: c_int, argv: *const *const c_ushort) -> c_int;

    /// Encodes a path as a NUL-terminated UTF-16 buffer for LoadLibraryW.
    fn wide(path: &Path) -> Vec<u16> {
        let mut v: Vec<u16> = path.as_os_str().encode_wide().collect();
        v.push(0);
        v
    }

    /// Encodes a UTF-8 string as a NUL-terminated UTF-16 vector.
    fn wide_arg(s: &str) -> Vec<u16> {
        let mut v: Vec<u16> = s.encode_utf16().collect();
        v.push(0);
        v
    }

    pub fn load_and_run(dll: &Path) -> i32 {
        let wide_path = wide(dll);
        let handle = unsafe { LoadLibraryW(wide_path.as_ptr()) };
        if handle.is_null() {
            eprintln!(
                "climon: failed to load {} (error {})",
                dll.display(),
                unsafe { GetLastError() }
            );
            return 1;
        }
        // C string literal for GetProcAddress; cast to the *const u8 the binding expects.
        let proc = unsafe { GetProcAddress(handle, c"climon_main".as_ptr().cast()) };
        if proc.is_null() {
            eprintln!(
                "climon: {} does not export climon_main (error {})",
                dll.display(),
                unsafe { GetLastError() }
            );
            return 1;
        }
        // Rebuild argv (including argv[0]) as UTF-16 pointers.
        let args: Vec<String> = std::env::args().collect();
        let wide_args: Vec<Vec<u16>> = args.iter().map(|a| wide_arg(a)).collect();
        let ptrs: Vec<*const c_ushort> = wide_args.iter().map(|w| w.as_ptr()).collect();

        let climon_main: ClimonMain = unsafe { std::mem::transmute(proc) };
        // wide_args/ptrs must outlive the call; they do (dropped after return).
        climon_main(ptrs.len() as c_int, ptrs.as_ptr()) as i32
    }
}
