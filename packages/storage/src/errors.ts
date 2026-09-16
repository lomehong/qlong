export type StorageErrorCode =
  | 'UNSAFE_PATH' | 'INVALID_OPTIONS' | 'OWNERSHIP_BUSY' | 'OWNERSHIP_LOST'
  | 'DATABASE_EXISTS' | 'DATABASE_MISSING' | 'SCHEMA_UNSUPPORTED'
  | 'MIGRATION_CHECKSUM' | 'MIGRATION_FAILED' | 'DATABASE_CORRUPT'
  | 'SQLITE_FAILURE' | 'DURABILITY_UNAVAILABLE' | 'TRANSACTION_MISUSE'
  | 'STORE_FAULTED' | 'STORE_CLOSED';

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageError';
  }
}

/** SQLite extended result codes retain the primary result in their low byte. */
export function sqliteCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) return;
  return typeof error.errcode === 'number' ? error.errcode & 0xff : undefined;
}

export function isBusy(error: unknown): boolean {
  return sqliteCode(error) === 5 || sqliteCode(error) === 6;
}

export function storageFailure(error: unknown, message: string): StorageError {
  if (error instanceof StorageError) return error;
  const code = sqliteCode(error);
  return new StorageError(code === 11 || code === 26 ? 'DATABASE_CORRUPT' : 'SQLITE_FAILURE',
    message, { cause: error });
}