import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { exportForReview, safeRelPath, EXPORT_DIRNAME } from '../src/export.js'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'roam-export-'))
  return { root, exportRoot: join(root, EXPORT_DIRNAME) }
}

const FILES = [
  { path: 'config/profile.patch.yml', content: '- id: llm-pi-ai\n' },
  { path: 'config/bundles.json', content: '{}\n' },
  { path: 'skills/demo/SKILL.md', content: '# demo\n' },
]

test('导出把每个文件真实写到磁盘，且内容一致', () => {
  const { root, exportRoot } = sandbox()

  const result = exportForReview({
    files: FILES,
    exportRoot,
    stamp: '2026-10-15-120000',
    generatedAt: '2026-10-15T12:00:00.000Z',
    generatedBy: 'machine-a',
  })

  assert.equal(result.total, 3)
  for (const file of FILES) {
    const dest = join(result.exportPath, file.path)
    assert.ok(existsSync(dest), `${file.path} 应落盘`)
    assert.equal(readFileSync(dest, 'utf8'), file.content, '内容必须逐字一致')
  }
  rmSync(root, { recursive: true })
})

test('导出产出清单与人读概述', () => {
  const { root, exportRoot } = sandbox()

  const result = exportForReview({
    files: FILES,
    exportRoot,
    stamp: 's1',
    generatedAt: '2026-10-15T12:00:00.000Z',
    generatedBy: 'machine-a',
    summary: { add: 2, modify: 1, delete: 0 },
  })

  const manifest = JSON.parse(readFileSync(join(result.exportPath, 'manifest.json'), 'utf8'))
  assert.equal(manifest.total, 3)
  assert.equal(manifest.generatedBy, 'machine-a')
  assert.equal(manifest.files.length, 3)
  // 字节数要真实，不是字符数（中文技能名会差出来）
  assert.equal(
    manifest.files.find(f => f.path === 'skills/demo/SKILL.md').bytes,
    Buffer.byteLength('# demo\n', 'utf8'),
  )

  const overview = readFileSync(join(result.exportPath, '概要.md'), 'utf8')
  assert.match(overview, /本次将同步的内容/)
  assert.match(overview, /新增 2 项/)
  assert.ok(
    overview.includes(result.exportPath),
    '概述必须给出真实路径 —— 用户要据此去打开',
  )
  rmSync(root, { recursive: true })
})

test('概述先说带走了什么，并说明本机项为何没带走', () => {
  const { root, exportRoot } = sandbox()

  const result = exportForReview({ files: FILES, exportRoot, stamp: 's2' })
  const overview = readFileSync(join(result.exportPath, '概要.md'), 'utf8')

  const iTook = overview.indexOf('带走了什么')
  const iLocal = overview.indexOf('本机专属项')
  assert.ok(iTook > 0 && iLocal > iTook, '顺序应是先「带走什么」后「没带走什么」')
  assert.match(overview, /监听地址、主题、工具权限预设、默认模型留在本机/)
  rmSync(root, { recursive: true })
})

test('需要留意的提示会进概述', () => {
  const { root, exportRoot } = sandbox()

  const result = exportForReview({
    files: FILES,
    exportRoot,
    stamp: 's3',
    report: { notices: ['技能清单两路核对不一致：beta 在服务视图里有但目录里没有'] },
  })

  const overview = readFileSync(join(result.exportPath, '概要.md'), 'utf8')
  assert.match(overview, /需要留意/)
  assert.match(overview, /两路核对不一致/)
  rmSync(root, { recursive: true })
})

test('没有差异时不渲染空的差异区块', () => {
  const { root, exportRoot } = sandbox()

  const result = exportForReview({
    files: FILES,
    exportRoot,
    stamp: 's4',
    summary: { add: 0, modify: 0, delete: 0 },
  })

  const overview = readFileSync(join(result.exportPath, '概要.md'), 'utf8')
  assert.ok(!overview.includes('与云端的差异'), '全零的差异区块是噪音')
  rmSync(root, { recursive: true })
})

test('路径穿越与绝对路径都被压平，绝不写到导出目录之外', () => {
  const { root, exportRoot } = sandbox()

  const result = exportForReview({
    files: [
      { path: '../../escaped.txt', content: 'x' },
      { path: '/etc/passwd', content: 'y' },
      { path: 'C:\\Windows\\evil.txt', content: 'z' },
    ],
    exportRoot,
    stamp: 's5',
  })

  // 要点是「实际写到了哪里」，不是「上报了什么名字」。
  // 上报的是逻辑条目名（云端快照仍用原名比对），落盘位置必须被压平。
  const onDisk = readdirSync(result.exportPath)
  for (const name of onDisk) {
    assert.ok(
      existsSync(join(result.exportPath, name)),
      `${name} 应在导出目录内`,
    )
  }
  assert.ok(!existsSync(join(root, 'escaped.txt')), '不得向上跳出一层')
  assert.ok(!existsSync(join(root, 'export', 'passwd')), '绝对路径不得跳出导出根')
  assert.ok(existsSync(join(result.exportPath, 'escaped.txt')), '被压平后落在导出目录内')
  rmSync(root, { recursive: true })
})

test('safeRelPath 的边界行为', () => {
  assert.equal(safeRelPath('a/b.txt'), join('a', 'b.txt'))
  assert.equal(safeRelPath('./a.txt'), 'a.txt')
  assert.equal(isAbsolute(safeRelPath('/abs/path.txt')), false)
  assert.equal(isAbsolute(safeRelPath('C:\\x\\y.txt')), false)
  // 全是 .. 的路径不能返回空串（会让 join 指到目录本身）
  assert.ok(safeRelPath('../..').length > 0)
})

test('重复导出到不同时间戳互不覆盖', () => {
  const { root, exportRoot } = sandbox()

  const a = exportForReview({ files: FILES, exportRoot, stamp: 'a' })
  const b = exportForReview({ files: FILES, exportRoot, stamp: 'b' })

  assert.notEqual(a.exportPath, b.exportPath)
  assert.ok(existsSync(a.exportPath) && existsSync(b.exportPath), '两份都要留着')
  rmSync(root, { recursive: true })
})
