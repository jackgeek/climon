// pino ships its browser build at the "pino/browser" subpath but does not
// provide a type declaration for it. The browser build has the same callable
// shape as the main export, so reuse pino's own types.
declare module "pino/browser" {
  import pino from "pino";
  export default pino;
}
