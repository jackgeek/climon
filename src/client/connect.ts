import { type Socket } from "node:net";
import { Buffer } from "node:buffer";
import {
  encodeFrame,
  encodeJsonFrame,
  FrameDecoder,
  FrameType,
  parseJsonPayload,
  type ExitPayload,
  type TitlePayload
} from "../ipc/frame.js";
import { TitleController } from "./title.js";
import { connectSessionSocket } from "../session-socket.js";

const DETACH_KEY = 0x64; // 'd'

export interface AttachResult {
  detached: boolean;
  exitCode: number;
}

interface ProcessedInput {
  forward: Buffer;
  detach: boolean;
}

class InputProcessor {
  private armed = false;

  constructor(private readonly prefix: number) {}

  process(chunk: Buffer): ProcessedInput {
    const out: number[] = [];
    for (const byte of chunk) {
      if (this.armed) {
        this.armed = false;
        if (byte === DETACH_KEY) {
          return { forward: Buffer.from(out), detach: true };
        }
        out.push(this.prefix, byte);
      } else if (byte === this.prefix) {
        this.armed = true;
      } else {
        out.push(byte);
      }
    }
    return { forward: Buffer.from(out), detach: false };
  }
}

function terminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24
  };
}

/**
 * Connects the local terminal to a running session daemon. Forwards keystrokes,
 * renders PTY output, and supports detaching with the configured prefix then d.
 */
export function connectToSession(socketPath: string, detachPrefix: number = 0x1c): Promise<AttachResult> {
  return new Promise<AttachResult>((resolve, reject) => {
    const socket: Socket = connectSessionSocket(socketPath);
    const decoder = new FrameDecoder();
    const inputProcessor = new InputProcessor(detachPrefix);
    const stdin = process.stdin;
    let settled = false;
    let exitCode = 0;
    let detached = false;
    const titleController = new TitleController(process.stdout);

    const onStdin = (chunk: Buffer): void => {
      const { forward, detach } = inputProcessor.process(chunk);
      if (forward.length > 0) {
        socket.write(encodeFrame(FrameType.Input, forward));
      }
      if (detach) {
        detached = true;
        cleanup();
        socket.end();
        finish();
      }
    };

    const onResize = (): void => {
      const size = terminalSize();
      socket.write(encodeJsonFrame(FrameType.Resize, { ...size, source: "host" }));
    };

    function cleanup(): void {
      stdin.removeListener("data", onStdin);
      process.stdout.removeListener("resize", onResize);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
      titleController.clear();
    }

    function finish(): void {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ detached, exitCode });
    }

    socket.on("connect", () => {
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.on("data", onStdin);
      process.stdout.on("resize", onResize);
      onResize();
    });

    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === FrameType.Output || frame.type === FrameType.Replay) {
          process.stdout.write(frame.payload);
        } else if (frame.type === FrameType.Exit) {
          exitCode = parseJsonPayload<ExitPayload>(frame.payload).exitCode;
        } else if (frame.type === FrameType.Title) {
          titleController.apply(parseJsonPayload<TitlePayload>(frame.payload).name);
        }
      }
    });

    socket.on("error", (error) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(error);
    });

    socket.on("close", () => {
      cleanup();
      finish();
    });
  });
}
