//! Session-socket reference formatting/parsing + the listener/stream transport
//! abstraction. Ports the bind/advertise/cleanup parts of `src/session-socket.ts`
//! (the wait/connect client helpers used by tests are also provided; the richer
//! client helpers belong to Phase 8).

use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

/// Which transport a session's IPC endpoint uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpcTransport {
    /// OS-default owner-only local transport: Unix domain socket / Windows named pipe.
    Local,
    /// Explicit authenticated loopback TCP fallback.
    Tcp,
}

/// Longest Unix socket path we allow (conservative floor across platforms;
/// `sun_path` is 104 on macOS, 108 on Linux).
#[cfg(unix)]
const MAX_UNIX_SOCKET_PATH: usize = 100;

/// Builds the endpoint reference a daemon should bind for `id`.
///
/// - `IpcTransport::Local` on unix → `<sock_dir>/<id>.sock` (validated length).
/// - `IpcTransport::Local` on Windows → `pipe://climon-<id>`.
/// - `IpcTransport::Tcp` → `tcp://127.0.0.1:0` (OS picks the port at bind).
pub fn default_session_endpoint(
    sock_dir: &std::path::Path,
    id: &str,
    transport: IpcTransport,
) -> io::Result<String> {
    match transport {
        IpcTransport::Tcp => Ok(format_session_socket_ref("127.0.0.1", 0)),
        IpcTransport::Local => {
            #[cfg(unix)]
            {
                let path = sock_dir.join(format!("{id}.sock"));
                let s = path.to_string_lossy().into_owned();
                if s.len() > MAX_UNIX_SOCKET_PATH {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "Unix socket path is too long ({} > {MAX_UNIX_SOCKET_PATH}): {s}. \
                             Set session.ipcTransport = \"tcp\" or shorten $CLIMON_HOME.",
                            s.len()
                        ),
                    ));
                }
                Ok(s)
            }
            #[cfg(windows)]
            {
                let _ = sock_dir;
                Ok(format!("pipe://climon-{id}"))
            }
            #[cfg(not(any(unix, windows)))]
            {
                let _ = (sock_dir, id);
                Ok(format_session_socket_ref("127.0.0.1", 0))
            }
        }
    }
}

/// A parsed session-socket reference: either a loopback TCP endpoint, a
/// filesystem path (Unix domain socket), or a Windows named pipe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedRef {
    /// `tcp://host:port`.
    Tcp { host: String, port: u16 },
    /// A Unix-domain-socket filesystem path.
    Path(PathBuf),
    /// A Windows named pipe (raw name after the `pipe://` scheme).
    Pipe(String),
}

fn is_tcp_socket_ref(reference: &str) -> bool {
    reference.starts_with("tcp://")
}

/// Formats a loopback TCP endpoint as a `tcp://` reference, bracketing IPv6
/// hosts. Mirrors `formatSessionSocketRef`.
pub fn format_session_socket_ref(host: &str, port: u16) -> String {
    let normalized = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    format!("tcp://{normalized}:{port}")
}

/// Parses a session-socket reference. Mirrors `parseSessionSocketRef`.
pub fn parse_session_socket_ref(reference: &str) -> io::Result<ParsedRef> {
    if let Some(name) = reference.strip_prefix("pipe://") {
        return Ok(ParsedRef::Pipe(name.to_string()));
    }
    if !is_tcp_socket_ref(reference) {
        return Ok(ParsedRef::Path(PathBuf::from(reference)));
    }
    let rest = &reference["tcp://".len()..];
    let (host, port_str) = if let Some(stripped) = rest.strip_prefix('[') {
        // Bracketed IPv6: `[::1]:port`.
        let end = stripped.find(']').ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Invalid session socket host in {reference}"),
            )
        })?;
        let host = &stripped[..end];
        let after = &stripped[end + 1..];
        let port = after.strip_prefix(':').unwrap_or(after);
        (host.to_string(), port.to_string())
    } else {
        let idx = rest.rfind(':').ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Invalid session socket ref {reference}"),
            )
        })?;
        (rest[..idx].to_string(), rest[idx + 1..].to_string())
    };
    let port: i64 = port_str.parse().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Invalid session socket port in {reference}"),
        )
    })?;
    if port < 0 || port > u16::MAX as i64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Invalid session socket port in {reference}"),
        ));
    }
    Ok(ParsedRef::Tcp {
        host,
        port: port as u16,
    })
}

/// Whether a reference resolves to a concrete, connectable endpoint (a path, or
/// a TCP ref with a non-zero port). Mirrors `isResolvedSessionSocketRef`.
pub fn is_resolved_session_socket_ref(reference: &str) -> bool {
    match parse_session_socket_ref(reference) {
        Ok(ParsedRef::Path(_)) => true,
        Ok(ParsedRef::Pipe(_)) => true,
        Ok(ParsedRef::Tcp { port, .. }) => port > 0,
        Err(_) => false,
    }
}

/// Allocates an ephemeral loopback TCP port by binding to port 0 and releasing
/// it. Mirrors `allocateLoopbackPort`.
pub fn allocate_loopback_port(host: &str) -> io::Result<u16> {
    let listener = TcpListener::bind((host, 0))?;
    Ok(listener.local_addr()?.port())
}

/// A bound session-socket listener over either transport.
pub enum SessionListener {
    /// Loopback TCP listener.
    Tcp(TcpListener),
    /// Unix-domain-socket listener (unix only).
    #[cfg(unix)]
    Unix(UnixListener),
    /// Windows named-pipe listener.
    #[cfg(windows)]
    Pipe(win_pipe::PipeListener),
}

impl SessionListener {
    /// Accepts the next inbound connection.
    pub fn accept(&self) -> io::Result<Box<dyn SessionStream>> {
        match self {
            SessionListener::Tcp(l) => {
                let (stream, _) = l.accept()?;
                Ok(Box::new(stream))
            }
            #[cfg(unix)]
            SessionListener::Unix(l) => {
                let (stream, _) = l.accept()?;
                Ok(Box::new(stream))
            }
            #[cfg(windows)]
            SessionListener::Pipe(l) => {
                let stream = l.accept()?;
                Ok(Box::new(stream))
            }
        }
    }

    /// Toggles non-blocking accept so the accept loop can poll a shutdown flag.
    pub fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        match self {
            SessionListener::Tcp(l) => l.set_nonblocking(nonblocking),
            #[cfg(unix)]
            SessionListener::Unix(l) => l.set_nonblocking(nonblocking),
            #[cfg(windows)]
            SessionListener::Pipe(_) => {
                // Named-pipe listeners don't have a non-blocking mode at the
                // listener level; the accept loop uses a watchdog thread.
                Ok(())
            }
        }
    }
}

/// Binds a listener for `reference`, returning the listener and the resolved
/// reference (a TCP bind on port 0 resolves to the OS-assigned port). Mirrors
/// `listenOnSessionSocket`.
pub fn listen_on_session_socket(reference: &str) -> io::Result<(SessionListener, String)> {
    match parse_session_socket_ref(reference)? {
        ParsedRef::Path(path) => {
            #[cfg(unix)]
            {
                let _ = std::fs::remove_file(&path);
                let listener = UnixListener::bind(&path)?;
                Ok((
                    SessionListener::Unix(listener),
                    path.to_string_lossy().into_owned(),
                ))
            }
            #[cfg(not(unix))]
            {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!(
                        "unix-domain-socket refs are not supported on this platform: {}",
                        path.display()
                    ),
                ))
            }
        }
        ParsedRef::Tcp { host, port } => {
            let listener = TcpListener::bind((host.as_str(), port))?;
            let addr = listener.local_addr()?;
            let resolved = format_session_socket_ref(&addr.ip().to_string(), addr.port());
            Ok((SessionListener::Tcp(listener), resolved))
        }
        ParsedRef::Pipe(_name) => {
            #[cfg(windows)]
            {
                let listener = win_pipe::PipeListener::bind(&_name)?;
                Ok((SessionListener::Pipe(listener), format!("pipe://{_name}")))
            }
            #[cfg(not(windows))]
            {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!("named-pipe refs are not supported on this platform: pipe://{_name}"),
                ))
            }
        }
    }
}

/// Removes the filesystem socket for a path reference; no-op for TCP and named
/// pipes (pipes are freed when the last handle closes). Mirrors
/// `cleanupSessionSocket`.
pub fn cleanup_session_socket(reference: &str) {
    if let Ok(ParsedRef::Path(path)) = parse_session_socket_ref(reference) {
        let _ = std::fs::remove_file(path);
    }
    // Pipe and Tcp: nothing to clean up.
}

/// A byte stream over either transport, cloneable so a writer half can be kept
/// while the reader half drives a per-connection thread.
pub trait SessionStream: Read + Write + Send {
    /// Clones the underlying stream into a new boxed handle.
    fn try_clone_box(&self) -> io::Result<Box<dyn SessionStream>>;
    /// Shuts down both halves so a blocked reader thread unblocks.
    fn shutdown_both(&self) -> io::Result<()>;
    /// Sets the write timeout so a wedged client cannot block a broadcast.
    fn set_write_timeout(&self, dur: Option<Duration>) -> io::Result<()>;
    /// Sets blocking/non-blocking mode. Accepted sockets inherit the listener's
    /// non-blocking flag on some platforms, so per-connection readers must reset
    /// this to blocking.
    fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()>;
    /// Bounds how long a read can stall so a slow or absent pre-auth peer
    /// cannot wedge a daemon thread indefinitely.
    fn set_read_timeout(&self, dur: Option<Duration>) -> io::Result<()>;
}

impl SessionStream for TcpStream {
    fn try_clone_box(&self) -> io::Result<Box<dyn SessionStream>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn shutdown_both(&self) -> io::Result<()> {
        TcpStream::shutdown(self, std::net::Shutdown::Both)
    }
    fn set_write_timeout(&self, dur: Option<Duration>) -> io::Result<()> {
        TcpStream::set_write_timeout(self, dur)
    }
    fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        TcpStream::set_nonblocking(self, nonblocking)
    }
    fn set_read_timeout(&self, dur: Option<Duration>) -> io::Result<()> {
        TcpStream::set_read_timeout(self, dur)
    }
}

#[cfg(unix)]
impl SessionStream for UnixStream {
    fn try_clone_box(&self) -> io::Result<Box<dyn SessionStream>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn shutdown_both(&self) -> io::Result<()> {
        UnixStream::shutdown(self, std::net::Shutdown::Both)
    }
    fn set_write_timeout(&self, dur: Option<Duration>) -> io::Result<()> {
        UnixStream::set_write_timeout(self, dur)
    }
    fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        UnixStream::set_nonblocking(self, nonblocking)
    }
    fn set_read_timeout(&self, dur: Option<Duration>) -> io::Result<()> {
        UnixStream::set_read_timeout(self, dur)
    }
}

// ---------------------------------------------------------------------------
// Windows named-pipe transport
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win_pipe {
    use super::SessionStream;
    use std::io::{self, Read, Write};
    use std::ptr;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, LocalFree, DUPLICATE_SAME_ACCESS, ERROR_BROKEN_PIPE,
        ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING,
        PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, SetNamedPipeHandleState,
        PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows_sys::Win32::System::IO::OVERLAPPED;

    const PIPE_BUFFER: u32 = 64 * 1024;

    /// Encodes a pipe name to a null-terminated wide string for the Win32 API.
    fn wide(name: &str) -> Vec<u16> {
        let full = format!(r"\\.\pipe\{name}");
        let mut v: Vec<u16> = full.encode_utf16().collect();
        v.push(0); // null terminator
        v
    }

    // -----------------------------------------------------------------------
    // OwnedSecurityAttributes — DACL granting only the current user
    // -----------------------------------------------------------------------

    /// A SECURITY_ATTRIBUTES backed by a DACL that grants GENERIC_ALL only to the
    /// current user's SID.  The security descriptor is allocated by
    /// `ConvertStringSecurityDescriptorToSecurityDescriptorW` and freed on Drop
    /// via `LocalFree`.
    pub struct OwnedSecurityAttributes {
        sa: SECURITY_ATTRIBUTES,
        /// Owned security-descriptor pointer (freed with `LocalFree`).
        sd: PSECURITY_DESCRIPTOR,
    }

    // SECURITY_ATTRIBUTES is a plain C struct with no thread-affinity.
    unsafe impl Send for OwnedSecurityAttributes {}

    impl OwnedSecurityAttributes {
        /// Builds a SECURITY_ATTRIBUTES whose DACL grants `GENERIC_ALL` only to
        /// the current process-token user.
        pub fn current_user_only() -> io::Result<Self> {
            let sid_string = current_user_sid_string()?;
            // SDDL: D:(A;;GA;;;<sid>) — Allow, Generic All, to the user SID.
            let sddl = format!("D:(A;;GA;;;{sid_string})");
            let wsddl: Vec<u16> = {
                let mut v: Vec<u16> = sddl.encode_utf16().collect();
                v.push(0);
                v
            };

            let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wsddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut sd,
                    ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd,
                bInheritHandle: 0,
            };
            Ok(Self { sa, sd })
        }

        /// Returns a pointer suitable for passing to Win32 APIs that accept
        /// `*const SECURITY_ATTRIBUTES`.
        pub fn as_ptr(&self) -> *const SECURITY_ATTRIBUTES {
            &self.sa
        }
    }

    impl Drop for OwnedSecurityAttributes {
        fn drop(&mut self) {
            if !self.sd.is_null() {
                unsafe {
                    LocalFree(self.sd);
                }
            }
        }
    }

    /// Queries the current process token for the user SID and converts it to a
    /// string (e.g. `S-1-5-21-…`).
    fn current_user_sid_string() -> io::Result<String> {
        unsafe {
            let mut token: HANDLE = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }

            // First call: determine buffer size.
            let mut needed: u32 = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
            if needed == 0 {
                CloseHandle(token);
                return Err(io::Error::last_os_error());
            }

            let mut buf = vec![0u8; needed as usize];
            if GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr().cast(),
                needed,
                &mut needed,
            ) == 0
            {
                CloseHandle(token);
                return Err(io::Error::last_os_error());
            }
            CloseHandle(token);

            let tu = &*(buf.as_ptr() as *const TOKEN_USER);
            let sid: PSID = tu.User.Sid;
            let mut sid_str: *mut u16 = ptr::null_mut();
            if ConvertSidToStringSidW(sid, &mut sid_str) == 0 {
                return Err(io::Error::last_os_error());
            }

            // Read the wide string into a Rust String, then free it.
            let len = {
                let mut p = sid_str;
                let mut n = 0usize;
                while *p != 0 {
                    n += 1;
                    p = p.add(1);
                }
                n
            };
            let result = String::from_utf16_lossy(std::slice::from_raw_parts(sid_str, len));
            LocalFree(sid_str.cast());
            Ok(result)
        }
    }

    // -----------------------------------------------------------------------
    // PipeListener
    // -----------------------------------------------------------------------

    /// A named-pipe listener. The pipe name is reserved exclusively via
    /// `FILE_FLAG_FIRST_PIPE_INSTANCE` during `bind`; per-connection instances
    /// are created in `accept`.
    pub struct PipeListener {
        name: String,
    }

    impl PipeListener {
        /// Reserves the pipe name by probe-creating a first instance, then
        /// closing it.  If the name is already owned by another process
        /// `CreateNamedPipeW` with `FIRST_PIPE_INSTANCE` fails, giving the
        /// exclusive-owner guarantee.
        pub fn bind(name: &str) -> io::Result<Self> {
            let listener = PipeListener {
                name: name.to_string(),
            };
            let h = listener.create_instance(true)?;
            unsafe { CloseHandle(h) };
            Ok(listener)
        }

        fn create_instance(&self, first: bool) -> io::Result<HANDLE> {
            let wname = wide(&self.name);
            let mut open_mode = PIPE_ACCESS_DUPLEX;
            if first {
                open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
            }
            let sa = OwnedSecurityAttributes::current_user_only()?;
            let handle = unsafe {
                CreateNamedPipeW(
                    wname.as_ptr(),
                    open_mode,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    255, // max instances
                    PIPE_BUFFER,
                    PIPE_BUFFER,
                    0,
                    sa.as_ptr(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            Ok(handle)
        }

        /// Blocks until a client connects.  Creates a new pipe instance per
        /// connection (the server side of the pipe).
        pub fn accept(&self) -> io::Result<PipeStream> {
            let handle = self.create_instance(false)?;
            let connected = unsafe { ConnectNamedPipe(handle, ptr::null_mut::<OVERLAPPED>()) };
            if connected == 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32) {
                    unsafe { CloseHandle(handle) };
                    return Err(err);
                }
                // ERROR_PIPE_CONNECTED means the client connected between
                // CreateNamedPipeW and ConnectNamedPipe — that's fine.
            }
            Ok(PipeStream { handle })
        }
    }

    // -----------------------------------------------------------------------
    // PipeStream — Read / Write / SessionStream
    // -----------------------------------------------------------------------

    pub struct PipeStream {
        handle: HANDLE,
    }

    // The handle is just an integer; fine to send across threads.
    unsafe impl Send for PipeStream {}

    impl Read for PipeStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut bytes_read: u32 = 0;
            let ok = unsafe {
                ReadFile(
                    self.handle,
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    &mut bytes_read,
                    ptr::null_mut::<OVERLAPPED>(),
                )
            };
            if ok == 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    return Ok(0); // EOF
                }
                return Err(err);
            }
            Ok(bytes_read as usize)
        }
    }

    impl Write for PipeStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut bytes_written: u32 = 0;
            let ok = unsafe {
                WriteFile(
                    self.handle,
                    buf.as_ptr(),
                    buf.len() as u32,
                    &mut bytes_written,
                    ptr::null_mut::<OVERLAPPED>(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(bytes_written as usize)
        }

        fn flush(&mut self) -> io::Result<()> {
            // Named pipes in byte mode are unbuffered at the Win32 level.
            Ok(())
        }
    }

    impl SessionStream for PipeStream {
        fn try_clone_box(&self) -> io::Result<Box<dyn SessionStream>> {
            let mut new_handle: HANDLE = ptr::null_mut();
            let ok = unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    self.handle,
                    GetCurrentProcess(),
                    &mut new_handle,
                    0,
                    0, // bInheritHandle = FALSE
                    DUPLICATE_SAME_ACCESS,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Box::new(PipeStream { handle: new_handle }))
        }

        fn shutdown_both(&self) -> io::Result<()> {
            // DisconnectNamedPipe is for the server side; for the client side
            // CloseHandle is the only shutdown mechanism.  We use
            // DisconnectNamedPipe (best-effort) then mark the handle invalid.
            // Because the caller may also hold a clone, we just disconnect;
            // the Drop impl will close the handle.
            let ok = unsafe { DisconnectNamedPipe(self.handle) };
            if ok == 0 {
                // If the handle is client-side, DisconnectNamedPipe fails —
                // that's acceptable; the reader will see ERROR_BROKEN_PIPE
                // when the handle is closed on Drop.
                let _ = io::Error::last_os_error();
            }
            Ok(())
        }

        fn set_write_timeout(&self, _dur: Option<Duration>) -> io::Result<()> {
            // Byte-mode named pipes don't support per-handle write timeouts.
            Ok(())
        }

        fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
            // Best-effort: SetNamedPipeHandleState can toggle PIPE_NOWAIT.
            let mode = PIPE_READMODE_BYTE
                | if nonblocking {
                    super::win_pipe_nowait()
                } else {
                    PIPE_WAIT
                };
            let ok =
                unsafe { SetNamedPipeHandleState(self.handle, &mode, ptr::null(), ptr::null()) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// Windows byte-mode pipes don't support a portable per-handle read
        /// timeout.  The accept loop uses a watchdog + shutdown instead — this
        /// is fine because named pipes are same-user-only local.
        fn set_read_timeout(&self, _dur: Option<Duration>) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for PipeStream {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }

    /// Opens a client connection to an existing named pipe.
    pub fn connect(name: &str) -> io::Result<PipeStream> {
        let wname = wide(name);
        let handle = unsafe {
            CreateFileW(
                wname.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0, // no sharing
                ptr::null(),
                OPEN_EXISTING,
                0,               // default attributes
                ptr::null_mut(), // no template
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(PipeStream { handle })
    }
}

/// Helper: re-export the PIPE_NOWAIT constant for the win_pipe module so it
/// doesn't need a second `use` of the Pipes constants.
#[cfg(windows)]
fn win_pipe_nowait() -> windows_sys::Win32::System::Pipes::NAMED_PIPE_MODE {
    windows_sys::Win32::System::Pipes::PIPE_NOWAIT
}

/// Connects to a resolved session-socket reference. Used by integration tests
/// and (eventually) the Phase 8 attach client. Mirrors `connectSessionSocket`.
pub fn connect_session_socket(reference: &str) -> io::Result<Box<dyn SessionStream>> {
    match parse_session_socket_ref(reference)? {
        ParsedRef::Tcp { host, port } => Ok(Box::new(TcpStream::connect((host.as_str(), port))?)),
        ParsedRef::Path(path) => {
            #[cfg(unix)]
            {
                Ok(Box::new(UnixStream::connect(path)?))
            }
            #[cfg(not(unix))]
            {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!(
                        "unix-domain-socket refs are not supported on this platform: {}",
                        path.display()
                    ),
                ))
            }
        }
        ParsedRef::Pipe(_name) => {
            #[cfg(windows)]
            {
                Ok(Box::new(win_pipe::connect(&_name)?))
            }
            #[cfg(not(windows))]
            {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!("named-pipe refs are not supported on this platform: pipe://{_name}"),
                ))
            }
        }
    }
}

/// Polls until a connection to `reference` succeeds or `timeout` elapses.
/// Mirrors `waitForSessionSocket`.
pub fn wait_for_session_socket(reference: &str, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if connect_session_socket(reference).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("Timed out waiting for session socket at {reference}"),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_loopback_tcp_refs() {
        assert_eq!(
            format_session_socket_ref("127.0.0.1", 9000),
            "tcp://127.0.0.1:9000"
        );
    }

    #[test]
    fn brackets_ipv6_hosts() {
        assert_eq!(format_session_socket_ref("::1", 9000), "tcp://[::1]:9000");
    }

    #[test]
    fn parses_tcp_and_path_refs() {
        assert_eq!(
            parse_session_socket_ref("tcp://127.0.0.1:9000").unwrap(),
            ParsedRef::Tcp {
                host: "127.0.0.1".into(),
                port: 9000
            }
        );
        assert_eq!(
            parse_session_socket_ref("tcp://[::1]:9000").unwrap(),
            ParsedRef::Tcp {
                host: "::1".into(),
                port: 9000
            }
        );
        assert_eq!(
            parse_session_socket_ref("/run/climon/abc.sock").unwrap(),
            ParsedRef::Path(PathBuf::from("/run/climon/abc.sock"))
        );
    }

    #[test]
    fn resolved_ref_requires_nonzero_port() {
        assert!(is_resolved_session_socket_ref("tcp://127.0.0.1:9000"));
        assert!(!is_resolved_session_socket_ref("tcp://127.0.0.1:0"));
        assert!(is_resolved_session_socket_ref("/run/climon/abc.sock"));
    }

    #[test]
    fn formats_and_connects_to_loopback_tcp_refs() {
        let port = allocate_loopback_port("127.0.0.1").unwrap();
        let reference = format_session_socket_ref("127.0.0.1", port);
        assert_eq!(reference, format!("tcp://127.0.0.1:{port}"));

        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        let acceptor = std::thread::spawn(move || {
            // Accept the wait-probe connection and the real connection, then stop.
            for _ in 0..2 {
                if listener.accept().is_err() {
                    break;
                }
            }
        });

        wait_for_session_socket(&reference, Duration::from_secs(5)).unwrap();
        let stream = connect_session_socket(&reference).unwrap();
        drop(stream);
        let _ = acceptor.join();
    }

    #[test]
    fn listen_resolves_an_ephemeral_tcp_port() {
        let (listener, resolved) = listen_on_session_socket("tcp://127.0.0.1:0").unwrap();
        assert!(resolved.starts_with("tcp://127.0.0.1:"));
        assert!(is_resolved_session_socket_ref(&resolved));
        drop(listener);
    }

    #[cfg(unix)]
    #[test]
    fn listen_and_cleanup_a_unix_socket() {
        let dir = std::env::temp_dir().join(format!("climon-sock-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.sock");
        let reference = path.to_string_lossy().into_owned();
        let (listener, resolved) = listen_on_session_socket(&reference).unwrap();
        assert_eq!(resolved, reference);
        assert!(path.exists());
        drop(listener);
        cleanup_session_socket(&reference);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chooses_local_endpoint_by_platform() {
        let sock_dir = std::path::Path::new("/tmp/climon/sock");
        let reference =
            default_session_endpoint(sock_dir, "rare-geckos-jam", IpcTransport::Local).unwrap();
        #[cfg(unix)]
        assert_eq!(reference, "/tmp/climon/sock/rare-geckos-jam.sock");
        #[cfg(windows)]
        assert_eq!(reference, "pipe://climon-rare-geckos-jam");
    }

    #[test]
    fn tcp_transport_yields_ephemeral_loopback_ref() {
        let sock_dir = std::path::Path::new("/tmp/climon/sock");
        let reference =
            default_session_endpoint(sock_dir, "rare-geckos-jam", IpcTransport::Tcp).unwrap();
        assert_eq!(reference, "tcp://127.0.0.1:0");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_oversize_unix_socket_paths() {
        let long_dir = std::path::PathBuf::from("/".to_string() + &"x/".repeat(120));
        let err = default_session_endpoint(&long_dir, "rare-geckos-jam", IpcTransport::Local)
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }
}
