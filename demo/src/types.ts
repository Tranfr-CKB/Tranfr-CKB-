/** A Tranfr cell the demo keeps in local storage, by out point. */
export interface TrackedCell {
  txHash: string;
  index: number;
  /** Inactivity window this cell was created or renewed with, used for the progress bar. */
  durationEpochs?: number;
}

export interface LogEntry {
  id: number;
  time: Date;
  message: string;
  txHash?: string;
}

export const cellKey = (cell: TrackedCell): string => `${cell.txHash}:${cell.index}`;
