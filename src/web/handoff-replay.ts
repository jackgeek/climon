export interface HandoffReplayCheckpoint {
  attachmentGeneration: number;
  serialized: string;
  cols: number;
  rows: number;
  hadVisibleContent: boolean;
}

export interface HandoffReplayDecision {
  checkpoint: HandoffReplayCheckpoint | null;
  currentAttachmentGeneration: number;
  replayRequested: boolean;
  currentText: string;
}

export function createHandoffReplayCheckpoint(
  attachmentGeneration: number,
  serialized: string,
  capturedText: string,
  cols: number,
  rows: number
): HandoffReplayCheckpoint {
  return {
    attachmentGeneration,
    serialized,
    cols,
    rows,
    hadVisibleContent: /\S/.test(capturedText)
  };
}

export function shouldRestoreHandoffReplayCheckpoint({
  checkpoint,
  currentAttachmentGeneration,
  replayRequested,
  currentText
}: HandoffReplayDecision): boolean {
  return (
    replayRequested &&
    checkpoint !== null &&
    checkpoint.attachmentGeneration === currentAttachmentGeneration &&
    checkpoint.hadVisibleContent &&
    !/\S/.test(currentText)
  );
}
