export interface ParsedPushData {
  title: string;
  body: string;
  sessionId?: string;
}

const DEFAULT_TITLE = "climon";
const DEFAULT_BODY = "A session needs attention";

export function parsePushData(raw: string | null | undefined): ParsedPushData {
  if (!raw) {
    return { title: DEFAULT_TITLE, body: DEFAULT_BODY };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const title = typeof parsed.title === "string" && parsed.title ? parsed.title : DEFAULT_TITLE;
    const body = typeof parsed.body === "string" && parsed.body ? parsed.body : DEFAULT_BODY;
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    return { title, body, sessionId };
  } catch {
    return { title: DEFAULT_TITLE, body: DEFAULT_BODY };
  }
}
