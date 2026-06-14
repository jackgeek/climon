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

/** Inputs to the contested-promote settle decision (peer server.json present). */
export interface SettleDecisionInput {
  /** True when this process runs inside WSL. */
  localIsWsl: boolean;
  /** Epoch ms when this server promoted. */
  localStartedAt: number;
  /** Peer's promote timestamp, or undefined if its server.json predates the field. */
  peerStartedAt: number | undefined;
}

export type SettleDecision = "win" | "lose";

/**
 * Decides a contested promote when a peer server.json is present in the settle
 * window. The most-recently-started server wins regardless of OS, so a
 * deliberately-started newcomer takes over an existing host. An exact start-time
 * tie — or a peer whose server.json predates `startedAt` — falls back to the
 * deterministic OS tie-break (WSL stays host). Both sides evaluate the same two
 * timestamps, so the result converges no matter which re-checks first.
 */
export function dualPromoteSettleDecision(input: SettleDecisionInput): SettleDecision {
  const { localIsWsl, localStartedAt, peerStartedAt } = input;
  if (typeof peerStartedAt === "number" && peerStartedAt !== localStartedAt) {
    return localStartedAt > peerStartedAt ? "win" : "lose";
  }
  return tieBreakOutcome({ localIsWsl, peerServerPresent: true }) === "stay-host" ? "win" : "lose";
}
