export interface AttentionMatch {
  matched: boolean;
  reason?: string;
}

export const defaultAttentionPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(continue|proceed)\?\s*$/im, reason: "Continue/proceed prompt" },
  { pattern: /\b(confirm|confirmation required)\b/im, reason: "Confirmation prompt" },
  { pattern: /\b(y\/n|yes\/no|\[y\/n\])\b/im, reason: "Yes/no prompt" },
  { pattern: /\bpress (enter|return|any key)\b/im, reason: "Press-enter prompt" },
  { pattern: /\bwaiting for (input|user|confirmation)\b/im, reason: "Waiting for user input" },
  { pattern: /\bneeds? (your|user) (attention|input|approval)\b/im, reason: "User attention requested" },
  { pattern: /\bapprove\b.*\b(continue|run|command|change)\b/im, reason: "Approval requested" },
  { pattern: /\b(agent|copilot).*\b(waiting|requires|needs)\b.*\b(input|attention|approval)\b/im, reason: "Copilot-style attention request" }
];

export function detectAttention(output: string): AttentionMatch {
  for (const rule of defaultAttentionPatterns) {
    if (rule.pattern.test(output)) {
      return { matched: true, reason: rule.reason };
    }
  }
  return { matched: false };
}
