import { defineMigration, type SqliteStoreOptions, type StorageSchema } from '../../storage/src/index.js';
import { AUTH_SQL } from './auth-store.js';
import { REGISTRY_SQL } from './state-store.js';
import { CUSTODY_SQL } from '../../gateway/src/custody-store.js';

/** One authority database. Future mailbox/command migrations must append, never edit v1. */
export const CENTER_SCHEMA: StorageSchema = {
  id: 'qlong.center',
  migrations: [
    defineMigration({ version: 1, name: 'registry-auth-projections', sql: REGISTRY_SQL + AUTH_SQL }),
    defineMigration({ version: 2, name: 'durable-custody', sql: CUSTODY_SQL }),
  ],
};

export type CenterStorageOptions = Omit<SqliteStoreOptions, 'schema' | 'filename'>;