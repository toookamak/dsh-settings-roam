import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
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
