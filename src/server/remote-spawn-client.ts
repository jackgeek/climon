import { Buffer } from "node:buffer";
import { connectSessionSocket } from "../session-socket.js";
import { readIngestState } from "../remote/ingest-state.js";
import type { SpawnControlRequest, SpawnControlResponse } from "../remote/ingest.js";

/**
 * Sends a spawn request to the ingest's loopback control socket and resolves
 * with its response, or an error response if the ingest is unreachable.
 */
export async function requestRemoteSpawn(
  req: SpawnControlRequest,
  timeoutMs = 12_000,
  env: NodeJS.ProcessEnv = process.env
): Promise<SpawnControlResponse> {
  const state = await readIngestState(env);
  if (!state?.controlSocket) {
    return { type: "spawn-result", requestId: req.requestId, error: "ingest not running" };
  }
  // Authenticate to the running ingest by echoing its per-run control token.
  const authedReq: SpawnControlRequest = state.controlToken
    ? { ...req, controlToken: state.controlToken }
    : req;
  return new Promise<SpawnControlResponse>((resolve) => {
    const socket = connectSessionSocket(state.controlSocket!);
    let buf = "";
    let settled = false;
    const done = (res: SpawnControlResponse): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(res);
    };
    const timer = setTimeout(
      () => done({ type: "spawn-result", requestId: req.requestId, error: "timeout" }),
      timeoutMs
    );
    timer.unref?.();
    socket.on("connect", () => socket.write(JSON.stringify(authedReq) + "\n"));
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        done(JSON.parse(buf.slice(0, nl)) as SpawnControlResponse);
      } catch {
        done({ type: "spawn-result", requestId: req.requestId, error: "bad response" });
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      done({ type: "spawn-result", requestId: req.requestId, error: "ingest unreachable" });
    });
  });
}
