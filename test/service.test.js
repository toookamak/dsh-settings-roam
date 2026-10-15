import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSyncService } from '../src/service.js'
import { parsePatchList } from '../src/yaml-loader.js'

const PATCH = [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      demo:',
  '        apiKeyEnv: DEMO_KEY',
  '- id: webserver',
  '  config:',
  "    host: '10.0.0.9'",
  '',
].join('\n')

/** 假后端：把文件存在内存里，不碰网络与磁盘。 */
function fakeBackend(initial = {}) {
  const files = { ...initial }
  return {
    files,
    async ensureReady() {},
    async pull() {},
    async push(message) { this.lastPush = message; return { committed: true } },
    async readFile(p) { return files[p] ?? null },
    async writeFile(p, c) { files[p] = c },
    describe() { return '假后端' },
  }
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'roam-svc-'))
  const dshRoot = join(root, '.dsh')
  mkdirSync(dshRoot, { recursive: true })
  writeFileSync(join(dshRoot, 'cordis.patch.yml'), PATCH)
  const skillsRoot = join(dshRoot, 'skills')
  mkdirSync(join(skillsRoot, 'demo'), { recursive: true })
  writeFileSync(join(skillsRoot, 'demo', 'SKILL.md'), '# demo\n')
  return { root, dshRoot, skillsRoot, workDir: join(root, 'cloud') }
}

test('preparePush 组装出云端结构，且不含本机项', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const backend = fakeBackend()
  const service = createSyncService({ backend, workDir, dshRoot, skillsRoot })

  const plan = await service.preparePush({ generatedBy: 'test-machine' })

  assert.deepEqual(backend.files, {}, 'preparePush 不应写后端 —— 确认点之前不许落盘')
  const patchFile = plan.files.find(f => f.path === 'config/profile.patch.yml')
  assert.ok(patchFile, '应产出公共 patch 文件')
  assert.ok(patchFile.content.includes('llm-pi-ai'), '公共条目应被抽出')
  assert.ok(!patchFile.content.includes('10.0.0.9'), '本机 host 绝不能进云端')
  rmSync(root, { recursive: true })
})

test('preparePush 的差异列表供界面展示', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(), workDir, dshRoot, skillsRoot,
  })
  const plan = await service.preparePush({ generatedBy: 'm' })
  assert.ok(Array.isArray(plan.diff), '应给出差异列表')
  assert.ok(typeof plan.summary === 'object', '应给出差异汇总')
  assert.ok(plan.summary.total >= 1, '首次推送应有新增项')
  rmSync(root, { recursive: true })
})

test('confirmPush 才真正写入后端', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const backend = fakeBackend()
  const service = createSyncService({ backend, workDir, dshRoot, skillsRoot })

  const plan = await service.preparePush({ generatedBy: 'm' })
  assert.deepEqual(backend.files, {}, '确认之前后端必须保持原样')

  await service.confirmPush(plan)
  assert.ok(backend.files['config/profile.patch.yml'].includes('llm-pi-ai'))
  assert.ok(backend.files['snapshot.json'].includes('schemaVersion'))
  rmSync(root, { recursive: true })
})

test('技能随推送进入云端', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const backend = fakeBackend()
  const service = createSyncService({ backend, workDir, dshRoot, skillsRoot })
  const plan = await service.preparePush({ generatedBy: 'm' })
  await service.confirmPush(plan)
  assert.equal(backend.files['skills/demo/SKILL.md'], '# demo\n')
  rmSync(root, { recursive: true })
})

test('preparePull 给出与本机的差异，且不修改本机文件', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const remote = fakeBackend({
    'config/profile.patch.yml':
      '- id: llm-pi-ai\n  config:\n    providers:\n      x:\n        apiKeyEnv: X\n',
  })
  const service = createSyncService({ backend: remote, workDir, dshRoot, skillsRoot })

  const before = readFileSync(join(dshRoot, 'cordis.patch.yml'), 'utf8')
  const plan = await service.preparePull()
  const after = readFileSync(join(dshRoot, 'cordis.patch.yml'), 'utf8')

  assert.equal(after, before, 'preparePull 绝不能改本机文件')
  assert.ok(plan.diff.length >= 1, '应给出差异')
  rmSync(root, { recursive: true })
})

test('applyPull 应用配置并出报告，本机值零损伤', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const remote = fakeBackend({
    'config/profile.patch.yml': [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      x:',
      '        apiKeyEnv: X',
      '',
    ].join('\n'),
  })
  const service = createSyncService({ backend: remote, workDir, dshRoot, skillsRoot })

  const plan = await service.preparePull()
  const report = await service.applyPull(plan, { backupRoot: join(root, 'backup') })

  const after = parsePatchList(readFileSync(join(dshRoot, 'cordis.patch.yml'), 'utf8'))
  assert.equal(after.find(r => r.id === 'webserver').config.host, '10.0.0.9', '本机值不得被改')
  assert.ok(after.find(r => r.id === 'llm-pi-ai').config.providers.x, '公共条目应已应用')
  assert.ok(report.backupPath, '报告应含备份位置')
  rmSync(root, { recursive: true })
})

test('报告列出需要补的密钥引用名', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const remote = fakeBackend({
    'config/profile.patch.yml': [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      fresh:',
      '        apiKeyEnv: FRESH_KEY',
      '',
    ].join('\n'),
  })
  const service = createSyncService({ backend: remote, workDir, dshRoot, skillsRoot })
  const plan = await service.preparePull()
  const report = await service.applyPull(plan, { backupRoot: join(root, 'backup') })
  assert.deepEqual(report.needsCredentials, ['FRESH_KEY'], '应指出缺哪个 key')
  rmSync(root, { recursive: true })
})
