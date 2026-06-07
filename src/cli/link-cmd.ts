import { linkPeer } from "../remote/link.js";

/**
 * `climon link [--peer-home <path>]` — wires same-machine WSL<->Windows
 * dashboard discovery. From WSL it auto-detects the Windows CLIMON_HOME and
 * configures both sides; `--peer-home` overrides detection (and is required on
 * Windows).
 */
export function runLinkCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  out: (text: string) => void = (text) => process.stdout.write(text)
): number {
  let peerHome: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--peer-home") {
      peerHome = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--peer-home=")) {
      peerHome = arg.slice("--peer-home=".length);
    } else if (arg === "--help" || arg === "-h") {
      out("Usage: climon link [--peer-home <path-to-peer-CLIMON_HOME>]\n");
      return 0;
    }
  }

  try {
    const result = linkPeer({ peerHome }, env, cwd);
    out(`Linked ${result.localHome} -> ${result.peerHome}\n`);
    if (result.reverseLinked) {
      out("Reverse pointer written into the peer config; both directions are configured.\n");
    } else {
      out("Run `climon link` on the peer to configure the reverse direction.\n");
    }
    return 0;
  } catch (error) {
    out(`climon link: ${(error as Error).message}\n`);
    return 1;
  }
}
