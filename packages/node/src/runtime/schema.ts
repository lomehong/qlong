import { defineMigration, type StorageSchema } from '../../../storage/src/index.js';

/** Immutable node-domain migration history. Open SqliteStore with this schema. */
export const NODE_SCHEMA: StorageSchema = Object.freeze({
  id: 'qlong.node',
  migrations: Object.freeze([defineMigration({
    version: 1,
    name: 'durable-node-runtime',
    sql: `
      CREATE TABLE node_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1), node_id TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE node_inbox (
        sender TEXT NOT NULL, msg_id TEXT NOT NULL, digest TEXT NOT NULL,
        payload TEXT, decision TEXT NOT NULL DEFAULT 'pending'
          CHECK (decision IN ('pending', 'applied', 'duplicate', 'conflict')),
        state_key TEXT, revision INTEGER,
        PRIMARY KEY (sender, msg_id),
        CHECK (length(digest) = 64),
        CHECK ((decision = 'pending' AND payload IS NOT NULL AND state_key IS NULL AND revision IS NULL)
          OR (decision != 'pending' AND payload IS NULL AND state_key IS NOT NULL AND revision IS NOT NULL AND revision >= 0)),
        CHECK (decision != 'applied' OR revision > 0)
      ) STRICT;
      CREATE TABLE node_delivery (
        sender TEXT NOT NULL, msg_id TEXT NOT NULL, digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'stored')),
        PRIMARY KEY (sender, msg_id), CHECK (length(digest) = 64)
      ) STRICT;
      CREATE TABLE node_outbox (
        sender TEXT NOT NULL, msg_id TEXT NOT NULL, payload TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts >= 0), last_at INTEGER NOT NULL CHECK (last_at >= 0),
        PRIMARY KEY (sender, msg_id),
        FOREIGN KEY (sender, msg_id) REFERENCES node_delivery(sender, msg_id)
      ) STRICT;
      CREATE TABLE node_state (
        state_key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0), value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE node_dedup (
        sender TEXT NOT NULL, state_key TEXT NOT NULL, dedup_key TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY (sender, state_key, dedup_key), CHECK (length(digest) = 64)
      ) STRICT;
      CREATE TABLE node_effects (
        effect_id TEXT PRIMARY KEY, state_key TEXT NOT NULL REFERENCES node_state(state_key),
        revision INTEGER NOT NULL CHECK (revision > 0), kind TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done'))
      ) STRICT;
      CREATE INDEX node_inbox_pending ON node_inbox(decision);
      CREATE INDEX node_effects_pending ON node_effects(status, state_key, revision);
      -- Logical UTF-8 bytes plus a fixed per-record metadata allowance, not physical SQLite/WAL bytes.
      -- Tombstones count forever. No eviction or deletion-based capacity recovery.
      CREATE VIEW node_runtime_usage AS
        SELECT count(*) AS entries, coalesce(sum(bytes), 0) AS bytes FROM (
          SELECT 128 + length(CAST(sender || msg_id || digest || coalesce(payload, '') ||
            coalesce(state_key, '') AS BLOB)) AS bytes FROM node_inbox
          UNION ALL SELECT 128 + length(CAST(sender || msg_id || digest AS BLOB)) FROM node_delivery
          UNION ALL SELECT 128 + length(CAST(sender || msg_id || payload AS BLOB)) FROM node_outbox
          UNION ALL SELECT 128 + length(CAST(state_key || value AS BLOB)) FROM node_state
          UNION ALL SELECT 128 + length(CAST(sender || state_key || dedup_key || digest AS BLOB)) FROM node_dedup
          UNION ALL SELECT 128 + length(CAST(effect_id || state_key || kind || payload AS BLOB)) FROM node_effects
        );
    `,
  }), defineMigration({
    version: 2,
    name: 'delivery-tombstone-retention',
    sql: `
      -- Retention GC needs a terminal-age timestamp on node_delivery. stored_at is stamped exactly when a
      -- delivery turns 'stored'; a pending row leaves it NULL and is never reclaimed. Pre-existing 'stored'
      -- tombstones keep NULL on purpose: a migration must not fabricate an age that could instantly delete
      -- committed custody, so legacy tombstones persist until operational intervention.
      ALTER TABLE node_delivery ADD COLUMN stored_at INTEGER;
    `,
  })]),
});