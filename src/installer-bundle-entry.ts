/**
 * Bundle entry point for the installer JS bundle loaded in-process by climon.exe.
 * Exports the installer main so climon can run it without a separate Setup.exe.
 */
export { main, runSetupCli, pauseForExit } from "./install/index.js";
