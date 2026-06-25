import * as React from "react";
import type { RemotesConnection } from "../api.js";

export const remoteHostsMenuLabel = "Remote hosts";

export function describeRemoteHost(c: RemotesConnection): string {
  const addr = c.address ?? "?";
  return `${c.hostname} (${c.os}) — ${addr} — ${c.sessionCount} sessions`;
}

export function remoteHostsEmptyLabel(opts: { remotesActive: boolean }): string {
  return opts.remotesActive
    ? "No remote hosts connected"
    : "Remotes are disabled — enable feature.remotes to use this.";
}

export interface RemoteHostsPanelProps {
  open: boolean;
  onClose: () => void;
  connections: RemotesConnection[];
  remotesActive: boolean;
}

export function RemoteHostsPanel(props: RemoteHostsPanelProps): React.ReactElement | null {
  if (!props.open) return null;
  const { connections, remotesActive } = props;
  return (
    <div role="dialog" aria-label="Remote hosts">
      <h2>Remote hosts</h2>
      <button onClick={props.onClose} aria-label="Close">
        ×
      </button>
      {connections.length === 0 ? (
        <p>{remoteHostsEmptyLabel({ remotesActive })}</p>
      ) : (
        <ul>
          {connections.map((c) => (
            <li key={c.clientId}>
              <span aria-hidden>{c.stale ? "○" : "●"}</span> {describeRemoteHost(c)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
