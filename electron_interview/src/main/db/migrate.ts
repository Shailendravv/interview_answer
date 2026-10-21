import type Database from 'better-sqlite3'

/**
 * Ordered schema migrations tracked by SQLite's `PRAGMA user_version`.
 * migrations[i] upgrades a database from version i to i + 1, inside a
 * transaction, so a failed step leaves the previous version intact.
 *
 * Rules: never edit or reorder a shipped migration -- append a new one.
 * Version 1 must stay idempotent (CREATE ... IF NOT EXISTS) because databases
 * created before migrations existed already hold its tables at user_version 0.
 */
export function runMigrations(
  db: Pick<Database.Database, 'pragma' | 'exec' | 'transaction'>,
  migrations: readonly string[]
): number {
  const current = Number(db.pragma('user_version', { simple: true })) || 0

  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this app supports (${migrations.length}). ` +
        'Install the newer app version or delete the database file to start fresh.'
    )
  }

  for (let version = current; version < migrations.length; version++) {
    db.transaction(() => {
      db.exec(migrations[version])
      db.pragma(`user_version = ${version + 1}`)
    })()
  }

  return migrations.length
}
