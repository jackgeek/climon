# Terminal keyboard copy/paste

Manual checks for keyboard copy/paste in the dashboard browser terminal (xterm).
xterm renders its selection to a canvas rather than the DOM, so the browser's own
copy shortcut copies nothing and it has no built-in keyboard copy; on Windows/Linux
Ctrl+V is otherwise sent to the PTY as a literal `^V`. The dashboard wires the
clipboard chords (Windows Terminal style):

- **macOS:** Cmd+C copies the selection; Cmd+V pastes.
- **Windows/Linux:** Ctrl+Shift+C / Ctrl+Shift+V copy/paste; additionally plain
  Ctrl+C copies **only when text is selected** (otherwise it stays a SIGINT) and
  plain Ctrl+V pastes.

Source: `src/web/terminalClipboard.ts`, `src/web/components/TerminalView.tsx`.

## TKC-1 — Copy the terminal selection with the keyboard

- **Feature:** Terminal keyboard copy/paste
- **Preconditions:** One live session open in the dashboard on a desktop (mouse)
  browser, with some visible output (e.g. run `ls -la`).
- **Config-matrix cell:** OS = macOS vs. Windows/Linux.
- **Steps:**
  1. Drag-select a word or line of terminal output with the mouse.
  2. Press the platform copy chord: **Cmd+C** (macOS) or **Ctrl+Shift+C**
     (Windows/Linux).
  3. Paste into a separate text field or editor.
- **Expected result:** The exact selected terminal text is on the clipboard and
  pastes into the other app. The keypress does **not** interrupt the running
  program (no `^C`) and no stray character is typed into the terminal.
- **Platforms:** macOS (Chrome/Safari/Firefox), Windows (Chrome/Edge/Firefox),
  Linux (Chrome/Firefox).
- **Result:** _date / tester / platform / pass-fail / notes_

## TKC-2 — Ctrl+C still interrupts when nothing is selected (Windows/Linux)

- **Feature:** Terminal keyboard copy/paste
- **Preconditions:** A live session on Windows or Linux running a long-lived
  foreground program (e.g. `ping example.com` or `sleep 100`). No text selected.
- **Config-matrix cell:** OS = Windows/Linux.
- **Steps:**
  1. Ensure there is **no** selection (click once in the terminal to clear any).
  2. Press **Ctrl+C**.
- **Expected result:** The running program is interrupted (SIGINT) exactly as in a
  native terminal — Ctrl+C with no selection is not swallowed by copy.
- **Platforms:** Windows (Chrome/Edge/Firefox), Linux (Chrome/Firefox).
- **Result:** _date / tester / platform / pass-fail / notes_

## TKC-3 — Paste into the terminal with the keyboard

- **Feature:** Terminal keyboard copy/paste
- **Preconditions:** A live session with a shell at an empty prompt. Copy some
  text (e.g. `echo hello`) to the system clipboard from another app first.
- **Config-matrix cell:** OS = macOS vs. Windows/Linux.
- **Steps:**
  1. Click into the terminal to focus it.
  2. Press the platform paste chord: **Cmd+V** (macOS) or **Ctrl+V** /
     **Ctrl+Shift+V** (Windows/Linux).
- **Expected result:** The clipboard text appears at the prompt exactly as typed.
  On Windows/Linux a literal `^V` (0x16) is **not** inserted. Do not press Enter —
  confirm the pasted characters are the raw clipboard text.
- **Platforms:** macOS (Chrome/Safari/Firefox), Windows (Chrome/Edge/Firefox),
  Linux (Chrome/Firefox).
- **Result:** _date / tester / platform / pass-fail / notes_
