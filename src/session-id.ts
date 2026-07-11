/**
 * Validates a session id used to build filesystem paths / IPC endpoints.
 *
 * Accepts a local id (`^[a-z]+(-[a-z]+){2}$`) or a remote-namespaced id
 * `<local>~<remote_id>` where `<remote_id>` matches `^[A-Za-z0-9._-]{1,64}$`.
 * Rejects everything else — including `.`/`..`, path separators, and NUL — so
 * no caller can escape `$CLIMON_HOME/sessions`.
 */
export function validateSessionId(id: string): void {
  const tildeIdx = id.indexOf("~");
  const local = tildeIdx === -1 ? id : id.slice(0, tildeIdx);
  const remote = tildeIdx === -1 ? undefined : id.slice(tildeIdx + 1);

  if (!isValidLocalId(local)) {
    throw new Error(`Invalid session id: ${JSON.stringify(id)}`);
  }
  if (remote !== undefined && !isValidRemoteComponent(remote)) {
    throw new Error(`Invalid session id: ${JSON.stringify(id)}`);
  }
}

function isValidLocalId(s: string): boolean {
  const segments = s.split("-");
  if (segments.length !== 3) return false;
  return segments.every(
    (seg) => seg.length > 0 && /^[a-z]+$/.test(seg),
  );
}

function isValidRemoteComponent(s: string): boolean {
  if (s === "." || s === "..") return false;
  return s.length >= 1 && s.length <= 64 && /^[A-Za-z0-9._-]+$/.test(s);
}
