# Read-only file viewer (terminal link → cwd-confined viewer, local + remote)

Manual checks for the optional dashboard file viewer. Clicking a file path printed
in the terminal opens it in a **read-only**, cwd-confined viewer. File bytes come
from `POST /api/file` (same-origin guarded); the cwd-subtree confinement
(canonicalize + containment + regular-file + size cap + binary screen) is applied
on the local read and re-applied on the remote host by the uplink. Content renders
in a sandboxed iframe (no scripts) under a strict CSP, so opening a file never
executes its contents. The feature is **off by default** (`feature.fileViewer`).

## FV-1 — Local: click a path opens the file at the referenced line

- **Feature:** File viewer — local read + link parsing
- **Preconditions:** `climon config feature.fileViewer enabled`. Dashboard open with a
  live local session whose cwd is the climon repo root.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session; desktop browser.
- **Steps:**
  1. In the attached terminal, run `echo src/index.ts:1`.
  2. In the dashboard terminal, click the `src/index.ts:1` link.
- **Expected result:** A dialog opens showing the contents of `src/index.ts`. The
  title/header reflects the resolved path. No page reload; the terminal stays live.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-2 — Confinement: a path outside the cwd is refused

- **Feature:** File viewer — cwd-subtree confinement (SEC)
- **Preconditions:** `feature.fileViewer enabled`; live local session with a normal
  project cwd (not `/`).
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. Run `echo /etc/hosts` (or `echo ../../../../etc/passwd`) in the terminal.
  2. Click the resulting link.
- **Expected result:** The viewer refuses the read with an "outside the session
  working directory" message; no file outside the cwd subtree is shown. A symlink
  inside the cwd that points outside is likewise refused.
- **Platforms:** Desktop Chrome, Firefox, Safari; macOS/Linux (and Windows with an
  out-of-tree absolute path).
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-3 — Markdown renders without executing scripts

- **Feature:** File viewer — sandboxed markdown render
- **Preconditions:** `feature.fileViewer enabled`; live local session in the repo root.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. Run `echo README.md` and click the link.
  2. (Optional) Open a markdown file containing a raw `<script>` or
     `<img onerror=…>` and inspect the dev-tools console.
- **Expected result:** Markdown renders (headings, lists, code blocks). No script
  executes (the iframe is `sandbox=""` with `script-src 'none'`); the console shows
  CSP blocking any inline/script attempt.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-4 — Binary file shows a "binary" notice

- **Feature:** File viewer — binary screen
- **Preconditions:** `feature.fileViewer enabled`; live local session; a binary file in
  the cwd subtree (e.g. a compiled binary or an image).
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. `echo` the path to a binary file in the cwd and click the link.
- **Expected result:** The viewer shows a "binary file" notice instead of garbled
  bytes; no content is rendered.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-5 — File over the size cap shows a "too large" notice

- **Feature:** File viewer — size cap (`fileViewer.maxFileSizeBytes`)
- **Preconditions:** `feature.fileViewer enabled`. Set a small cap, e.g.
  `climon config fileViewer.maxFileSizeBytes 1024`. Have a file > 1 KiB in the cwd.
- **Config-matrix cell:** `fileViewer.maxFileSizeBytes = 1024`; local session.
- **Steps:**
  1. `echo` the path to a file larger than the cap and click the link.
- **Expected result:** The viewer shows a "too large" notice (with the file size);
  no content body is read.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-6 — Disabled by default / when turned off

- **Feature:** File viewer — feature gate
- **Preconditions:** `climon config feature.fileViewer disabled` (or unset).
- **Config-matrix cell:** `feature.fileViewer = disabled`; local session.
- **Steps:**
  1. Run `echo src/index.ts:1` and attempt to click the link.
  2. (Optional) `POST /api/file` directly and observe the status.
- **Expected result:** No viewer opens (or a disabled message is shown). The direct
  `POST /api/file` returns `404` ("file viewer disabled").
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-7 — Remote: file loads over the mux; escape refused on the remote host

- **Feature:** File viewer — remote read routing (ingest ↔ uplink mux)
- **Preconditions:** `feature.fileViewer enabled` on the dashboard host. A remote
  (dev-tunnel) session is connected and visible in the dashboard, with a known cwd
  containing a text file.
- **Config-matrix cell:** `feature.fileViewer = enabled`; remote (dev tunnel) session.
- **Steps:**
  1. In the remote session's terminal, `echo` a path to a text file inside its cwd
     and click the link.
  2. `echo` an out-of-tree path (e.g. `/etc/hosts`) on the remote and click it.
- **Expected result:** Step 1 loads the remote file contents in the viewer (the
  read travels server → ingest control socket → uplink → confined read → back).
  Step 2 is refused ("outside the session working directory") — confinement holds
  on the remote host. A 2 MiB-range file still loads (length-prefixed reply framing,
  not capped by the 64 KiB control line).
- **Platforms:** Desktop/mobile; remote devbox over a dev tunnel.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-8 — Tunnel/mobile render; cross-origin rejected

- **Feature:** File viewer — same-origin guard over tunnel
- **Preconditions:** `feature.fileViewer enabled`. A dev-tunnel (Tunnel Link) session is
  active; open the dashboard via the tunnel URL (optionally on a phone).
- **Config-matrix cell:** Remote = dev tunnel; Browser = mobile or desktop.
- **Steps:**
  1. Over the tunnel URL, click a file link and view the file.
  2. (Optional) From a different Origin host, issue a `POST /api/file` and observe
     the status.
- **Expected result:** The viewer renders over the tunnel. A cross-origin
  `POST /api/file` is rejected with `403` (same-origin guard).
- **Platforms:** iOS Safari, Android Chrome, desktop over a dev tunnel.
- **Result:** _date / tester / platform / pass-fail / notes_
