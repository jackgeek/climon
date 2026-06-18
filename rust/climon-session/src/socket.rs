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

/// A parsed session-socket reference: either a loopback TCP endpoint or a
/// filesystem path (Unix domain socket).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedRef {
    /// `tcp://host:port`.
    Tcp { host: String, port: u16 },
    /// A Unix-domain-socket filesystem path.
    Path(PathBuf),
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
        }
    }

    /// Toggles non-blocking accept so the accept loop can poll a shutdown flag.
    pub fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        match self {
            SessionListener::Tcp(l) => l.set_nonblocking(nonblocking),
            #[cfg(unix)]
            SessionListener::Unix(l) => l.set_nonblocking(nonblocking),
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
    }
}

/// Removes the filesystem socket for a path reference; no-op for TCP. Mirrors
/// `cleanupSessionSocket`.
pub fn cleanup_session_socket(reference: &str) {
    if let Ok(ParsedRef::Path(path)) = parse_session_socket_ref(reference) {
        let _ = std::fs::remove_file(path);
    }
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
}
