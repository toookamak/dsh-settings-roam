/**
 * 第二阶段的端到端骨架：把一份导出包真的写回另一台机器。
 *
 * 这里不再是「函数返回了什么」，而是「两台机器各自的文件最终长什么样」。
 * 因为第二阶段要回答的问题只有一个是真问题：
 * **在新机器上装回来之后，那台机器的本机配置有没有被换掉？**
 * 那个问题只能通过比对磁盘上的真实文件来回答。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync, chmodSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createSyncService } from '../src/service.js'
import { parsePatchList } from '../src/yaml-loader.js'
import { hashContent } from '../src/export.js'
import { tmpDir } from '../support/tmp-dir.js'

// 来源机器的配置：一项公共（llm-pi-ai），两项本机（webserver、ui-theme）
const SOURCE_PATCH = [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      demo:',
  '        apiKeyEnv: DEMO_KEY',
  '- id: webserver',
  '  config:',
  "    host: '10.0.0.9'",
  '- id: ui-theme',
  '  config:',
  '    preference: dark',
  '',
].join('\n')

// 目标机器的配置：它有自己的监听地址与主题。导入之后这两个值必须原样留着。
const TARGET_PATCH = [
  '- id: webserver',
  '  config:',
  "    host: '127.0.0.1'",
  '- id: ui-theme',
  '  config:',
  '    preference: light',
  '',
].join('\n')

function fakeBackend(initial = {}) {
  const files = { ...initial }
  return {
    files,
    async ensureReady() {},
    async pull() {},
    async push() { return { committed: true } },
    async readFile(path) { return files[path] ?? null },
    async writeFile(path, content) { files[path] = content },
    describe() { return '假后端' },
  }
}

/** 造一台机器：数据根目录 + profile 的 patch 文件 + 技能目录。 */
function machine(prefix, { patch, skills = {} } = {}) {
  const root = tmpDir(prefix)
  const dshRoot = join(root, '.dsh')
  const profileName = 'web'
  const patchFile = join(dshRoot, 'profiles', profileName, 'cordis.patch.yml')
  mkdirSync(dirname(patchFile), { recursive: true })
  if (patch !== undefined) writeFileSync(patchFile, patch)
  const skillsRoot = join(dshRoot, 'skills')
  for (const [relPath, spec] of Object.entries(skills)) {
    const target = join(skillsRoot, relPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, spec.content)
    if (spec.executable === true) chmodSync(target, 0o755)
  }
  return { root, dshRoot, skillsRoot, patchFile, profileName }
}

/** 在来源机器上导出一次，返回包目录。 */
async function exportFrom(source, stamp = '20261015-000000') {
  const service = createSyncService({
    backend: fakeBackend(),
    workDir: join(source.root, 'cloud'),
    dshRoot: source.dshRoot,
    skillsRoot: source.skillsRoot,
  })
  const plan = await service.preparePush({
    generatedBy: 'source-machine',
    exportRoot: join(source.root, 'export'),
    stamp,
  })
  assert.equal(plan.exported?.error, undefined, `导出不该失败：${plan.exported?.error}`)
  return plan.exported.exportPath
}

function targetService(target) {
  return createSyncService({
    backend: fakeBackend(),
    workDir: join(target.root, 'cloud'),
    dshRoot: target.dshRoot,
    skillsRoot: target.skillsRoot,
  })
}

// ─── 本机项必须留在本机 ──────────────────────────────────────────
// 这是整个插件存在的理由。它不是「顺手不写」，而是必须逐条可查地不写。

test('导入只写回公共项，目标机器的监听地址与主题保持自己的值', async () => {
  const source = machine('imp-src-', { patch: SOURCE_PATCH })
  const packageDir = await exportFrom(source)

  const target = machine('imp-dst-', { patch: TARGET_PATCH })
  const service = targetService(target)

  const plan = await service.prepareImport({ packageDir })
  assert.deepEqual(plan.patchRows.map(row => row.id), ['llm-pi-ai'], '计划里只应有公共条目')

  // 本机这一侧必须逐条说清「没动它、为什么」。导出包本来就不含本机项，
  // 所以这里走的不是「包里被塞了本机项」那条路，而是「告诉用户他的本机配置还在」。
  const keptIds = plan.refused.filter(item => item.source === 'local').map(item => item.name)
  assert.ok(keptIds.includes('webserver'), '本机的 webserver 必须出现在「保持不动」清单里')
  assert.ok(keptIds.includes('ui-theme'), '本机的 ui-theme 必须出现在「保持不动」清单里')
  for (const item of plan.refused) {
    assert.equal(item.reason, 'machine-entry')
    assert.ok(item.explanation.includes('本机'), '理由要说清楚')
  }

  const report = await service.applyImport(plan)

  // 磁盘上的真实结果才是判据
  const rows = parsePatchList(readFileSync(target.patchFile, 'utf8'))
  const byId = new Map(rows.map(row => [row.id, row]))
  assert.deepEqual(byId.get('llm-pi-ai').config.providers.demo, { apiKeyEnv: 'DEMO_KEY' },
    '公共项应当写了进来')
  assert.equal(byId.get('webserver').config.host, '127.0.0.1',
    '目标机器的监听地址必须还是它自己的')
  assert.equal(byId.get('ui-theme').config.preference, 'light',
    '目标机器的主题必须还是它自己的')

  assert.deepEqual(report.applied.map(item => item.name), ['patch:llm-pi-ai'])
  assert.equal(report.needsRestart, true, '写入了配置就应提示重启')
})

test('来源机器的局域网地址不会出现在目标机器的任何文件里', async () => {
  const source = machine('imp-src-', { patch: SOURCE_PATCH })
  const packageDir = await exportFrom(source)

  const target = machine('imp-dst-', { patch: TARGET_PATCH })
  const service = targetService(target)
  await service.applyImport(await service.prepareImport({ packageDir }))

  const written = readFileSync(target.patchFile, 'utf8')
  assert.ok(!written.includes('10.0.0.9'), '来源机器的本机地址不该被写进目标机器')
  assert.ok(written.includes('127.0.0.1'), '目标机器自己的地址必须还在')
})

// ─── 技能文件：内容与可执行位 ────────────────────────────────────

test('导入的技能脚本保留可执行位，普通文件不凭空变成可执行', async () => {
  const source = machine('imp-src-', {
    patch: SOURCE_PATCH,
    skills: {
      'demo/SKILL.md': { content: '# demo\n' },
      'demo/run.sh': { content: '#!/bin/sh\necho hi\n', executable: true },
    },
  })
  const packageDir = await exportFrom(source)

  const target = machine('imp-dst-', { patch: TARGET_PATCH })
  const service = targetService(target)
  const report = await service.applyImport(await service.prepareImport({ packageDir }))

  const script = join(target.skillsRoot, 'demo', 'run.sh')
  const doc = join(target.skillsRoot, 'demo', 'SKILL.md')
  assert.ok(existsSync(script), '技能脚本应当被写回')
  assert.ok(existsSync(doc), '技能文档应当被写回')
  assert.equal(readFileSync(script, 'utf8'), '#!/bin/sh\necho hi\n')
  assert.ok((statSync(script).mode & 0o100) !== 0,
    '可执行位必须重建——脚本在目标机器上要能直接跑')
  assert.equal(statSync(doc).mode & 0o111, 0, '普通文件不该变成可执行')

  assert.ok(report.applied.some(item => item.name === 'skills/demo/run.sh'))
})

// ─── 写入前必须留下可回退的副本 ──────────────────────────────────

test('导入前先备份被覆盖的文件，报告里给出真正装着副本的那一层路径', async () => {
  const source = machine('imp-src-', {
    patch: SOURCE_PATCH,
    skills: { 'demo/SKILL.md': { content: '# 新内容\n' } },
  })
  const packageDir = await exportFrom(source)

  const target = machine('imp-dst-', {
    patch: TARGET_PATCH,
    skills: { 'demo/SKILL.md': { content: '# 旧内容\n' } },
  })
  const service = targetService(target)
  const before = readFileSync(target.patchFile, 'utf8')
  const report = await service.applyImport(await service.prepareImport({ packageDir }))

  assert.notEqual(report.backupPath, '', '本次覆盖了已有文件，必须留下备份')
  assert.ok(existsSync(report.backupPath), '报告里给的路径必须真的存在')

  // 备份里要能找到被覆盖前的原始内容，否则「可回退」只是句话
  const backedUpPatch = join(report.backupPath, join(target.patchFile.replace(/^\//, '')))
  assert.ok(existsSync(backedUpPatch), `备份里应当有 ${backedUpPatch}`)
  assert.equal(readFileSync(backedUpPatch, 'utf8'), before, '备份的应当是覆盖前的内容')
})

test('目标机器上本来没有的文件不产生备份，报告里也不给假的回退路径', async () => {
  const source = machine('imp-src-', { patch: SOURCE_PATCH })
  const packageDir = await exportFrom(source)

  // 目标机器上连 profile 目录都还没有——新机器的真实样子
  const target = machine('imp-dst-')
  const service = targetService(target)
  const report = await service.applyImport(await service.prepareImport({ packageDir }))

  assert.equal(report.backupPath, '', '没有覆盖任何东西时不该凭空造一个备份目录')
  assert.ok(existsSync(target.patchFile), '配置仍应被写出来')
})

// ─── 包不可信时不许写一半 ────────────────────────────────────────

test('包的内容与清单不符时拒绝导入，且一个字节都不写', async () => {
  const source = machine('imp-src-', { patch: SOURCE_PATCH })
  const packageDir = await exportFrom(source)

  const patchPath = join(packageDir, 'config', 'profile.patch.yml')
  writeFileSync(patchPath, readFileSync(patchPath, 'utf8') + '\n# 事后被改过\n')

  const target = machine('imp-dst-', { patch: TARGET_PATCH })
  const service = targetService(target)
  const before = readFileSync(target.patchFile, 'utf8')

  await assert.rejects(
    () => service.prepareImport({ packageDir }),
    error => {
      assert.equal(error.code, 'package-invalid')
      assert.ok(error.message.includes('与清单不符'), '要说清是校验不过，而不是泛泛的读取失败')
      return true
    },
  )
  assert.equal(readFileSync(target.patchFile, 'utf8'), before, '校验不过时本机不该有任何变化')
})

test('没有清单的目录不被当作导入包', async () => {
  const loose = machine('imp-loose-', { patch: SOURCE_PATCH })
  const service = targetService(machine('imp-dst-', { patch: TARGET_PATCH }))
  await assert.rejects(
    () => service.prepareImport({ packageDir: loose.dshRoot }),
    error => {
      assert.equal(error.code, 'package-invalid')
      assert.ok(error.message.includes('manifest.json'), '要告诉用户缺的是什么')
      return true
    },
  )
})

// ─── prepare 阶段只读（与推送、拉取同一纪律）────────────────────

test('prepareImport 只读，不改本机任何文件', async () => {
  const source = machine('imp-src-', {
    patch: SOURCE_PATCH,
    skills: { 'demo/SKILL.md': { content: '# demo\n' } },
  })
  const packageDir = await exportFrom(source)

  const target = machine('imp-dst-', { patch: TARGET_PATCH })
  const service = targetService(target)
  const before = readFileSync(target.patchFile, 'utf8')
  const plan = await service.prepareImport({ packageDir })

  assert.equal(readFileSync(target.patchFile, 'utf8'), before, 'prepare 不该动本机配置')
  assert.equal(existsSync(join(target.skillsRoot, 'demo', 'SKILL.md')), false,
    'prepare 不该把技能落盘')
  assert.equal(typeof plan.empty, 'boolean', '界面要能据此判断是不是空计划')
  assert.equal(plan.skillsRoot, target.skillsRoot)
  assert.equal(plan.patchFile, target.patchFile)
})

// ─── 报告要说清「有意没写回」的那些 ──────────────────────────────

test('包里被塞进本机项时，在包这一侧就被挡下，不进计划', async () => {
  const source = machine('imp-src-', { patch: SOURCE_PATCH })
  const packageDir = await exportFrom(source)

  // 手工把一条本机项塞进包里，并把清单的校验值一并改对——
  // 模拟「包本身没问题，但内容不该写回本机」这一情形。
  const rel = 'config/profile.patch.yml'
  const abs = join(packageDir, rel)
  const tampered = readFileSync(abs, 'utf8') + "- id: webserver\n  config:\n    host: '10.0.0.9'\n"
  writeFileSync(abs, tampered)
  const manifestPath = join(packageDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const record = manifest.files.find(item => item.path === rel)
  record.bytes = Buffer.byteLength(tampered, 'utf8')
  record.sha256 = hashContent(tampered)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const target = machine('imp-dst-', { patch: TARGET_PATCH })
  const service = targetService(target)
  const plan = await service.prepareImport({ packageDir })

  assert.deepEqual(plan.patchRows.map(row => row.id), ['llm-pi-ai'],
    '被塞进来的本机项不许进写入计划')
  const packageRefused = plan.refused.filter(item => item.source !== 'local')
  assert.equal(packageRefused.length, 1)
  assert.equal(packageRefused[0].reason, 'machine-entry')
  assert.ok(packageRefused[0].explanation.includes('本机'))

  await service.applyImport(plan)
  const rows = parsePatchList(readFileSync(target.patchFile, 'utf8'))
  assert.equal(rows.find(row => row.id === 'webserver').config.host, '127.0.0.1',
    '即使包里有，目标机器也不该被改成 10.0.0.9')
})

test('报告里能看出哪些项有意没写回，以及每一条的具体理由', async () => {
  const source = machine('imp-src-', { patch: SOURCE_PATCH })
  const packageDir = await exportFrom(source)

  const target = machine('imp-dst-', { patch: TARGET_PATCH })
  const service = targetService(target)
  const report = await service.applyImport(await service.prepareImport({ packageDir }))

  const machineItems = report.skipped.filter(item => item.reason === 'machine-entry')
  assert.equal(machineItems.length, 2, '两项本机配置都应出现在报告里')
  for (const item of machineItems) {
    assert.equal(typeof item.explanation, 'string')
    assert.ok(item.explanation.length > 0)
  }
})

test('导入与导出读的是同一份公共线内容', async () => {
  const source = machine('imp-src-', { patch: SOURCE_PATCH })
  const packageDir = await exportFrom(source)

  const target = machine('imp-dst-', { patch: TARGET_PATCH })
  const service = targetService(target)
  const plan = await service.prepareImport({ packageDir })

  const rows = parsePatchList(readFileSync(join(packageDir, 'config', 'profile.patch.yml'), 'utf8'))
  assert.deepEqual(
    plan.patchRows.map(row => row.id).sort(),
    rows.map(row => row.id).sort(),
    '导入计划里的条目应与包里的一致',
  )
})

test('清理：导入用到的临时目录都登记在案', async () => {
  // 这条不测业务，测的是「用例失败时也不会在 /tmp 里留垃圾」的前提还在。
  const { outstanding } = await import('../support/tmp-dir.js')
  assert.equal(typeof outstanding(), 'number')
})
