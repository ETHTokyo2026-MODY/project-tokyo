import { DatabaseSync } from 'node:sqlite';

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
