# Smart Notifications

| Field | Value |
| --- | --- |
| ID | smart-notifications-01 |
| Feature | Smart attention-notification body from terminal output |
| Preconditions | A CLI session (e.g. `copilot`, `claude`) that renders a response then idles; dashboard open with notifications enabled; `notifications.smartSnippet` unset (defaults on). |
| Config matrix | Default config (snippet on); then `notifications.smartSnippet = false`. |

## Steps

1. Start a session: `climon run -- copilot` (or any agentic CLI).
2. Send a prompt so the CLI prints a multi-line answer ending in a question, then let it sit idle past `attention.idleSeconds`.
3. Observe the OS push notification and the in-app toast when the session flags `needs-attention`.
4. Set `notifications.smartSnippet = false` (`climon config set notifications.smartSnippet false`), restart the session, and repeat steps 2–3.

## Expected result

- With the snippet on: the notification **title** is the session name (or terminal title if unnamed); the **body** is a ≤160-char snippet of the last relevant paragraph (the CLI's closing summary/question), never terminal UI chrome (borders, spinner, `tokens`, progress bars).
- With the snippet off: the body falls back to the terminal title (or empty), matching the pre-feature behavior.
- The snippet is a point-in-time capture: it does not change while the session stays idle.

## Platforms

- [ ] Windows
- [ ] macOS
- [ ] Linux
- [ ] iOS PWA (push)

## Results

| Date | Platform | Result | Notes |
| --- | --- | --- | --- |
| | | | |
