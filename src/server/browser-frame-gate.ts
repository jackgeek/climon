/**
 * Buffers browser WebSocket frames that arrive before the dashboard server has
 * finished connecting to (and authenticating with) the session daemon.
 *
 * The bridge's `open` handler is async: it awaits `connectAuthenticatedSession`
 * before it can forward anything to the daemon. Meanwhile the browser's own
 * `onopen` fires the moment the WS handshake completes, so a client that sends
 * `resize`/`takeControl` immediately (the take-control-on-attach path) can emit
 * frames while `wsData.daemon` is still undefined. Without buffering those frames
 * were silently dropped, leaving the freshly-attached surface displaced ("this
 * session is being viewed elsewhere") until the user acted again — an
 * intermittent race that widened under fast session switching.
 *
 * The gate collects those early frames (bounded, FIFO) so the bridge can drain
 * them in order once the daemon socket is wired.
 */
export class BrowserFrameGate {
  private readonly pending: string[] = [];

  /** Bounds the buffer so a misbehaving/flooding client cannot grow it without limit. */
  constructor(private readonly cap = 256) {}

  /**
   * Buffers a frame received before the daemon is ready. Returns `false` (and
   * drops the frame) once the cap is reached; the pre-daemon window is tiny, so
   * the cap only guards against pathological floods.
   */
  buffer(raw: string): boolean {
    if (this.pending.length >= this.cap) {
      return false;
    }
    this.pending.push(raw);
    return true;
  }

  /** Returns the buffered frames in arrival order and clears the buffer. */
  flush(): string[] {
    return this.pending.splice(0, this.pending.length);
  }
}
