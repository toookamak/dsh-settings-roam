import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackup, restoreFromBackup } from '../src/backup.js'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'roam-bk-'))
  mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'web', 'cordis.patch.yml'), 'original\n')
  return root
}

test('备份把指定文件复制到带时间戳的目录', () => {
  const root = sandbox()
  const dest = mkdtempSync(join(tmpdir(), 'roam-bkdest-'))
  const info = createBackup({
    files: [join(root, 'profiles', 'web', 'cordis.patch.yml')],
    destRoot: dest,
    stamp: '20261015-120000',
  })
  assert.ok(info.backupPath.includes('20261015-120000'), '备份路径应带时间戳')
  // 备份内按源文件的绝对路径保留层级，回退时才能还原到原位
  assert.ok(existsSync(join(info.backupPath, join(root, 'profiles', 'web', 'cordis.patch.yml'))))
  rmSync(root, { recursive: true }); rmSync(dest, { recursive: true })
})

test('备份不修改原文件', () => {
  const root = sandbox()
  const dest = mkdtempSync(join(tmpdir(), 'roam-bkdest-'))
  createBackup({ files: [join(root, 'profiles', 'web', 'cordis.patch.yml')], destRoot: dest, stamp: 'S' })
  assert.equal(readFileSync(join(root, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), 'original\n')
  rmSync(root, { recursive: true }); rmSync(dest, { recursive: true })
})

test('回退把文件恢复为备份时的内容', () => {
  const root = sandbox()
  const dest = mkdtempSync(join(tmpdir(), 'roam-bkdest-'))
  const target = join(root, 'profiles', 'web', 'cordis.patch.yml')
  const info = createBackup({ files: [target], destRoot: dest, stamp: 'S' })
  writeFileSync(target, 'broken\n')
  restoreFromBackup(info, [target])
  assert.equal(readFileSync(target, 'utf8'), 'original\n')
  rmSync(root, { recursive: true }); rmSync(dest, { recursive: true })
})

test('备份不存在的文件时记录失败而不中断', () => {
  const dest = mkdtempSync(join(tmpdir(), 'roam-bkdest-'))
  const info = createBackup({ files: ['/nonexistent/path/x.yml'], destRoot: dest, stamp: 'S' })
  assert.deepEqual(info.backedUp, [])
  assert.equal(info.failed.length, 1)
  rmSync(dest, { recursive: true })
})
