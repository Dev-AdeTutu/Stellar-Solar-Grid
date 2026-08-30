type DatabaseCloser = () => void;

const closers = new Map<string, DatabaseCloser>();
let closed = false;

/** Register one idempotent close operation for a named database. */
export function registerDatabase(name: string, close: DatabaseCloser): void {
  if (closed) {
    close();
    return;
  }
  closers.set(name, close);
}

/** Close every registered database once and prevent new handles from leaking. */
export function closeAllDatabases(): void {
  if (closed) return;
  closed = true;

  for (const [name, close] of closers) {
    try {
      close();
    } catch (error) {
      // Shutdown must continue closing the remaining handles.
      console.error(`Failed to close database ${name}`, error);
    }
  }
  closers.clear();
}

/** Reset lifecycle state for isolated test processes. */
export function resetDatabaseLifecycleForTests(): void {
  closed = false;
  closers.clear();
}
