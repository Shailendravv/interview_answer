import { describe, it, expect } from 'vitest'
import { runMigrations } from '../src/main/db/migrate'

// better-sqlite3 is rebuilt for Electron's ABI, so it cannot load under plain
// Node; a fake that records exec/pragma calls covers the runner's logic.
function fakeDb(startVersion: number, failOn?: string) {
  let version = startVersion
  const executed: string[] = []
  const db = {
    executed,
    get version() {
      return version
    },
    pragma(source: string) {
      const set = source.match(/^user_version = (\d+)$/)
      if (set) {
        version = Number(set[1])
        return undefined
      }
      return version
    },
    exec(sql: string) {
      if (sql === failOn) throw new Error('boom')
      executed.push(sql)
      return db
    },
    transaction(fn: () => void) {
      return () => {
        const before = { version, count: executed.length }
        try {
          fn()
        } catch (err) {
          version = before.version
          executed.length = before.count
          throw err
        }
      }
    }
  }
  return db
}

describe('runMigrations', () => {
  it('applies every migration to a fresh database and records the version', () => {
    const db = fakeDb(0)
    expect(runMigrations(db as never, ['v1', 'v2'])).toBe(2)
    expect(db.executed).toEqual(['v1', 'v2'])
    expect(db.version).toBe(2)
  })

  it('applies only the migrations newer than the stored version', () => {
    const db = fakeDb(1)
    runMigrations(db as never, ['v1', 'v2', 'v3'])
    expect(db.executed).toEqual(['v2', 'v3'])
    expect(db.version).toBe(3)
  })

  it('is a no-op when the database is current', () => {
    const db = fakeDb(2)
    runMigrations(db as never, ['v1', 'v2'])
    expect(db.executed).toEqual([])
  })

  it('stops at the failing migration and keeps the last good version', () => {
    const db = fakeDb(0, 'v2')
    expect(() => runMigrations(db as never, ['v1', 'v2', 'v3'])).toThrow('boom')
    expect(db.executed).toEqual(['v1'])
    expect(db.version).toBe(1)
  })

  it('refuses a database created by a newer app version', () => {
    const db = fakeDb(5)
    expect(() => runMigrations(db as never, ['v1'])).toThrow(/newer than this app supports/)
  })
})
