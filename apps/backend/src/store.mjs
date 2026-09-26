import { DatabaseSync } from 'node:sqlite';

/**
 * Durable storage for executable authorizations and relayer recovery state.
 * Keep the database and backups outside the source tree with restricted access.
 * Chain events are a rebuildable view; signed envelopes and pending jobs are not.
 */
export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;',
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (
        hash TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }
}
