import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/server/db/schema'
import { snapshotMissingLegacy } from '@/server/db/legacy-snapshot'

export type AppDatabase = ReturnType<typeof drizzle<typeof schema>>

let sqlite: Database.Database | null = null
let db: AppDatabase | null = null

export function dataDir(): string {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), 'data')
}

export function resetDbForTests(): void {
  sqlite?.close()
  sqlite = null
  db = null
}

export function getSqlite(): Database.Database {
  if (sqlite) return sqlite
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  const connection = new Database(path.join(dir, 'careerdesk.sqlite'))
  try {
    connection.pragma('foreign_keys = ON')
    migrate(connection, dir)
    ensureDefaults(connection)
    sqlite = connection
    return connection
  } catch (error) {
    connection.close()
    throw error
  }
}

export function getDb(): AppDatabase {
  if (!db) db = drizzle(getSqlite(), { schema })
  return db
}

function backUpBeforeMigration(database: Database.Database, dataDirectory: string): void {
  const backupDirectory = path.join(dataDirectory, 'backups')
  fs.mkdirSync(backupDirectory, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = path.join(backupDirectory, `pre-upgrade-${timestamp}-${crypto.randomUUID()}.sqlite`)
  const temporary = `${backup}.tmp`
  try {
    database.prepare('VACUUM INTO ?').run(temporary)
    fs.renameSync(temporary, backup)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

function migrate(database: Database.Database, dataDirectory: string): void {
  const dir = path.join(process.cwd(), 'src/server/db/migrations')
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.sql')).sort()
  const entries = database.prepare("SELECT type, name FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_'").all() as { type: string; name: string }[]
  const applied = new Set(entries.some(entry => entry.type === 'table' && entry.name === 'schema_migrations')
    ? (database.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map(row => row.id)
    : [])
  const pending = files.filter(file => !applied.has(file))
  if (!pending.length) return
  if (entries.length) backUpBeforeMigration(database, dataDirectory)

  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)
  const hasMigration = database.prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
  const insert = database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    database.transaction(() => {
      if (hasMigration.get(file)) return
      database.exec(sql)
      if (file === '003_targeted_resume.sql') snapshotMissingLegacy(database)
      insert.run(file, new Date().toISOString())
    }).immediate()
  }
}

function ensureDefaults(database: Database.Database): void {
  database.prepare(`INSERT INTO profile (
    id, name, headline, years, location, phone, email, links, summary, education, skills_json
  ) VALUES (1, '', '', '', '', '', '', '', '', '', '[]') ON CONFLICT(id) DO NOTHING`).run()
  database.prepare(`INSERT INTO settings (id, sync_interval_days, last_master_sync_at)
    VALUES (1, 7, NULL) ON CONFLICT(id) DO NOTHING`).run()
  const master = database.prepare(`SELECT id FROM resumes WHERE type = 'master'`).get()
  if (!master) {
    database.prepare(`INSERT INTO resumes (id, type, job_id, summary, updated_at) VALUES (?, 'master', NULL, '', ?)`)
      .run(crypto.randomUUID(), new Date().toISOString())
  }
}
