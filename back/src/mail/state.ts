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

/**
 * What to save after a sweep. After a reset the old lastUid belongs to the old
 * UID space and must be dropped: carrying it over puts the cursor past uidNext
 * and that folder never fetches mail again.
 */
export function folderStateAfter(
  previous: FolderState,
  mailbox: { uidValidity: bigint; uidNext: number },
  highestFetched: number,
): FolderState {
  const { reset, firstUid } = uidWindow(previous, mailbox);
  const floor = reset ? firstUid - 1 : previous.lastUid;
  return {
    uidValidity: mailbox.uidValidity,
    lastUid: Math.max(floor, highestFetched),
  };
}
