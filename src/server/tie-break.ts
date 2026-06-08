/**
 * Deterministic dual-promote tie-break (spec "Simultaneous dual-promote"). When
 * both OSes promote within the same window each re-reads the peer home; if the
 * peer also wrote a server.json, WSL wins the tie (it is the default host) and
 * Windows demotes itself. With no concurrent peer, the promoter stays host.
 */
export interface TieBreakInput {
  /** True when this process runs inside WSL. */
  localIsWsl: boolean;
  /** True when, after binding, a peer server.json is present (the peer also promoted). */
  peerServerPresent: boolean;
}

export type TieBreakOutcome = "stay-host" | "demote-self";

export function tieBreakOutcome(input: TieBreakInput): TieBreakOutcome {
  if (!input.peerServerPresent) return "stay-host";
  // Both promoted: WSL wins; Windows (non-WSL) is the loser.
  return input.localIsWsl ? "stay-host" : "demote-self";
}
