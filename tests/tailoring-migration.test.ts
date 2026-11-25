import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { resetDbForTests, getSqlite } from '@/server/db'
import { getResume } from '@/server/resumes'

it('upgrades legacy drafts atomically before source changes and keeps rendered order and overrides', () => {
  resetDbForTests(); const dir=fs.mkdtempSync(path.join(os.tmpdir(),'careerdesk-old-')); process.env.DATA_DIR=dir
  const file = path.join(dir, 'careerdesk.sqlite')
  const old = new Database(file)
  old.pragma('journal_mode = WAL')
  old.pragma('wal_autocheckpoint = 0')
  old.exec(fs.readFileSync('src/server/db/migrations/001_init.sql','utf8')); old.exec(fs.readFileSync('src/server/db/migrations/002_profile_sheet.sql','utf8'))
  old.exec(`CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES ('001_init.sql','t'),('002_profile_sheet.sql','t');
    INSERT INTO profile(id,name,headline,years,location,phone,email,links,summary,education,skills_json,work_experience,photo) VALUES(1,'旧档案','','','','','','','','','[]','','照片');
    UPDATE profile SET skills_json='["SQL",7]';
    INSERT INTO job_targets(id,company,role,updated_at) VALUES('j','旧公司','工程师','t');
    INSERT INTO projects(id,title,status,resume_bullet,updated_at) VALUES('a','项目甲','done','原句甲','t'),('b','项目乙','done','原句乙','t');
    UPDATE projects SET tags_json='invalid json' WHERE id='b';
    INSERT INTO resumes(id,type,job_id,summary,updated_at) VALUES('r','targeted','j','摘要','t');
    INSERT INTO resume_items(id,resume_id,project_id,included,bullet_override,sort_order) VALUES('ia','r','a',1,'手改甲',0),('ib','r','b',1,'',1);`)
  try {
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0)
    getSqlite()
  } finally {
    old.close()
  }
  getSqlite().exec("UPDATE profile SET name='新档案'; DELETE FROM projects WHERE id='a'; UPDATE projects SET title='新标题',resume_bullet='新句子' WHERE id='b'")
  const result=getResume('r')!; expect(result.profile?.name).toBe('旧档案'); expect(result.profile?.photo).toBe('照片'); expect(result.profile?.skills).toEqual(['SQL']); expect(result.projects[0].tags).toEqual([]); expect(result.projects.map(x=>x.title)).toEqual(['项目乙','项目甲']); expect(result.projects[1].bullet).toBe('手改甲'); expect(result.projects[0].bullet).toBe('原句乙')
  const backupDir = path.join(dir, 'backups')
  const [backup] = fs.readdirSync(backupDir)
  const copy = new Database(path.join(backupDir, backup), { readonly: true })
  try {
    expect(copy.prepare('SELECT name FROM profile WHERE id = 1').get()).toEqual({ name: '旧档案' })
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'resume_revisions'").get()).toBeUndefined()
    expect(copy.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 2 })
  } finally {
    copy.close()
  }
  resetDbForTests()
  getSqlite()
  expect(fs.readdirSync(backupDir)).toEqual([backup])
})

it('never exposes a connection after a failed migration, including repeated initialization',()=>{
  resetDbForTests(); const dir=fs.mkdtempSync(path.join(os.tmpdir(),'careerdesk-failed-')); process.env.DATA_DIR=dir
  const old=new Database(path.join(dir,'careerdesk.sqlite'))
  old.exec(fs.readFileSync('src/server/db/migrations/001_init.sql','utf8')); old.exec(fs.readFileSync('src/server/db/migrations/002_profile_sheet.sql','utf8'))
  old.exec(`CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES ('001_init.sql','t'),('002_profile_sheet.sql','t'); CREATE TABLE source_materials(id TEXT);`); old.close()
  expect(()=>getSqlite()).toThrow()
  expect(()=>getSqlite()).toThrow()
  const check=new Database(path.join(dir,'careerdesk.sqlite'),{readonly:true}); expect(check.prepare("SELECT id FROM schema_migrations WHERE id='003_targeted_resume.sql'").get()).toBeUndefined(); expect(check.prepare("SELECT name FROM sqlite_master WHERE name='resume_revisions'").get()).toBeUndefined(); check.close()
})

it('leaves an existing database without a migration table unchanged when pre-upgrade backup fails', () => {
  resetDbForTests()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'careerdesk-no-backup-'))
  process.env.DATA_DIR = dir
  const file = path.join(dir, 'careerdesk.sqlite')
  const old = new Database(file)
  old.exec("CREATE TABLE legacy (name TEXT); INSERT INTO legacy VALUES ('旧数据');")
  old.close()
  fs.writeFileSync(path.join(dir, 'backups'), '阻止创建备份目录')

  expect(() => getSqlite()).toThrow()
  expect(() => getSqlite()).toThrow()
  const check = new Database(file, { readonly: true })
  try {
    expect(check.prepare('SELECT name FROM legacy').get()).toEqual({ name: '旧数据' })
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: 'legacy' }])
  } finally {
    check.close()
  }
})

it('skips a pre-upgrade backup when initializing a fresh database', () => {
  resetDbForTests()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'careerdesk-fresh-'))
  process.env.DATA_DIR = dir
  expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 3 })
  expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false)
})
