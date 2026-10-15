import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs, buildService } from '../bin/roam.js'
import { tmpDir } from '../support/tmp-dir.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'roam.js')

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

/** 建一个与真实 DSH 布局同构的数据根目录。 */
function sandbox(profiles = ['web']) {
  const root = tmpDir('cli-')
  const dshRoot = join(root, '.dsh')
  for (const name of profiles) {
    const dir = join(dshRoot, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), PATCH)
  }
  const skillsRoot = join(dshRoot, 'skills')
  mkdirSync(join(skillsRoot, 'demo'), { recursive: true })
  writeFileSync(join(skillsRoot, 'demo', 'SKILL.md'), '# demo\n')
  return { root, dshRoot }
}

test('parseArgs 分出命令、位置参数与选项', () => {
  assert.equal(parseArgs([]).command, 'inspect', '不带参数默认 inspect')
  assert.equal(parseArgs(['export']).command, 'export')
  assert.deepEqual(parseArgs(['export', '/tmp/x']).args, ['/tmp/x'])
  assert.equal(parseArgs(['--json', 'inspect']).options.json, true)
  assert.equal(parseArgs(['--dsh-home', '/a']).options.dshHome, '/a')
  assert.equal(parseArgs(['--dsh-home=/b']).options.dshHome, '/b', '等号写法也要支持')
  assert.equal(parseArgs(['--repo=https://x/y.git']).options.repo, 'https://x/y.git')
  assert.equal(parseArgs(['-h']).options.help, true)
})

test('buildService 按数据根目录解析，不依赖环境变量', () => {
  const { root, dshRoot } = sandbox()
  const { service, dshRoot: resolved } = buildService({ dshHome: dshRoot })

  assert.equal(resolved, dshRoot)
  assert.equal(typeof service.prepareInspect, 'function')
  rmSync(root, { recursive: true })
})

test('inspect 能取到真实布局下的配置 —— 第一阶段的核心验收点', async () => {
  const { root, dshRoot } = sandbox()
  const { service } = buildService({ dshHome: dshRoot })

  const info = await service.prepareInspect()

  assert.ok(info.patchExists, '应定位到 profile 下的配置文件')
  assert.equal(info.shared.length, 1)
  assert.equal(info.shared[0].id, 'llm-pi-ai')
  assert.equal(info.machine.length, 1)
  assert.equal(info.machine[0].id, 'webserver')
  assert.equal(info.skills.length, 1)
  rmSync(root, { recursive: true })
})

test('inspect 不需要云端仓库也能用 —— 第一阶段必须离线可用', async () => {
  const { root, dshRoot } = sandbox()
  // 刻意不给 repo：这是没有网络、没有配置云端仓库的初始状态
  const { service } = buildService({ dshHome: dshRoot })

  assert.equal(service.isConfigured(), false, '不该被误判为已配置')
  const info = await service.prepareInspect()
  assert.equal(info.shared.length, 1, '未配置云端也必须能读出配置')
  rmSync(root, { recursive: true })
})

test('export 不需要云端仓库，且真实落盘', async () => {
  const { root, dshRoot } = sandbox()
  const exportRoot = join(root, 'out')
  const { service } = buildService({ dshHome: dshRoot })

  const plan = await service.preparePush({
    generatedBy: 'cli',
    exportRoot,
    stamp: 's1',
  })

  assert.ok(plan.exported, '应产出导出结果')
  assert.equal(plan.exported.error, undefined)
  assert.equal(plan.comparedWithRemote, false, '未配置云端时应如实标注未比对')
  assert.ok(existsSync(join(plan.exported.exportPath, 'config', 'profile.patch.yml')))
  assert.ok(existsSync(join(plan.exported.exportPath, 'manifest.json')))
  rmSync(root, { recursive: true })
})

test('导出的公共配置不含本机项 —— 这是这个项目存在的理由', async () => {
  const { root, dshRoot } = sandbox()
  const exportRoot = join(root, 'out')
  const { service } = buildService({ dshHome: dshRoot })

  const plan = await service.preparePush({ generatedBy: 'cli', exportRoot, stamp: 's2' })
  const patchText = await import('node:fs').then(fs => fs.readFileSync(
    join(plan.exported.exportPath, 'config', 'profile.patch.yml'),
    'utf8',
  ))

  assert.ok(patchText.includes('llm-pi-ai'), '公共条目要带走')
  assert.ok(!patchText.includes('10.0.0.9'), '本机监听地址绝不能带走')
  assert.ok(!patchText.includes('webserver'), '本机条目整体都不该出现')
  rmSync(root, { recursive: true })
})

test('未配置云端仓库时，推送动作给出可行动的说明而不是空指针', async () => {
  const { root, dshRoot } = sandbox()
  const { service } = buildService({ dshHome: dshRoot })

  await assert.rejects(
    () => service.preparePull(),
    /还没配置云端仓库/,
    '拉取必须有云端，缺失时应是明确说明',
  )
  rmSync(root, { recursive: true })
})

// ─── 真进程端到端 ──────────────────────────────────────────────────
// 为什么必须真跑一次进程：模块级测试只覆盖被 import 的函数，
// 而「参数解析对了但没接到命令上」这类缺陷只在 main() 的装配里出现。
// 实测踩过一次：--json 静默失效，不报错，只是照常输出人读格式。

test('真跑 CLI：inspect 输出含关键结论', () => {
  const { root, dshRoot } = sandbox()
  const out = execFileSync(process.execPath, [BIN, '--dsh-home', dshRoot, 'inspect'], {
    encoding: 'utf8',
  })

  assert.match(out, /公共配置条目：1 项/)
  assert.match(out, /llm-pi-ai/)
  assert.match(out, /留在本机的条目：1 项/)
  assert.match(out, /webserver/)
  rmSync(root, { recursive: true })
})

test('真跑 CLI：--json 真的输出 JSON', () => {
  const { root, dshRoot } = sandbox()
  const out = execFileSync(process.execPath, [BIN, '--dsh-home', dshRoot, 'inspect', '--json'], {
    encoding: 'utf8',
  })

  const parsed = JSON.parse(out)
  assert.equal(parsed.shared.length, 1)
  assert.equal(parsed.shared[0].id, 'llm-pi-ai')
  rmSync(root, { recursive: true })
})

test('真跑 CLI：export 落盘并返回结构化结果', () => {
  const { root, dshRoot } = sandbox()
  const outDir = join(root, 'out')
  const out = execFileSync(
    process.execPath,
    [BIN, '--dsh-home', dshRoot, 'export', outDir, '--json'],
    { encoding: 'utf8' },
  )

  const parsed = JSON.parse(out)
  assert.equal(parsed.total, 2, '1 个公共配置 + 1 个技能文件')
  assert.ok(existsSync(join(parsed.exportPath, 'config', 'profile.patch.yml')))
  rmSync(root, { recursive: true })
})

test('真跑 CLI：未知命令退出码为 2，且给出用法提示', () => {
  const result = spawnSync(process.execPath, [BIN, 'not-a-command'], { encoding: 'utf8' })

  assert.equal(result.status, 2, '用法错误用退出码 2 区分于运行失败')
  assert.match(result.stderr, /未知命令/)
  assert.match(result.stderr, /help/)
})

test('真跑 CLI：help 退出码为 0', () => {
  const result = spawnSync(process.execPath, [BIN, 'help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /设置漫游/)
})

// ─── 导入：命令行这一侧也要守住「先看后写」 ──────────────────────

/** 造一台目标机器：它有自己的监听地址。 */
function targetMachine(root) {
  const dshRoot = join(root, 'target')
  const dir = join(dshRoot, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: webserver',
    '  config:',
    "    host: '127.0.0.1'",
    '',
  ].join('\n'))
  return { dshRoot, patchFile: join(dir, 'cordis.patch.yml') }
}

test('真跑 CLI：import 不给目录时退出码为 2，并说明该给什么', () => {
  const result = spawnSync(process.execPath, [BIN, 'import'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /import <目录>/)
})

test('真跑 CLI：import 不加 --yes 时只打印计划，本机一个字节都不动', () => {
  const { root, dshRoot } = sandbox()
  const outDir = join(root, 'out')
  execFileSync(process.execPath, [BIN, '--dsh-home', dshRoot, 'export', outDir], { encoding: 'utf8' })

  const target = targetMachine(root)
  const before = readFileSync(target.patchFile, 'utf8')
  const result = spawnSync(
    process.execPath,
    [BIN, '--dsh-home', target.dshRoot, 'import', outDir],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 0)
  assert.match(result.stdout, /本机还没有任何改动/)
  assert.match(result.stdout, /不会写回本机/)
  assert.equal(readFileSync(target.patchFile, 'utf8'), before, '没加 --yes 就不该写')
  rmSync(root, { recursive: true })
})

test('真跑 CLI：import --yes 写回公共项，目标机器的监听地址保持自己的值', () => {
  const { root, dshRoot } = sandbox()
  const outDir = join(root, 'out')
  execFileSync(process.execPath, [BIN, '--dsh-home', dshRoot, 'export', outDir], { encoding: 'utf8' })

  const target = targetMachine(root)
  const result = spawnSync(
    process.execPath,
    [BIN, '--dsh-home', target.dshRoot, 'import', outDir, '--yes'],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /已写入/)
  assert.match(result.stdout, /备份到/)

  const written = readFileSync(target.patchFile, 'utf8')
  assert.ok(written.includes('llm-pi-ai'), '公共配置应当写了进来')
  assert.ok(written.includes('127.0.0.1'), '目标机器自己的监听地址必须还在')
  assert.ok(!written.includes('10.0.0.9'), '来源机器的地址绝不该被带过来')
  rmSync(root, { recursive: true })
})

test('真跑 CLI：import --json 输出里带 dryRun 标记，便于脚本区分', () => {
  const { root, dshRoot } = sandbox()
  const outDir = join(root, 'out')
  execFileSync(process.execPath, [BIN, '--dsh-home', dshRoot, 'export', outDir], { encoding: 'utf8' })

  const target = targetMachine(root)
  const out = execFileSync(
    process.execPath,
    [BIN, '--dsh-home', target.dshRoot, 'import', outDir, '--json'],
    { encoding: 'utf8' },
  )
  const parsed = JSON.parse(out)
  assert.equal(parsed.dryRun, true)
  assert.ok(parsed.willWrite.includes('patch:llm-pi-ai'))
  assert.ok(parsed.willNotWrite.some(item => item.name === 'webserver'))
  rmSync(root, { recursive: true })
})

test('真跑 CLI：目录里没有导出包时退出码为 1，并说清缺的是什么', () => {
  const { root } = sandbox()
  const empty = join(root, 'not-a-package')
  mkdirSync(empty, { recursive: true })
  const result = spawnSync(process.execPath, [BIN, 'import', empty], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /manifest\.json/)
  rmSync(root, { recursive: true })
})

// ─── push / pull 两个命令的骨架 ────────────────────────────────────────

test('真跑 CLI：push 未配置仓库时说明怎么配，而不是丢一个 git 报错', () => {
  // 没配仓库是正常状态（插件应当「装好待配置」），所以这里要的是一句
  // 用户能照做的话，而不是从 git 里冒出来的原始错误。
  const { root, dshRoot } = sandbox()
  const result = spawnSync(process.execPath, [BIN, '--dsh-home', dshRoot, 'push'], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /还没配置云端仓库/)
  assert.match(result.stderr, /--repo/)
  rmSync(root, { recursive: true })
})

test('真跑 CLI：pull 未配置仓库时同样给出可行动的说明', () => {
  const { root, dshRoot } = sandbox()
  const result = spawnSync(process.execPath, [BIN, '--dsh-home', dshRoot, 'pull'], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /还没配置云端仓库/)
  rmSync(root, { recursive: true })
})

test('push 与 pull 在 help 里都写了「不加 --yes 只算不写」', () => {
  const result = spawnSync(process.execPath, [BIN, 'help'], { encoding: 'utf8' })
  assert.match(result.stdout, /push \[目录\]/)
  assert.match(result.stdout, /pull +从云端拉回本机/)
  assert.match(result.stdout, /不加时只打印计划/)
})

test('真跑 CLI：import 会先报出兼容性检查，插件没装只是提醒', () => {
  const { root, dshRoot } = sandbox()
  const outDir = join(root, 'out')
  execFileSync(process.execPath, [BIN, '--dsh-home', dshRoot, 'export', outDir], { encoding: 'utf8' })

  const target = targetMachine(root)
  const result = spawnSync(
    process.execPath,
    [BIN, '--dsh-home', target.dshRoot, 'import', outDir],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /兼容性检查/)
  assert.match(result.stdout, /本机还没有任何改动/)
  rmSync(root, { recursive: true })
})

test('真跑 CLI：兼容性检查里有拦下的项时，不加 --yes 也给出非零退出码', () => {
  const { root, dshRoot } = sandbox()
  const outDir = join(root, 'out')
  execFileSync(process.execPath, [BIN, '--dsh-home', dshRoot, 'export', outDir], { encoding: 'utf8' })

  const target = targetMachine(root)
  // 目标机上 llm-pi-ai 那条指向别的包。实测约束：loader 遇到 name 不一致时
  // 只记一条日志就跳过，写下去不报错也不生效——所以必须在写之前停下来。
  writeFileSync(target.patchFile, [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-something-else"',
    '  config:',
    '    providers: {}',
    '- id: webserver',
    '  config:',
    "    host: '127.0.0.1'",
    '',
  ].join('\n'))

  const before = readFileSync(target.patchFile, 'utf8')
  const result = spawnSync(
    process.execPath,
    [BIN, '--dsh-home', target.dshRoot, 'import', outDir],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 1, '有拦下的项时不该报成功')
  assert.match(result.stdout, /停 /)
  assert.match(result.stdout, /不会生效/)
  assert.equal(readFileSync(target.patchFile, 'utf8'), before, '拦下时本机一个字节都不该动')
  rmSync(root, { recursive: true })
})
