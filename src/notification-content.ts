import type { SessionMeta } from "./types.js";

type TitleFields = Pick<SessionMeta, "name" | "terminalTitle" | "displayCommand" | "command">;
type BodyFields = Pick<SessionMeta, "name" | "terminalTitle" | "attentionSnippet">;

/**
 * Notification title: session name, else the terminal title (OSC 0/2), else the
 * display command, else the raw command. Never blank.
 */
export function notificationTitle(session: TitleFields): string {
  const name = session.name?.trim();
  if (name) return name;
  const terminalTitle = session.terminalTitle?.trim();
  if (terminalTitle) return terminalTitle;
  const display = session.displayCommand.trim();
  if (display) return display;
  return session.command.join(" ");
}

/**
 * Notification body: the fuzzy smart snippet, else the terminal title (only when
 * it was NOT already promoted into the title — i.e. when a name is present),
 * else empty. The de-dup guard prevents showing the terminal title twice.
 */
export function notificationBody(session: BodyFields): string {
  const snippet = session.attentionSnippet?.trim();
  if (snippet) return snippet;
  const name = session.name?.trim();
  const terminalTitle = session.terminalTitle?.trim();
  if (terminalTitle && name) return terminalTitle;
  return "";
}
