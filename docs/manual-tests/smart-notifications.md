# Smart Notifications

| Field | Value |
| --- | --- |
| ID | smart-notifications-01 |
| Feature | Smart attention-notification body from terminal output |
| Preconditions | A CLI session (e.g. `copilot`, `claude`) that renders a response then idles; dashboard open with notifications enabled; `feature.smartNotifications = enabled` (off by default). |
| Config matrix | `feature.smartNotifications = enabled` (snippet body); then default config (`disabled`, plain body). |

## Steps

1. Start a session: `climon run -- copilot` (or any agentic CLI).
2. Send a prompt so the CLI prints a multi-line answer ending in a question, then let it sit idle past `attention.idleSeconds`.
3. Observe the OS push notification and the in-app toast when the session flags `needs-attention`.
4. Set `feature.smartNotifications = disabled` (`climon config set feature.smartNotifications disabled`), restart the session, and repeat steps 2–3.
5. In an agentic TUI with a persistent bottom hint bar (e.g. Copilot CLI's `⌃T show reasoning · <model>` / `/ commands  ? help` line and its input composer box), send a prompt, let the answer render above the empty input box, and let it idle.

## Expected result

- With the snippet on: the notification **title** is the session name (or terminal title if unnamed); the **body** is a ≤160-char snippet of the last relevant paragraph (the CLI's closing summary/question), never terminal UI chrome (borders, spinner, `tokens`, progress bars).
- With the snippet off: the body falls back to the terminal title (or empty), matching the pre-feature behavior.
- The snippet is a point-in-time capture: it does not change while the session stays idle.
- Step 5: the body is the agent's response above the input box — **never** the bottom hint/help/status bar (e.g. `⌃T show reasoning · Claude Opus 4`) or the input composer. The extractor ignores everything from the cursor row down and treats keybinding-glyph lines (`⌃`, `⌘`, `⇧`, …) as chrome.

## Platforms

- [ ] Windows
- [ ] macOS
- [ ] Linux
- [ ] iOS PWA (push)

## Results

| Date | Platform | Result | Notes |
| --- | --- | --- | --- |
| | | | |
