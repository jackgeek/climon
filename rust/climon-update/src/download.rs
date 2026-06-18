//! Bounded HTTP downloads for update artifacts. Port of `src/update/download.ts`.
//!
//! Uses a blocking `ureq` agent with the Rustls TLS backend (bundled CA roots),
//! which avoids a dependency on the platform's native OpenSSL and enables
//! cross-compilation for targets such as linux-arm64.

use std::io::Read;

use ureq::Agent;

/// Max bytes for a downloaded release artifact (zip of compiled binaries).
pub const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
/// Max bytes for a small text resource such as a detached signature.
pub const MAX_TEXT_BYTES: u64 = 64 * 1024;
/// Max bytes for a manifest JSON document.
pub const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

fn agent() -> Agent {
    ureq::AgentBuilder::new().build()
}

/// Reads a response body, aborting if it exceeds `max` bytes. The Content-Length
/// header can lie, so the cap is enforced while streaming as well.
fn read_bounded(resp: ureq::Response, max: u64, url: &str) -> Result<Vec<u8>, String> {
    if let Some(len) = resp
        .header("Content-Length")
        .and_then(|s| s.parse::<u64>().ok())
    {
        if len > max {
            return Err(format!(
                "Download too large: {len} bytes exceeds {max} for {url}"
            ));
        }
    }
    let mut reader = resp.into_reader();
    // Read up to max+1 so an over-cap body is detected even if Content-Length lied.
    let mut buf = Vec::new();
    let read = reader
        .by_ref()
        .take(max + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Download read failed for {url}: {e}"))?;
    if read as u64 > max {
        return Err(format!("Download too large: exceeds {max} bytes for {url}"));
    }
    Ok(buf)
}

fn get(url: &str) -> Result<ureq::Response, String> {
    let agent = agent();
    match agent.get(url).call() {
        Ok(resp) => Ok(resp),
        Err(ureq::Error::Status(code, _)) => Err(format!("Download failed: HTTP {code} for {url}")),
        Err(e) => Err(format!("Download failed for {url}: {e}")),
    }
}

/// Downloads a URL to `dest`, returning the bytes. Errors on non-2xx or oversize.
pub fn download_to_file(
    url: &str,
    dest: &std::path::Path,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let resp = get(url)?;
    let bytes = read_bounded(resp, max_bytes, url)?;
    std::fs::write(dest, &bytes).map_err(|e| format!("write {} failed: {e}", dest.display()))?;
    Ok(bytes)
}

/// Downloads a small text resource (e.g. a `.sig`), returning trimmed text.
pub fn download_text(url: &str, max_bytes: u64) -> Result<String, String> {
    let resp = get(url)?;
    let bytes = read_bounded(resp, max_bytes, url)?;
    let text = String::from_utf8_lossy(&bytes).trim().to_string();
    Ok(text)
}

/// Downloads a manifest JSON document, returning its raw bytes.
pub fn download_json_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = match get(url) {
        Ok(r) => r,
        Err(e) => {
            // Match the TS manifest error message shape ("HTTP <code>").
            return Err(e.replace("Download failed", "Manifest fetch failed"));
        }
    };
    read_bounded(resp, MAX_MANIFEST_BYTES, url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    /// Minimal one-shot HTTP/1.1 server returning a canned response for the next
    /// connection. Returns the bound port.
    fn serve_once(status_line: &'static str, headers: &'static str, body: Vec<u8>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let mut resp = format!(
                    "{status_line}\r\nContent-Length: {}\r\n{headers}\r\n",
                    body.len()
                )
                .into_bytes();
                resp.extend_from_slice(&body);
                let _ = stream.write_all(&resp);
                let _ = stream.flush();
            }
        });
        port
    }

    #[test]
    fn writes_the_body_to_disk_and_returns_bytes() {
        let port = serve_once("HTTP/1.1 200 OK", "", b"payload-bytes".to_vec());
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.bin");
        let bytes = download_to_file(
            &format!("http://127.0.0.1:{port}/ok"),
            &dest,
            MAX_ARTIFACT_BYTES,
        )
        .unwrap();
        assert_eq!(bytes, b"payload-bytes");
        assert_eq!(std::fs::read(&dest).unwrap(), b"payload-bytes");
    }

    #[test]
    fn errors_on_a_non_2xx_response() {
        let port = serve_once("HTTP/1.1 404 Not Found", "", b"nope".to_vec());
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("missing.bin");
        let res = download_to_file(
            &format!("http://127.0.0.1:{port}/missing"),
            &dest,
            MAX_ARTIFACT_BYTES,
        );
        assert!(res.is_err());
    }

    #[test]
    fn errors_when_the_body_exceeds_the_byte_cap() {
        let port = serve_once("HTTP/1.1 200 OK", "", vec![b'x'; 4096]);
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("big.bin");
        let res = download_to_file(&format!("http://127.0.0.1:{port}/big"), &dest, 1024);
        assert!(res.unwrap_err().contains("too large"));
    }

    #[test]
    fn download_text_trims_and_returns() {
        let port = serve_once("HTTP/1.1 200 OK", "", b"  sig-data  ".to_vec());
        let text = download_text(&format!("http://127.0.0.1:{port}/sig"), MAX_TEXT_BYTES).unwrap();
        assert_eq!(text, "sig-data");
    }
}
