import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../support/tmp-dir.js'
import { hashContent, exportForReview } from '../src/export.js'
import {
  resolvePackageDir,
  readPackage,
  validatePackage,
  planImport,
  isEmptyPlan,
  skillTargetPath,
  MANIFEST_FILENAME,
  SUPPORTED_SCHEMA_VERSION,
} from '../src/import.js'

/**
 * 造一份导出包。
 *
 * 刻意**不用** exportForReview 来造：那样测的是「导出与导入互相自洽」，
 * 而不是「导入能认出什么样的包」。这里手写出包，才能造出本程序**不会**导出的
 * 内容（本机条目、不认识的路径、被改过的文件），而那正是最需要被挡住的情形。
 */
function makePackage(files, options = {}) {
  const root = tmpDir('pkg-')
  const dir = join(root, options.name ?? '20261015-120000')
  mkdirSync(dir, { recursive: true })

  const manifestFiles = []
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    manifestFiles.push({
      path,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: hashContent(content),
    })
  }

  const manifest = options.rawManifest ?? {
    schemaVersion: options.schemaVersion ?? SUPPORTED_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? '2026-10-15T04:00:00.000Z',
    generatedBy: options.generatedBy ?? 'test-machine',
    total: manifestFiles.length,
    files: options.filesOverride ?? manifestFiles,
  }
  writeFileSync(
    join(dir, MANIFEST_FILENAME),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
  )
  return { root, dir }
}

const SHARED_PATCH = [
  '# 由设置漫游生成，来源：settings-roam',
  '- id: llm-pi-ai',
  '  name: llm-pi-ai',
  '  config:',
  '    providers:',
  '      xiaomi:',
  '        apiKeyEnv: XIAOMI_API_KEY',
  '',
].join('\n')

// ── resolvePackageDir ────────────────────────────────────────────────

test('目录本身就是包时，原样返回', () => {
  const { dir } = makePackage({ 'config/profile.patch.yml': SHARED_PATCH })
  assert.equal(resolvePackageDir(dir), dir)
})

test('给出导出根目录时，选最新的一次导出', () => {
  const root = tmpDir('pkgs-')
  for (const name of ['20261014-090000', '20261015-163602', '20261013-235959']) {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, MANIFEST_FILENAME), '{}')
  }
  assert.equal(resolvePackageDir(root), join(root, '20261015-163602'))
})

test('目录里没有任何导出包时给出可据以行动的说明', () => {
  const root = tmpDir('emptypkg-')
  assert.throws(
    () => resolvePackageDir(root),
    /manifest\.json/,
  )
})

test('目录根本不存在时也不假装是空目录', () => {
  const root = tmpDir('nopkg-')
  rmSync(root, { recursive: true, force: true })
  assert.throws(() => resolvePackageDir(root), /读不到这个目录/)
})

// ── readPackage ──────────────────────────────────────────────────────

test('缺少清单时明确说缺的是清单，而不是「目录为空」', () => {
  const root = tmpDir('nomanifest-')
  assert.throws(() => readPackage(root), /manifest\.json/)
})

test('清单不是合法 JSON 时如实报出来', () => {
  const { dir } = makePackage({ 'config/profile.patch.yml': SHARED_PATCH }, {
    rawManifest: '{ 这不是 JSON',
  })
  assert.throws(() => readPackage(dir), /不是合法 JSON/)
})

test('清单版本不受支持时拒绝，并说明多半要升级', () => {
  const { dir } = makePackage({ 'config/profile.patch.yml': SHARED_PATCH }, {
    schemaVersion: 99,
  })
  assert.throws(() => readPackage(dir), /版本不受支持/)
})

test('读出包内的文件内容，清单里列了但磁盘上没有的会被跳过', () => {
  const { dir } = makePackage(
    { 'config/profile.patch.yml': SHARED_PATCH },
    {
      filesOverride: [
        { path: 'config/profile.patch.yml', bytes: 10, sha256: hashContent(SHARED_PATCH) },
        { path: 'skills/gone/SKILL.md', bytes: 1, sha256: 'x' },
      ],
    },
  )
  const pkg = readPackage(dir)
  assert.deepEqual(pkg.files.map(f => f.path), ['config/profile.patch.yml'])
})

// ── validatePackage ─────────────────────────────────────────────────

test('清单与内容一致时校验通过', () => {
  const { dir } = makePackage({ 'config/profile.patch.yml': SHARED_PATCH })
  const result = validatePackage(readPackage(dir))
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})

test('包被改动过时按校验值发现，并说清是内容不符', () => {
  const { dir } = makePackage({ 'config/profile.patch.yml': SHARED_PATCH })
  // 改内容而不改清单：这正是「复制过程中损坏」与「被人改过」两种情形的共同表现。
  writeFileSync(join(dir, 'config/profile.patch.yml'), SHARED_PATCH + '# 多出来的一行\n')
  const result = validatePackage(readPackage(dir))
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /与清单不符/)
})

test('清单列了但包里没有的文件算包不完整', () => {
  const { dir } = makePackage({ 'config/profile.patch.yml': SHARED_PATCH })
  rmSync(join(dir, 'config/profile.patch.yml'))
  const result = validatePackage(readPackage(dir))
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /包不完整|被截断/)
})

test('旧版清单没有校验值时降级为警告，而不是拒绝整份包', () => {
  const { dir } = makePackage(
    { 'config/profile.patch.yml': SHARED_PATCH },
    {
      filesOverride: [
        { path: 'config/profile.patch.yml', bytes: Buffer.byteLength(SHARED_PATCH, 'utf8') },
      ],
    },
  )
  const result = validatePackage(readPackage(dir))
  assert.equal(result.ok, true, '拒绝一份由更早版本导出的包，对用户没有帮助')
  assert.match(result.warnings.join('\n'), /没有校验值/)
})

test('旧版清单没有校验值时仍按大小兜底校验', () => {
  const { dir } = makePackage({ 'config/profile.patch.yml': SHARED_PATCH })
  writeFileSync(join(dir, 'config/profile.patch.yml'), SHARED_PATCH + '# 变长了\n')
  const pkg = readPackage(dir)
  // 把清单里的 sha256 抹掉，模拟旧版清单
  for (const record of pkg.manifest.files) delete record.sha256
  const result = validatePackage(pkg)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /大小与清单不符/)
})

// ── planImport ──────────────────────────────────────────────────────

test('正常包：公共条目、技能文件、插件名单各归其位', () => {
  const { dir } = makePackage({
    'config/profile.patch.yml': SHARED_PATCH,
    'config/bundles.json': JSON.stringify({ official: ['a'], thirdParty: ['b'] }),
    'skills/demo/SKILL.md': '# demo\n',
  })
  const plan = planImport(readPackage(dir))

  assert.deepEqual(plan.patchRows.map(r => r.id), ['llm-pi-ai'])
  assert.deepEqual(plan.skillFiles.map(f => f.path), ['skills/demo/SKILL.md'])
  assert.deepEqual(plan.pluginNames, { official: ['a'], thirdParty: ['b'] })
  assert.deepEqual(plan.refused, [])
  assert.equal(plan.generatedBy, 'test-machine')
  assert.equal(isEmptyPlan(plan), false)
})

test('包里出现本机条目时拒绝写回，并说清「这一项保留本机当前的值」', () => {
  // 本程序导出时不会带这些项。带上了就说明包不可信——
  // 而把局域网监听地址带到另一台机器，正是本项目要解决的问题本身。
  const patched = SHARED_PATCH + '- id: webserver\n  config:\n    host: 192.168.31.7\n'
  const { dir } = makePackage({ 'config/profile.patch.yml': patched })
  const plan = planImport(readPackage(dir))

  assert.deepEqual(plan.patchRows.map(r => r.id), ['llm-pi-ai'])
  const refused = plan.refused.find(item => item.reason === 'machine-entry')
  assert.ok(refused, '本机条目必须被拒绝，而不是安静地写回去')
  assert.match(refused.explanation, /本机配置/)
  assert.match(refused.explanation, /保留本机当前的值/)
  assert.ok(
    !JSON.stringify(plan.patchRows).includes('192.168.31.7'),
    '局域网地址绝不能进入写入计划',
  )
})

test('包里出现不属于公共线的条目时拒绝，并指出它不在公共线范围内', () => {
  // 用第三方插件的条目：它既不是公共线，也不算「本机」——
  // 设计决策 19 明确第三方插件配置不进公共线。
  const patched = SHARED_PATCH + '- id: dsh-better-sidebar\n  config: {}\n'
  const { dir } = makePackage({ 'config/profile.patch.yml': patched })
  const plan = planImport(readPackage(dir))

  const refused = plan.refused.find(item => item.reason === 'excluded-entry')
  assert.ok(refused)
  assert.match(refused.explanation, /不在公共线范围内/)
  assert.deepEqual(plan.patchRows.map(r => r.id), ['llm-pi-ai'])
})

test('包里出现没有 id 的 insert 行时拒绝，并说明它只描述加载顺序', () => {
  const patched = SHARED_PATCH + "- insert:\n    - id: someone-else\n      name: someone-else\n"
  const { dir } = makePackage({ 'config/profile.patch.yml': patched })
  const plan = planImport(readPackage(dir))

  const refused = plan.refused.find(item => item.reason === 'excluded-entry')
  assert.ok(refused)
  assert.match(refused.explanation, /没有 id|加载顺序/)
})

test('不认识的路径一律不写回，并说明只接受三类内容', () => {
  const { dir } = makePackage({
    'config/profile.patch.yml': SHARED_PATCH,
    '.credentials.yaml': 'apiKey: sk-secret\n',
    'auth/users.yaml': 'users: []\n',
  })
  const plan = planImport(readPackage(dir))

  assert.equal(plan.refused.filter(item => item.reason === 'unknown-path').length, 2)
  assert.ok(
    !JSON.stringify(plan).includes('sk-secret'),
    '凭据内容不得出现在计划里（计划会被写进报告、日志与界面）',
  )
})

test('插件名单不是合法 JSON 时只忽略这一项，不拖垮整次导入', () => {
  const { dir } = makePackage({
    'config/profile.patch.yml': SHARED_PATCH,
    'config/bundles.json': '不是 JSON',
  })
  const plan = planImport(readPackage(dir))

  assert.equal(plan.pluginNames, null)
  assert.equal(plan.refused.some(item => item.reason === 'unreadable'), true)
  assert.deepEqual(plan.patchRows.map(r => r.id), ['llm-pi-ai'])
})

test('公共配置不是合法 patch 时只拒绝这一个文件，其余照常计划', () => {
  const { dir } = makePackage({
    'config/profile.patch.yml': '这不是数组，是一个映射：\n  id: x\n',
    'skills/demo/SKILL.md': '# demo\n',
  })
  const plan = planImport(readPackage(dir))

  assert.deepEqual(plan.patchRows, [])
  assert.equal(plan.skillFiles.length, 1)
  assert.equal(plan.refused.some(item => item.reason === 'unreadable'), true)
})

test('为空的计划可以识别出来，供界面不渲染空壳', () => {
  const { dir } = makePackage({ 'config/profile.patch.yml': '# 空\n' })
  assert.equal(isEmptyPlan(planImport(readPackage(dir))), true)
})

// ── skillTargetPath ─────────────────────────────────────────────────

test('技能按包内相对路径落位', () => {
  const root = join('/data', 'skills')
  assert.equal(
    skillTargetPath(root, 'skills/demo/SKILL.md'),
    join(root, 'demo', 'SKILL.md'),
  )
})

test('越界的技能路径被压平，不跳出技能目录', () => {
  const root = join('/data', 'skills')
  const target = skillTargetPath(root, 'skills/../../escaped.md')
  assert.equal(target, join(root, 'escaped.md'))
})

test('导出侧写出的包，导入侧能原样读回来（含中文与空格路径）', () => {
  // 两侧必须用同一套路径规则：导出时压平、导入时找回来。
  // 这条用例把两边接在一起跑一遍，而不是各自断言一个字符串。
  const root = tmpDir('roundtrip-')
  const files = [
    { path: 'config/profile.patch.yml', content: SHARED_PATCH },
    { path: 'skills/中文 名字/SKILL.md', content: '# 中文\n' },
  ]
  const exported = exportForReview({
    files,
    exportRoot: root,
    stamp: '20261015-120000',
    generatedAt: '2026-10-15T04:00:00.000Z',
    generatedBy: 'export-side',
  })

  const plan = planImport(readPackage(exported.exportPath))
  assert.deepEqual(plan.patchRows.map(r => r.id), ['llm-pi-ai'])
  assert.deepEqual(
    plan.skillFiles.map(f => f.path),
    ['skills/中文 名字/SKILL.md'],
  )
  assert.deepEqual(plan.refused, [])
  assert.equal(validatePackage(readPackage(exported.exportPath)).ok, true)
})
