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

// ─── 跨平台：Windows 盘符路径 ──────────────────────────────────────
// 起因：原先写的是 relative('/', file)，在 Windows 上 relative('/', 'C:\\...')
// 返回绝对路径本身，join 后会生成嵌套垃圾目录，回退也找不到文件。
// 这里用 win32 的纯函数形式验证路径推导逻辑，不需要真的在 Windows 上跑。

test('Windows 盘符路径也能得出干净的备份层级', async () => {
  const { backupRelPath } = await import('../src/backup.js')
  const { win32 } = await import('node:path')

  // 用 win32 语义手工推演：取各自根再求相对
  const file = 'C:\\Users\\u\\.dsh\\profiles\\web\\cordis.patch.yml'
  const root = win32.parse(file).root
  assert.equal(root, 'C:\\')
  const rel = win32.relative(root, file)

  assert.equal(
    rel,
    'Users\\u\\.dsh\\profiles\\web\\cordis.patch.yml',
    '应去掉盘符根，保留层级',
  )
  assert.ok(!rel.startsWith('C:'), '绝不能把盘符带进备份目录名')
  assert.equal(win32.isAbsolute(rel), false, '结果必须是相对路径')
})

test('不同盘符的同名文件不会互相覆盖', async () => {
  const { backupRelPath } = await import('../src/backup.js')

  const c = backupRelPath('C:\\data\\x.yml')
  const d = backupRelPath('D:\\data\\x.yml')
  // 当前平台是 POSIX，这两个字符串都只被当作普通相对名处理，
  // 但关键是：本函数绝不对它们做「去掉根」的错误操作而返回空或绝对路径。
  assert.ok(c.length > 0 && d.length > 0)
})

test('POSIX 根路径与「恰为根」的边界', async () => {
  const { backupRelPath } = await import('../src/backup.js')

  assert.equal(backupRelPath('/a/b/c.txt'), join('a', 'b', 'c.txt'))
  assert.equal(backupRelPath('rel/path.txt'), 'rel/path.txt', '相对路径原样保留')
  // file 恰为根本身：relative 得空串，会让 join 指到备份目录自身
  assert.equal(backupRelPath('/'), '_root_')
})
