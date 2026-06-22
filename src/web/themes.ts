/**
 * Web entrypoint for dashboard terminal themes. The registry itself lives in the
 * shared `src/dashboard-themes.ts` module (single source of truth); this file
 * only re-exports the symbols the web bundle consumes so existing imports from
 * `./themes.js` keep working.
 */
export {
  DASHBOARD_THEMES,
  getTheme,
  type DashboardTheme
} from "../dashboard-themes.js";
