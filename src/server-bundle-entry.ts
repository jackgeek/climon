/**
 * Bundle entry point for the server JS bundle loaded in-process by climon.exe.
 * Exports startServer so the client binary can call it without spawning a
 * separate process. This file is NOT the standalone server binary entry
 * (that's src/server.ts).
 */
export { startServer } from "./server/server.js";
