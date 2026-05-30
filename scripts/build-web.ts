#!/usr/bin/env bun
/**
 * Bundles the React dashboard to dist/web/app.js for inspection or static
 * hosting. The server can also build this on demand (source mode) or serve it
 * from the embedded base64 copy (compiled binary), so this is not required for
 * `bun run server`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { buildWebBundle } from "../src/server/web-build.ts";

const projectRoot = dirname(dirname(import.meta.path));
const outDir = resolve(projectRoot, "dist/web");
mkdirSync(outDir, { recursive: true });

const js = await buildWebBundle();
const outPath = resolve(outDir, "app.js");
writeFileSync(outPath, js);
console.log(`✓ Wrote ${outPath} (${(js.length / 1024).toFixed(1)} KB)`);
