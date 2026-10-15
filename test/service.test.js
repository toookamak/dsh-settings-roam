import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createSyncService } from '../src/service.js'
import { parsePatchList } from '../src/yaml-loader.js'
import { tmpDir } from '../support/tmp-dir.js'

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
  const root = tmpDir('svc-')
  const dshRoot = join(root, '.dsh')
  mkdirSync(dshRoot, { recursive: true })
  // 真实布局：配置在 profiles/<名>/ 下，不在数据根目录下。
  // fixture 必须与真实布局同构，否则「读取路径写错」这类缺陷照不出来——
  // 这正是本轮修掉的一处真实缺陷：原先两边都建在根目录，152 个用例全绿，
  // 而工具对真实数据根只能读到 0 个条目。
  const profileName = 'web'
  const patchFile = join(dshRoot, 'profiles', profileName, 'cordis.patch.yml')
  mkdirSync(dirname(patchFile), { recursive: true })
  writeFileSync(patchFile, PATCH)
  const skillsRoot = join(dshRoot, 'skills')
  mkdirSync(join(skillsRoot, 'demo'), { recursive: true })
  writeFileSync(join(skillsRoot, 'demo', 'SKILL.md'), '# demo\n')
  return { root, dshRoot, skillsRoot, patchFile, profileName, workDir: join(root, 'cloud') }
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

  const before = readFileSync(join(dshRoot, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  const plan = await service.preparePull()
  const after = readFileSync(join(dshRoot, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')

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

  const after = parsePatchList(readFileSync(join(dshRoot, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'))
  assert.equal(after.find(r => r.id === 'webserver').config.host, '10.0.0.9', '本机值不得被改')
  assert.ok(after.find(r => r.id === 'llm-pi-ai').config.providers.x, '公共条目应已应用')
  assert.ok(report.backupPath, '报告应含备份位置')
  // 端到端演练发现的缺陷：报告曾把备份根目录当成备份位置返回，
  // 用户照着这个路径找不到副本。它必须是真正装着副本的那一层。
  assert.notEqual(report.backupPath, join(root, 'backup'), '不能返回备份根目录而非备份本身')
  assert.ok(
    existsSync(join(report.backupPath, join(dshRoot, 'profiles', 'web', 'cordis.patch.yml'))),
    '报告给出的备份路径里应当真的找得到副本',
  )
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

test('未配置后端时，装配不失败——插件能装着但待配置', () => {
  // 真装载验收暴露的缺陷：最初 createSyncService 无条件 assertBackend，
  // 结果 apply 一执行就抛错，整个 Loader 条目不激活。
  // 插件应当能装上，只是还不能同步。
  const { root, dshRoot } = sandbox()
  const service = createSyncService({ dshRoot })
  assert.equal(service.isConfigured(), false, '未配置时应报告未配置')
  assert.equal(typeof service.preparePull, 'function', '服务本身应当可用')
  rmSync(root, { recursive: true })
})

test('未配置后端时调用同步，给出可据以行动的说明而不是空指针', async () => {
  const { root, dshRoot } = sandbox()
  const service = createSyncService({ dshRoot })
  await assert.rejects(
    () => service.preparePull(),
    /还没配置云端仓库/,
    '错误信息要告诉用户去做什么，不能是 undefined is not a function',
  )
  rmSync(root, { recursive: true })
})

test('后端可以是工厂函数，装配时不立即构造', () => {
  // 后端的仓库地址与工作目录只能由用户填，装配阶段拿不到。
  // 允许传工厂，把「怎么建」与「什么时候建」分开。
  const { root, dshRoot } = sandbox()
  let built = 0
  const service = createSyncService({
    dshRoot,
    backend: () => {
      built += 1
      return fakeBackend({})
    },
  })
  assert.equal(built, 0, '装配时不得构造后端')
  assert.equal(service.isConfigured(), true, '工厂能建出来即视为已配置')
  assert.equal(built, 1, '首次询问时才构造一次')
  service.isConfigured()
  assert.equal(built, 1, '结果应缓存，不重复构造')
  rmSync(root, { recursive: true })
})

test('工厂抛错时 isConfigured 返回 false 而不把异常抛出装配', () => {
  const { root, dshRoot } = sandbox()
  const service = createSyncService({
    dshRoot,
    backend: () => { throw new Error('仓库地址不合法') },
  })
  assert.equal(service.isConfigured(), false)
  rmSync(root, { recursive: true })
})

test('缺方法的后端对象仍被挡下，不会带病运行', () => {
  const { root, dshRoot } = sandbox()
  const service = createSyncService({ dshRoot, backend: { pull: () => {} } })
  assert.equal(service.isConfigured(), false, '接口不完整的后端不算已配置')
  rmSync(root, { recursive: true })
})

test('配置后端后 isConfigured 为真，且能正常同步', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const remote = fakeBackend({})
  const service = createSyncService({ backend: remote, dshRoot, skillsRoot, workDir })
  assert.equal(service.isConfigured(), true)
  const plan = await service.preparePush({ bundles: [] })
  assert.ok(plan.diff !== undefined, '配置后应能算出差异')
  rmSync(root, { recursive: true })
})

test('服务暴露数据根目录，供界面与诊断显示', () => {
  const { root, dshRoot } = sandbox()
  const service = createSyncService({ dshRoot })
  assert.equal(service.dshRoot, dshRoot)
  rmSync(root, { recursive: true })
})

// ─── 双通道校验接线（缺口 A）────────────────────────────────────────
// 背景：crossCheckSkills 实现了、有测试，但全仓库零调用点。
// 机制正确却没有接上，等于安全网不在。以下用例锁死「接上了」。

test('推送准备会带上校验通道的结果，并逐个列出差异项', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(),
    workDir,
    dshRoot,
    skillsRoot,
    // 服务视图只认得别的技能：与直读（demo）不一致
    skillService: { snapshot: async () => ({ skills: [{ name: 'other' }], complete: true }) },
  })

  const plan = await service.preparePush({ generatedBy: 'test' })

  assert.equal(plan.skillCheck.checked, true, '接上了校验通道就必须标记已校验')
  assert.equal(plan.skillCheck.consistent, false)
  assert.deepEqual(plan.skillCheck.onlyDirect, ['demo'], '直读有、服务没有')
  assert.deepEqual(plan.skillCheck.onlyService, ['other'], '服务有、直读没有')
  rmSync(root, { recursive: true })
})

test('两路一致时 consistent 为真', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(),
    workDir,
    dshRoot,
    skillsRoot,
    skillService: { snapshot: async () => ({ skills: [{ name: 'demo' }], complete: true }) },
  })

  const plan = await service.preparePush({ generatedBy: 'test' })
  assert.equal(plan.skillCheck.checked, true)
  assert.equal(plan.skillCheck.consistent, true)
  assert.equal(plan.skillCheck.complete, true, 'snapshot.complete 要透传出来')
  rmSync(root, { recursive: true })
})

test('没接校验通道时如实报「没验」，不假装验过', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  const plan = await service.preparePush({ generatedBy: 'test' })
  assert.equal(plan.skillCheck.checked, false)
  assert.equal(plan.skillCheck.consistent, true, '没验就谈不上不一致')
  rmSync(root, { recursive: true })
})

test('校验通道自身抛错不拖垮推送，但留下痕迹', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(),
    workDir,
    dshRoot,
    skillsRoot,
    skillService: { snapshot: async () => { throw new Error('服务暂时不可用') } },
  })

  const plan = await service.preparePush({ generatedBy: 'test' })
  assert.equal(plan.skillCheck.checked, false)
  assert.match(plan.skillCheck.error, /服务暂时不可用/)
  assert.ok(plan.files.length > 0, '校验失败不该让推送准备整体失败')
  rmSync(root, { recursive: true })
})

test('preparePull 同样只读地跑校验', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend({ 'config/profile.patch.yml': PATCH }),
    workDir,
    dshRoot,
    skillsRoot,
    skillService: { snapshot: async () => ({ skills: [{ name: 'demo' }], complete: true }) },
  })

  const plan = await service.preparePull()
  assert.equal(plan.skillCheck.checked, true)
  assert.equal(plan.skillCheck.complete, true)
  rmSync(root, { recursive: true })
})

// ─── 插件名单接线（缺口 D）────────────────────────────────────────
// 背景：collectBundles 与 crossCheckSkills 是同一类缺陷——实现了、有测试、
// 零调用点。第一期的「插件只记名字」在运行时因此是空的。

test('未显式传 bundles 时，自己从 pluginManager 采集', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  let called = 0
  const service = createSyncService({
    backend: fakeBackend(),
    workDir,
    dshRoot,
    skillsRoot,
    pluginManager: () => ({
      async listBundles() {
        called += 1
        return [
          { name: '@deepseek-ai/dsh-foo', official: true, availability: 'installation' },
          { name: 'someone-bar', official: false, availability: 'profile' },
        ]
      },
    }),
  })

  const plan = await service.preparePush({ generatedBy: 'test' })

  const bundlesFile = plan.files.find(f => f.path === 'config/bundles.json')
  assert.ok(bundlesFile, '采集成功后应产出名单文件')
  const parsed = JSON.parse(bundlesFile.content)
  assert.deepEqual(parsed.official, ['@deepseek-ai/dsh-foo'])
  assert.deepEqual(parsed.thirdParty, ['someone-bar'])
  assert.equal(called >= 1, true, '采集口应被调用')
  rmSync(root, { recursive: true })
})

test('拿不到 pluginManager 时不写名单文件 —— 区分「没有名单」与「名单是空的」', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  const plan = await service.preparePush({ generatedBy: 'test' })
  assert.equal(
    plan.files.find(f => f.path === 'config/bundles.json'),
    undefined,
    '空名单会覆盖云端真实名单，因此宁可不写',
  )
  rmSync(root, { recursive: true })
})

test('pluginManager 尚未就绪（返回 undefined）时不写名单文件', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(),
    workDir,
    dshRoot,
    skillsRoot,
    pluginManager: () => undefined,
  })

  const plan = await service.preparePush({ generatedBy: 'test' })
  assert.equal(plan.files.find(f => f.path === 'config/bundles.json'), undefined)
  rmSync(root, { recursive: true })
})

test('采集抛错不拖垮推送', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(),
    workDir,
    dshRoot,
    skillsRoot,
    pluginManager: () => ({ async listBundles() { throw new Error('还没就绪') } }),
  })

  const plan = await service.preparePush({ generatedBy: 'test' })
  assert.ok(plan.files.length > 0, '采集失败不该让推送准备整体失败')
  assert.equal(plan.files.find(f => f.path === 'config/bundles.json'), undefined)
  rmSync(root, { recursive: true })
})

test('调用方显式传入的 bundles 优先于采集结果', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(),
    workDir,
    dshRoot,
    skillsRoot,
    pluginManager: () => ({
      async listBundles() { return [{ name: 'collected', official: true, availability: 'installation' }] },
    }),
  })

  const plan = await service.preparePush({
    generatedBy: 'test',
    bundles: { official: ['explicit'], thirdParty: [] },
  })
  const parsed = JSON.parse(plan.files.find(f => f.path === 'config/bundles.json').content)
  assert.deepEqual(parsed.official, ['explicit'], '显式传入应覆盖采集')
  rmSync(root, { recursive: true })
})

// ─── 文件确实落出来（导出到磁盘）────────────────────────────────────
// 背景：推送此前是「内存里转一圈就写云端」，用户看不到究竟带走了什么。

test('给了 exportRoot 就把待同步内容真实落到磁盘', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const exportRoot = join(root, 'export')
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  const plan = await service.preparePush({
    generatedBy: 'machine-a',
    exportRoot,
    stamp: 's1',
  })

  assert.ok(plan.exported, '应产出导出结果')
  assert.equal(plan.exported.error, undefined)
  assert.ok(existsSync(join(plan.exported.exportPath, 'config', 'profile.patch.yml')))
  assert.ok(existsSync(join(plan.exported.exportPath, '概要.md')))
  rmSync(root, { recursive: true })
})

test('不给 exportRoot 就不导出 —— 默认只读，不擅自写盘', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  const plan = await service.preparePush({ generatedBy: 'test' })
  assert.equal(plan.exported, null)
  rmSync(root, { recursive: true })
})

test('导出失败不阻断推送 —— 导出是给人看的副本', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  // 把 exportRoot 指到一个「是文件不是目录」的路径，制造必然失败
  const blocked = join(root, 'not-a-dir')
  writeFileSync(blocked, 'x')
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  const plan = await service.preparePush({
    generatedBy: 'test',
    exportRoot: blocked,
    stamp: 's1',
  })

  assert.ok(plan.exported.error, '应记录失败原因')
  assert.ok(plan.files.length > 0, '推送准备本身仍应成功')
  rmSync(root, { recursive: true })
})

test('导出的公共配置与本机项隔离 —— 局域网地址不落进导出', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const exportRoot = join(root, 'export')
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  const plan = await service.preparePush({ generatedBy: 'machine-a', exportRoot, stamp: 's2' })
  const patchText = readFileSync(
    join(plan.exported.exportPath, 'config', 'profile.patch.yml'),
    'utf8',
  )

  assert.ok(patchText.includes('llm-pi-ai'), '公共条目应被带走')
  assert.ok(!patchText.includes('10.0.0.9'), '本机监听地址绝不能出现在导出里')
  rmSync(root, { recursive: true })
})

// ─── profile 解析（本轮修掉的一处真实缺陷）────────────────────────────
// 缺陷：原实现假设配置在 <dshRoot>/cordis.patch.yml，
// 而 DSH 的真实布局是 <dshRoot>/profiles/<名>/cordis.patch.yml。
// 后果：对真实数据根运行 inspect 读到 0 个条目——用户明明配了东西，工具说没有。
// 教训：fixture 与真实布局不同构时，测试再绿也不代表能用。

test('按真实布局从 profiles/<名>/ 读配置，而不是数据根目录', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  const info = await service.prepareInspect()

  assert.ok(info.patchExists, '应找到 profile 下的配置文件')
  assert.equal(info.shared.length, 1, '应读到 1 个公共条目')
  assert.equal(info.shared[0].id, 'llm-pi-ai')
  assert.ok(info.patchFile.includes('profiles'), '路径应含 profiles 段')
  rmSync(root, { recursive: true })
})

test('只有一个 profile 时自动选它 —— 用户不必知道配置在哪个 profile 里', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  const info = await service.prepareInspect()
  assert.equal(info.shared.length, 1, '未显式指定也能读到')
  rmSync(root, { recursive: true })
})

test('存在多个 profile 且未指定时报错，不擅自猜一个', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  // 再建一个 profile，模拟同时存在 web 与 desktop
  const other = join(dshRoot, 'profiles', 'desktop')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'cordis.patch.yml'), PATCH)
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  await assert.rejects(
    () => service.prepareInspect(),
    /发现多个 profile/,
    '猜错会写坏另一个 profile 的配置，必须报错让用户指定',
  )
  rmSync(root, { recursive: true })
})

test('显式指定 profileName 时按指定的读，不受其它 profile 干扰', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const other = join(dshRoot, 'profiles', 'desktop')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'cordis.patch.yml'), '- id: something-else\n  config: {}\n')

  const service = createSyncService({
    backend: fakeBackend(), workDir, dshRoot, skillsRoot, profileName: 'desktop',
  })
  const info = await service.prepareInspect()

  assert.equal(info.shared.length + info.machine.length + info.excludedIds.length, 1)
  assert.ok(!info.shared.some(r => r.id === 'llm-pi-ai'), '不该读到 web 那个 profile 的条目')
  rmSync(root, { recursive: true })
})

test('一个 profile 都没有时给出可行动的说明', async () => {
  const root = tmpDir('svc-empty-')
  const dshRoot = join(root, '.dsh')
  mkdirSync(dshRoot, { recursive: true })
  const service = createSyncService({ backend: fakeBackend(), dshRoot })

  await assert.rejects(() => service.prepareInspect(), /没有在 .*找到任何 profile/)
  rmSync(root, { recursive: true })
})

// ─── 导入目录与「包里有没有东西」（第二阶段）──────────────────────

test('没配过目录时，导入默认去找导出的那个位置 —— 同机导出再导入不必先想路径', () => {
  const { dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  assert.equal(service.defaultImportRoot(), service.defaultExportRoot())
})

test('设置页填了导入目录就用它', () => {
  const { dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(), workDir, dshRoot, skillsRoot, importRoot: join(dshRoot, 'from-usb'),
  })

  assert.equal(service.defaultImportRoot(), join(dshRoot, 'from-usb'))
})

test('导入目录还没建时，describeImportSource 也不能抛 —— 打开设置页是正常操作', () => {
  const { dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(), workDir, dshRoot, skillsRoot, importRoot: join(dshRoot, 'never'),
  })
  const info = service.describeImportSource()

  assert.equal(info.available, false)
  assert.ok(info.errors.length > 0, '失败也要给一句能显示的话')
  assert.equal(info.resolved, null)
})

test('导出过的包能被 describeImportSource 认出来，并报出是谁导的、有多少文件', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })
  const plan = await service.preparePush({ exportRoot: join(root, 'out'), generatedBy: 'workstation' })

  const info = service.describeImportSource({ packageDir: plan.exported.exportPath })
  assert.equal(info.available, true, info.errors.join('; '))
  assert.equal(info.generatedBy, 'workstation')
  assert.ok(info.fileCount > 0)
  assert.equal(info.resolved, plan.exported.exportPath)
})

test('prepareImport 不给目录时走默认导入目录，而不是报「缺参数」', async () => {
  const { dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(), workDir, dshRoot, skillsRoot, importRoot: join(dshRoot, 'never'),
  })

  await assert.rejects(
    () => service.prepareImport({}),
    // 默认目录还不存在时，报的应当是「那个目录里没有包」，而不是「你没给目录」
    error => !/packageDir/.test(String(error.message)),
  )
})

// ─── 配置必须现读，不能在装配时读一次存起来 ─────────────────────────────

test('用户改了设置，服务必须立刻用上新值，不需要重启插件', () => {
  // DSH 改配置是原地更新运行中的 config 对象（config-editor 写盘前就
  // resolveConfig 了），插件不会被重新 apply。装配时把值拷成常量，
  // 就会表现为「设置页填了、显示已保存、实际不生效」——界面上一点报错都没有，
  // 只有真去用一次（比如填了导入目录再点导入）才看得出来。
  let exportRoot = '/one'
  let importRoot = '/two'
  const service = createSyncService({
    dshRoot: '/tmp/roam-live-root',
    options: {
      exportRoot: { get: () => exportRoot },
      importRoot: { get: () => importRoot },
      profileName: { get: () => '' },
    },
  })

  assert.equal(service.defaultExportRoot(), '/one')
  assert.equal(service.defaultImportRoot(), '/two')

  exportRoot = '/three'
  importRoot = '/four'

  assert.equal(service.defaultExportRoot(), '/three', '改了导出目录必须立刻生效')
  assert.equal(service.defaultImportRoot(), '/four', '改了导入目录必须立刻生效')
})

test('留空的选项回到默认位置，而不是变成空字符串', () => {
  // 空字符串是「用户填了但填的是空白」，不是「没填」。混在一起会让
  // 默认目录失效，进而让导入去找一个叫空串的目录。
  const service = createSyncService({
    dshRoot: '/tmp/roam-live-root',
    options: { exportRoot: { get: () => '' }, importRoot: { get: () => '   ' } },
  })
  assert.equal(service.defaultExportRoot(), '/tmp/roam-live-root/settings-roam/export')
  assert.equal(service.defaultImportRoot(), '/tmp/roam-live-root/settings-roam/export')
})

// ─── 拉取要把技能也带回来 ─────────────────────────────────────────────

test('拉取会把云端的技能文件也落到本机，而不是只带配置', async () => {
  // 曾经的真实缺陷：preparePull 只读了 config/profile.patch.yml，
  // 技能一个都没读。于是「拉取」把供应商定义带回来了、技能没带回来，
  // 而报告上一个字都没提——看起来像技能本来就不同步。
  const s = sandbox()
  {
    const backend = fakeBackend({
      'config/profile.patch.yml': [
        '- id: llm-pi-ai',
        '  config:',
        '    providers: {}',
        '',
      ].join('\n'),
      'snapshot.json': JSON.stringify({
        entries: [
          { path: 'config/profile.patch.yml', kind: 'config' },
          { path: 'skills/demo-skill/SKILL.md', kind: 'skill', executable: false },
          { path: 'skills/tool/run.sh', kind: 'skill', executable: true },
        ],
      }),
      'skills/demo-skill/SKILL.md': '# 从云端来的\n',
      'skills/tool/run.sh': '#!/bin/sh\necho hi\n',
    })
    const service = createSyncService({ dshRoot: s.dshRoot, backend, profileName: 'web' })

    const plan = await service.preparePull()
    assert.equal(plan.remoteSkillFiles.length, 2, '云端清单里的技能文件都要被读出来')

    // 预览阶段一个字节都不能写。
    assert.equal(existsSync(join(s.dshRoot, 'skills', 'demo-skill', 'SKILL.md')), false)

    const report = await service.applyPull(plan, { backupRoot: join(s.dshRoot, 'backups') })

    assert.equal(readFileSync(join(s.dshRoot, 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), '# 从云端来的\n')
    assert.ok(report.applied.some(item => item.name === 'skills/demo-skill/SKILL.md'),
      `报告里要能看出技能也写了：${report.applied.map(i => i.name).join(', ')}`)
    // 可执行位必须跟着内容一起落，否则技能里的脚本在新机器上会静默失效。
    const mode = statSync(join(s.dshRoot, 'skills', 'tool', 'run.sh')).mode & 0o777
    assert.equal(mode, 0o755, `可执行位应当是 755，实际 ${mode.toString(8)}`)
  }
})

test('拉取不会删掉本机独有的技能', async () => {
  const s = sandbox()
  {
    mkdirSync(join(s.dshRoot, 'skills', 'local-only'), { recursive: true })
    writeFileSync(join(s.dshRoot, 'skills', 'local-only', 'SKILL.md'), '本机自己的\n')

    const backend = fakeBackend({
      'snapshot.json': JSON.stringify({ entries: [{ path: 'skills/cloud/SKILL.md' }] }),
      'skills/cloud/SKILL.md': '云端的\n',
    })
    const service = createSyncService({ dshRoot: s.dshRoot, backend, profileName: 'web' })
    const plan = await service.preparePull()
    await service.applyPull(plan, { backupRoot: join(s.dshRoot, 'backups') })

    assert.equal(
      readFileSync(join(s.dshRoot, 'skills', 'local-only', 'SKILL.md'), 'utf8'),
      '本机自己的\n',
      '本机独有的技能不该被云端覆盖掉',
    )
  }
})

test('拉取准备会带出兼容性检查 —— 恢复前先知道哪些项不会生效', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const backend = fakeBackend({
    'config/profile.patch.yml': [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      demo:',
      '        apiKeyEnv: DEMO_KEY',
      '',
    ].join('\n'),
    'config/bundles.json': JSON.stringify({ official: [], thirdParty: ['dshmarket'] }),
  })
  const service = createSyncService({
    backend, workDir, dshRoot, skillsRoot,
    pluginManager: { async listBundles() { return [] } },
  })

  const plan = await service.preparePull()

  assert.ok(plan.compat, '拉取准备必须带出兼容性检查结果')
  assert.equal(plan.compat.blocked, false, '插件没装只是提醒，不该拦住整次拉取')
  const missing = plan.compat.items.find(i => i.code === 'plugin-missing')
  assert.ok(missing, '插件名单里有而本机没装的，应被单独列出来')
  assert.equal(missing.level, 'warn')
  rmSync(root, { recursive: true })
})

test('兼容性检查里有拦下的项时，拉取会拒绝写入而不是默默跳过', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const backend = fakeBackend({
    // name 与本机那条 llm-pi-ai 不一致：loader 会静默跳过，写了等于没写。
    'config/profile.patch.yml': [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai-renamed"',
      '  config:',
      '    providers: {}',
      '',
    ].join('\n'),
  })
  const service = createSyncService({ backend, workDir, dshRoot, skillsRoot })

  const plan = await service.preparePull()
  assert.equal(plan.compat.blocked, true)

  await assert.rejects(
    () => service.applyPull(plan, { backupRoot: join(root, 'backup') }),
    err => {
      assert.equal(err.code, 'compat-blocked')
      assert.match(err.message, /llm-pi-ai/)
      assert.match(err.message, /不会生效/)
      return true
    },
  )
  rmSync(root, { recursive: true })
})

test('导入包里的插件本机没装时，检查给出提醒但不拦写入', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({
    backend: fakeBackend(), workDir, dshRoot, skillsRoot,
    pluginManager: { async listBundles() { return [] } },
  })

  // 造一个含第三方插件的导出包。
  const packageDir = join(root, 'pkg')
  mkdirSync(join(packageDir, 'config'), { recursive: true })
  writeFileSync(join(packageDir, 'config', 'profile.patch.yml'), [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers: {}',
    '',
  ].join('\n'))
  writeFileSync(join(packageDir, 'config', 'bundles.json'), JSON.stringify({ official: [], thirdParty: ['dshmarket'] }))
  const { hashContent } = await import('../src/export.js')
  const patchContent = readFileSync(join(packageDir, 'config', 'profile.patch.yml'), 'utf8')
  const bundlesContent = readFileSync(join(packageDir, 'config', 'bundles.json'), 'utf8')
  writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    generatedBy: 'other-machine',
    total: 2,
    files: [
      { path: 'config/profile.patch.yml', bytes: Buffer.byteLength(patchContent), sha256: hashContent(patchContent) },
      { path: 'config/bundles.json', bytes: Buffer.byteLength(bundlesContent), sha256: hashContent(bundlesContent) },
    ],
  }))

  const plan = await service.prepareImport({ packageDir })
  assert.ok(plan.compat, '导入准备也要带出同一份检查')
  assert.equal(plan.compat.blocked, false)
  assert.ok(plan.compat.items.some(i => i.code === 'plugin-missing'))
  rmSync(root, { recursive: true })
})

test('配置编辑：只读地算出改完的样子，不动本机文件', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })
  const patchFile = join(dshRoot, 'profiles', 'web', 'cordis.patch.yml')
  const before = readFileSync(patchFile, 'utf8')

  const plan = await service.prepareEdit({
    id: 'llm-pi-ai',
    set: { 'providers.demo.apiKeyEnv': 'RENAMED_KEY' },
  })

  assert.equal(plan.id, 'llm-pi-ai')
  assert.equal(plan.after.providers.demo.apiKeyEnv, 'RENAMED_KEY')
  assert.equal(plan.before.providers.demo.apiKeyEnv, 'DEMO_KEY')
  assert.deepEqual(plan.changed.map(c => c.path), ['providers.demo.apiKeyEnv'])
  assert.equal(readFileSync(patchFile, 'utf8'), before, '算出计划不该动本机')
  rmSync(root, { recursive: true })
})

test('配置编辑：写回后本机项一个字节不动，且能给出备份路径', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  const plan = await service.prepareEdit({ id: 'llm-pi-ai', set: { 'providers.demo.baseURL': 'https://new/v1' } })
  const result = await service.applyEdit(plan, { backupRoot: join(root, 'backup') })

  assert.deepEqual(result.applied, ['llm-pi-ai'])
  assert.ok(result.backupPath !== '', '改配置前必须能回退')
  assert.ok(existsSync(result.backupPath), '备份路径要真实存在')

  const written = readFileSync(join(dshRoot, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(written, /https:\/\/new\/v1/)
  // 本机配置（监听地址那条）必须原样还在。
  assert.match(written, /- id: webserver/)
  assert.match(written, /10\.0\.0\.9/)
  rmSync(root, { recursive: true })
})

test('配置编辑：新增字段默认按字符串写，不偷偷替用户猜类型', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  // 本机没有这个字段，就没有原类型可参照。默认当字符串是刻意的：
  // 把 '3' 猜成数字看着贴心，实际会在别的字段上把 '0123' 变成 123。
  const guess = await service.prepareEdit({ id: 'llm-pi-ai', set: { 'providers.demo.retries': '3' } })
  assert.equal(guess.after.providers.demo.retries, '3')

  // 明确指定类型时才按数字写。
  const typed = await service.prepareEdit({
    id: 'llm-pi-ai',
    set: { 'providers.demo.retries': '3' },
    types: { 'providers.demo.retries': 'number' },
  })
  assert.equal(typed.after.providers.demo.retries, 3)

  // 已经在配置里的字段则按它原本的类型解析。
  const { root: root2, dshRoot: dshRoot2, skillsRoot: skillsRoot2, workDir: workDir2 } = sandbox()
  const service2 = createSyncService({ backend: fakeBackend(), workDir: workDir2, dshRoot: dshRoot2, skillsRoot: skillsRoot2 })
  await assert.rejects(
    () => service2.prepareEdit({ id: 'llm-pi-ai', set: { 'providers.demo.apiKeyEnv': 'x' }, types: { 'providers.demo.apiKeyEnv': 'number' } }),
    err => {
      assert.equal(err.code, 'edit-invalid')
      assert.match(err.message, /数字/)
      return true
    },
  )
  rmSync(root, { recursive: true })
  rmSync(root2, { recursive: true })
})

test('配置编辑：指定一个本机没有的条目时，说清有哪些可选', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  await assert.rejects(
    () => service.prepareEdit({ id: 'not-here', set: { a: '1' } }),
    err => {
      assert.equal(err.code, 'entry-not-found')
      assert.match(err.message, /llm-pi-ai/, '要把可选的列出来')
      return true
    },
  )
  rmSync(root, { recursive: true })
})

test('配置编辑：本机项不在可编辑列表里 —— 它们本来就不参与同步', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const service = createSyncService({ backend: fakeBackend(), workDir, dshRoot, skillsRoot })

  const entries = service.listEditableEntries()
  const ids = entries.map(e => e.id)
  assert.ok(ids.includes('llm-pi-ai'))
  assert.ok(!ids.includes('webserver'), '本机项不该出现在可编辑列表里')
  assert.ok(entries[0].fields.some(f => f.path === 'providers.demo.apiKeyEnv'))
  rmSync(root, { recursive: true })
})
