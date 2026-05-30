import { resolve } from "node:path";

/**
 * Bundles the React + Fluent UI dashboard (`src/web/main.tsx`) into a single
 * browser JavaScript file. Used three ways:
 *  - at runtime in source mode (`bun run server`) to serve `/assets/app.js`
 *    without a separate build step;
 *  - by `scripts/build-web.ts` to emit `dist/web/app.js`;
 *  - by `scripts/embed-assets.ts` to base64-embed the bundle for the compiled
 *    standalone binary.
 *
 * The entry path is passed to `Bun.build` dynamically, so the React app is never
 * statically imported into the server bundle — that keeps the server bundle lean
 * and the client/server bundle-separation guarantee intact.
 */
export async function buildWebBundle(): Promise<string> {
  const entry = resolve(import.meta.dir, "../web/main.tsx");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' }
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Failed to build web bundle");
  }
  const js = result.outputs.find((o) => o.kind === "entry-point");
  if (!js) {
    throw new Error("Web bundle produced no entry-point output");
  }
  return js.text();
}
