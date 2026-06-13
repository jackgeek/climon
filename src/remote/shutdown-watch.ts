import { readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { child } from "../logging/logger.js";
import {
  getShutdownRequestPathInDir,
  parseShutdownRequest,
  SHUTDOWN_REQUEST_BASENAME,
  type ShutdownRequest
} from "./shutdown-request.js";

export interface ShutdownRequestWatcher {
  stop: () => void;
}

export interface ShutdownRequestWatcherOptions {
  /** The ingest's own home dir to watch. */
  dir: string;
  /** Called once when a well-formed request is observed (after the file is consumed). */
  onValid: (request: ShutdownRequest) => void;
  /** Poll cadence backstop in ms (default 1000). */
  pollMs?: number;
  /** Injectable fs.watch; defaults to node:fs watch. */
  watchFn?: typeof watch;
  /** Injectable reader; defaults to readFileSync. */
  readFile?: (path: string) => string;
  /** Injectable remover; defaults to rmSync(force). */
  removeFile?: (path: string) => void;
}

/**
 * Watches the ingest's OWN home for a shutdown-request.json (the peer writes it
 * over the mount). fs.watch fires fast on a peer-OS write; a ~1s poll backstops a
 * missed event. The request carries no token — same-user write access to this
 * home is the authorization. A request present at startup cannot belong to this
 * fresh instance, so it is cleared; a well-formed request is consumed before
 * onValid runs, so it acts at most once and a leftover file can never replay.
 */
export function createShutdownRequestWatcher(options: ShutdownRequestWatcherOptions): ShutdownRequestWatcher {
  const pollMs = options.pollMs ?? 1000;
  const watchFn = options.watchFn ?? watch;
  const readFile = options.readFile ?? ((p: string): string => readFileSync(p, "utf8"));
  const removeFile = options.removeFile ?? ((p: string): void => rmSync(p, { force: true }));
  const requestPath = getShutdownRequestPathInDir(options.dir);

  const debugLog = (msg: string): void => child("shutdown-watch").debug(msg);
  debugLog(`watcher starting: watching ${requestPath}`);

  let done = false;
  let watcher: FSWatcher | undefined;

  // A request present at startup cannot be for this fresh instance: clear it.
  removeFile(requestPath);
  debugLog("cleared stale request (if any)");

  let pollCount = 0;
  const check = (): void => {
    if (done) return;
    pollCount++;
    let raw: string;
    try {
      raw = readFile(requestPath);
    } catch (err: unknown) {
      if (pollCount <= 3 || pollCount % 5 === 0) {
        debugLog(`poll #${pollCount}: no file (${(err as NodeJS.ErrnoException).code ?? "unknown"})`);
      }
      return; // absent or unreadable
    }
    debugLog(`poll #${pollCount}: READ FILE (${raw.length} bytes): ${raw.trim()}`);
    const request = parseShutdownRequest(raw);
    if (!request) {
      debugLog(`poll #${pollCount}: PARSE FAILED — removing malformed file`);
      removeFile(requestPath); // malformed/oversized: drop it
      return;
    }
    debugLog(`poll #${pollCount}: VALID request from ${request.requestedBy} — firing onValid`);
    done = true;
    removeFile(requestPath); // consume before acting
    options.onValid(request);
  };

  try {
    watcher = watchFn(options.dir, (_event, filename) => {
      debugLog(`fs.watch event: ${_event} ${filename}`);
      if (!filename || String(filename) === SHUTDOWN_REQUEST_BASENAME) check();
    });
    debugLog("fs.watch started");
  } catch (err: unknown) {
    debugLog(`fs.watch failed: ${(err as Error).message}`);
    // fs.watch unsupported here; rely on polling.
  }
  const timer = setInterval(check, pollMs);
  debugLog(`poll timer started (${pollMs}ms interval)`);

  return {
    stop: (): void => {
      done = true;
      watcher?.close();
      clearInterval(timer);
      debugLog("watcher stopped");
    }
  };
}
