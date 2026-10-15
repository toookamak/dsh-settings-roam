import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { applyPatchFile, verifyWriteBack, rollbackApplied } from '../src/apply.js'
import { parsePatchList } from '../src/yaml-loader.js'
import { tmpDir } from '../support/tmp-dir.js'

const REMOTE = [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      demo:',
  '        apiKeyEnv: DEMO_KEY',
  '',
].join('\n')

const LOCAL = [
  '- id: webserver',
  '  config:',
  "    host: '10.0.0.9'",
  '- id: ui-theme',
  '  config:',
  '    preference: light',
  '',
].join('\n')

function sandbox() {
  const root = tmpDir('apply-')
  const file = join(root, 'cordis.patch.yml')
  writeFileSync(file, LOCAL)
  return { root, file }
}

test('应用公共条目后，本机条目零损伤', () => {
  const { root, file } = sandbox()
  const result = applyPatchFile({ targetFile: file, sharedRows: parsePatchList(REMOTE) })
  assert.deepEqual(result.warnings, [], '不应有警告')
  const after = parsePatchList(readFileSync(file, 'utf8'))
  assert.ok(after.some(r => r.id === 'llm-pi-ai'), '公共条目应已写入')
  assert.equal(after.find(r => r.id === 'webserver').config.host, '10.0.0.9', '本机值不得被改')
  assert.equal(after.find(r => r.id === 'ui-theme').config.preference, 'light')
  rmSync(root, { recursive: true })
})

test('写后回读校验：内容确实落盘才算成功', () => {
  const { root, file } = sandbox()
  applyPatchFile({ targetFile: file, sharedRows: parsePatchList(REMOTE) })
  const check = verifyWriteBack(file, parsePatchList(REMOTE))
  assert.equal(check.ok, true)
  assert.deepEqual(check.missing, [])
  rmSync(root, { recursive: true })
})

test('写后回读校验能发现缺失的条目', () => {
  const { root, file } = sandbox()
  const check = verifyWriteBack(file, parsePatchList(REMOTE))
  assert.equal(check.ok, false)
  assert.deepEqual(check.missing, ['llm-pi-ai'])
  rmSync(root, { recursive: true })
})

test('应用前自动备份，回退可还原', async () => {
  const { root, file } = sandbox()
  const before = readFileSync(file, 'utf8')
  const result = applyPatchFile({
    targetFile: file,
    sharedRows: parsePatchList(REMOTE),
    backupRoot: join(root, 'backup'),
  })
  assert.ok(result.backup, '应产生备份信息')
  assert.equal(result.backup.backedUp.length, 1)

  const rollback = rollbackApplied(result.backup, file)
  assert.deepEqual(rollback.failed, [])
  assert.equal(readFileSync(file, 'utf8'), before, '回退后应与应用前逐字节一致')
  rmSync(root, { recursive: true })
})

test('目标文件不存在时也能建立（新机器场景）', () => {
  const root = tmpDir('new-')
  const file = join(root, 'cordis.patch.yml')
  const result = applyPatchFile({ targetFile: file, sharedRows: parsePatchList(REMOTE) })
  assert.deepEqual(result.warnings, [])
  const after = parsePatchList(readFileSync(file, 'utf8'))
  assert.deepEqual(after.map(r => r.id), ['llm-pi-ai'])
  rmSync(root, { recursive: true })
})

test('C2：写入产生警告时如实上报，不静默吞掉', () => {
  const { root, file } = sandbox()
  const result = applyPatchFile({
    targetFile: file,
    sharedRows: parsePatchList(REMOTE),
    __forceWarnForTest: true,
  })
  assert.ok(result.warnings.length > 0, '警告必须出现在返回值里')
  assert.equal(result.ok, false, '有警告即视为未完全成功')
  rmSync(root, { recursive: true })
})
