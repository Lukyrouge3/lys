export type FolderState = {
  uidValidity: bigint | null;
  lastUid: number;
};

/**
 * UIDs only mean something while uidValidity is unchanged. A fresh or reset
 * mailbox starts at the next UID, so watching a full inbox never imports years
 * of old mail on its first run.
 */
export function uidWindow(
  state: FolderState,
  mailbox: { uidValidity: bigint; uidNext: number },
): { reset: boolean; firstUid: number } {
  const reset = state.uidValidity === null ||
    state.uidValidity !== mailbox.uidValidity;
  return { reset, firstUid: reset ? mailbox.uidNext : state.lastUid + 1 };
}
