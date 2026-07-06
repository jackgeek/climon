//! Windows client cdylib. Builds `climon.dll`, loaded in-process by the
//! `climon.exe` stub. Exposes the frozen C ABI entrypoint `climon_main`, which
//! rebuilds the argv from UTF-16 pointers and dispatches through the shared
//! `climon_cli::run`.

#[cfg(windows)]
use std::os::raw::{c_int, c_ushort};

/// Frozen stub->DLL contract. The stub passes the full argv as UTF-16 pointers
/// (including argv[0]); we skip argv[0] and dispatch the rest.
///
/// # Safety
/// `argv` must point to `argc` valid, NUL-terminated UTF-16 strings that remain
/// valid for the duration of the call. The stub guarantees this.
#[cfg(windows)]
#[no_mangle]
pub extern "C" fn climon_main(argc: c_int, argv: *const *const c_ushort) -> c_int {
    let args = unsafe { collect_args(argc, argv) };
    let rest: Vec<String> = args.into_iter().skip(1).collect();
    climon_cli::run(&rest) as c_int
}

#[cfg(windows)]
unsafe fn collect_args(argc: c_int, argv: *const *const c_ushort) -> Vec<String> {
    let mut out = Vec::new();
    if argv.is_null() || argc <= 0 {
        return out;
    }
    for i in 0..argc as isize {
        let ptr = *argv.offset(i);
        if ptr.is_null() {
            out.push(String::new());
            continue;
        }
        let mut len = 0isize;
        while *ptr.offset(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(ptr, len as usize);
        out.push(String::from_utf16_lossy(slice));
    }
    out
}
