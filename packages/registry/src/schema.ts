import { defineMigration, type SqliteStoreOptions, type StorageSchema } from '../../storage/src/index.js';
import { AUTH_SQL } from './auth-store.js';
import { REGISTRY_SQL } from './state-store.js';
import { COMMAND_SQL } from './command-store.js';
import { IMPORT_LEDGER_SQL } from './import-ledger.js';
import { CUSTODY_SQL } from '../../gateway/src/custody-store.js';
import { CLAIM_SQL } from '../../gateway/src/claim-store.js';

/** One authority database. Future mailbox migrations must append, never edit v1. */
export const CENTER_SCHEMA: StorageSchema = {
  id: 'qlong.center',
  migrations: [
    defineMigration({ version: 1, name: 'registry-auth-projections', sql: REGISTRY_SQL + AUTH_SQL }),
    defineMigration({ version: 2, name: 'durable-custody', sql: CUSTODY_SQL }),
    defineMigration({ version: 3, name: 'cluster-claim', sql: CLAIM_SQL }),
    defineMigration({ version: 4, name: 'owner-command', sql: COMMAND_SQL }),
    defineMigration({ version: 5, name: 'data-import-ledger', sql: IMPORT_LEDGER_SQL }),
  ],
};

export type CenterStorageOptions = Omit<SqliteStoreOptions, 'schema' | 'filename'>;