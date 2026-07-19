import type { Page, Locator } from "@playwright/test";
import { HarnessError } from "./types.js";

// ── Validation helpers (exported for unit tests) ──────────────────────────────

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/** Throw HarnessError if id contains NUL or other control characters. */
export function validateSessionId(id: string): void {
  if (CONTROL_CHAR_RE.test(id)) {
    throw new HarnessError(
      "browser",
      `invalid session id: contains control characters — ${JSON.stringify(id)}`
    );
  }
}

/** Throw HarnessError if line contains newline or CR (would break single-line contract). */
export function validateTerminalLine(line: string): void {
  if (/[\r\n]/.test(line)) {
    throw new HarnessError(
      "browser",
      `terminal line must not contain newline or carriage return: ${JSON.stringify(line)}`
    );
  }
}

/**
 * Build a CSS attribute selector for a session item.
 * Uses JSON.stringify for the id value so quotes, backslashes etc. are escaped.
 */
export function sessionLocatorSelector(id: string): string {
  return `[data-testid="session-item"][data-session-id=${JSON.stringify(id)}]`;
}

// ── DashboardDriver ───────────────────────────────────────────────────────────

export class DashboardDriver {
  private readonly _page: Page;
  private readonly _consoleMsgs: string[] = [];
  private readonly _failedReqs: string[] = [];

  constructor(page: Page) {
    this._page = page;

    page.on("console", (msg) => {
      this._consoleMsgs.push(`[${msg.type()}] ${msg.text()}`);
    });

    page.on("requestfailed", (req) => {
      const failure = req.failure();
      const errorText = failure?.errorText ?? "unknown";
      this._failedReqs.push(`${req.url()} — ${errorText}`);
    });
  }

  /** Navigate to the dashboard and wait for it to be ready. */
  async open(baseUrl: string): Promise<void> {
    try {
      await this._page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      // Wait for the session list to appear, indicating the dashboard is ready
      await this._page
        .locator('[data-testid="session-list"]')
        .waitFor({ timeout: 30_000 });
    } catch (err) {
      throw new HarnessError(
        "browser",
        `dashboard did not load at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  /** Captured browser console messages formatted as "[type] text". */
  consoleMessages(): string[] {
    return [...this._consoleMsgs];
  }

  /** Captured failed request entries formatted as "url — errorText". */
  failedRequests(): string[] {
    return [...this._failedReqs];
  }

  /** Locator for the session item with the given id. */
  session(id: string): Locator {
    validateSessionId(id);
    return this._page.locator(sessionLocatorSelector(id));
  }

  /** Wait until the session item's data-session-status matches the expected value. */
  async waitForSessionStatus(
    id: string,
    status: string,
    timeoutMs = 30_000
  ): Promise<void> {
    validateSessionId(id);
    const locator = this.session(id);
    const deadline = Date.now() + timeoutMs;
    try {
      await expect_poll(
        async () => {
          const val = await locator.getAttribute("data-session-status");
          return val === status;
        },
        deadline,
        100
      );
    } catch (err) {
      throw new HarnessError(
        "browser",
        `session ${id} did not reach status "${status}" within ${timeoutMs}ms`,
        err
      );
    }
  }

  /**
   * Click the session item to select it, click "Open terminal" if visible,
   * then wait for the terminal surface to appear.
   */
  async openTerminal(id: string): Promise<void> {
    validateSessionId(id);
    try {
      const sessionItem = this.session(id);
      await sessionItem.click();

      // "Open terminal" button scoped to the selected session area
      const openBtn = this._page.locator(
        '[data-testid="open-terminal-button"]'
      );
      const btnVisible = await openBtn.isVisible();
      if (btnVisible) {
        await openBtn.click();
      }

      await this._page
        .locator('[data-testid="session-terminal"]')
        .waitFor({ timeout: 15_000 });
    } catch (err) {
      if (err instanceof HarnessError) throw err;
      throw new HarnessError(
        "browser",
        `could not open terminal for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  /**
   * Poll the terminal's .xterm-rows textContent until `text` appears.
   * Rejects with HarnessError('browser') on timeout including recent text.
   */
  async waitForTerminalText(text: string, timeoutMs = 15_000): Promise<void> {
    const terminal = this._page.locator('[data-testid="session-terminal"]');
    const rows = terminal.locator(".xterm-rows");
    const deadline = Date.now() + timeoutMs;
    let recent = "";
    try {
      await expect_poll(
        async () => {
          recent = (await rows.textContent()) ?? "";
          return recent.includes(text);
        },
        deadline,
        100
      );
    } catch {
      throw new HarnessError(
        "browser",
        `terminal text ${JSON.stringify(text)} not found within ${timeoutMs}ms; recent: ${JSON.stringify(recent.slice(-256))}`
      );
    }
  }

  /**
   * Click the terminal surface, type `line`, then press Enter.
   * Rejects if `line` contains newline or CR.
   */
  async sendTerminalLine(line: string): Promise<void> {
    validateTerminalLine(line);
    try {
      const terminal = this._page.locator('[data-testid="session-terminal"]');
      await terminal.click();
      await this._page.keyboard.type(line);
      await this._page.keyboard.press("Enter");
    } catch (err) {
      if (err instanceof HarnessError) throw err;
      throw new HarnessError(
        "browser",
        `sendTerminalLine failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }
}

// ── Internal polling helper ───────────────────────────────────────────────────

async function expect_poll(
  fn: () => Promise<boolean>,
  deadline: number,
  intervalMs: number
): Promise<void> {
  while (true) {
    if (await fn()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("deadline exceeded");
    await sleep(Math.min(intervalMs, remaining));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
