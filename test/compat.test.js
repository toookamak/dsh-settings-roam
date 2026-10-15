import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPAT_LEVELS,
  checkPatchEntries,
  checkPlugins,
  checkEnvRefs,
  checkSkills,
  summarizeCompat,
} from '../src/compat.js'

// ─── 配置条目 ────────────────────────────────────────────────────────

test('name 与本机不一致时判为 block —— 否则写下去只会静默跳过', () => {
  // 实测约束 C1 的另一半：id 对得上、name 对不上时，loader 只记一条
  // `patch: name mismatch` 日志就跳过，不抛错也不生效。
  // 界面一切正常、配置没换，这是最难查的一类。
  const items = checkPatchEntries(
    [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-something-else', config: {} }],
    [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }],
  )
  assert.equal(items.length, 1)
  assert.equal(items[0].level, 'block')
  assert.equal(items[0].code, 'name-mismatch')
  assert.match(items[0].action, /不会生效|跳过/)
})

test('本机没有这一项时是 ok，并说清会作为新条目加上', () => {
  const items = checkPatchEntries([{ id: 'llm-pi-ai', config: {} }], [])
  assert.equal(items[0].level, 'ok')
  assert.equal(items[0].code, 'entry-new')
})

test('本机已有同 id 且 name 一致时是 ok，并提醒是整条替换', () => {
  const items = checkPatchEntries(
    [{ id: 'llm-pi-ai', name: 'pkg', config: {} }],
    [{ id: 'llm-pi-ai', name: 'pkg', config: { old: true } }],
  )
  assert.equal(items[0].code, 'entry-update')
  // C3：config 是全量替换而不是深合并，用户应当知道本机那一份会被换掉。
  assert.match(items[0].message, /替换/)
})

test('本机那一条没有 name 时不算冲突 —— 那种情况能匹配上', () => {
  const items = checkPatchEntries(
    [{ id: 'llm-pi-ai', name: 'pkg', config: {} }],
    [{ id: 'llm-pi-ai', config: {} }],
  )
  assert.equal(items[0].level, 'ok', '本机行不带 name 时任何 name 都能匹配')
})

test('没有 id 的条目单独归类，不假装它会写回', () => {
  const items = checkPatchEntries([{ name: 'pkg', config: {} }], [])
  assert.equal(items[0].code, 'entry-without-id')
  assert.equal(items[0].level, 'warn')
})

// ─── 插件名单 ────────────────────────────────────────────────────────

test('第三方插件没装时是 warn 而不是 block —— 配置该先落下来', () => {
  const items = checkPlugins({ official: [], thirdParty: ['dshmarket'] }, { official: [], thirdParty: [] })
  assert.equal(items.length, 1)
  assert.equal(items[0].level, 'warn')
  assert.equal(items[0].code, 'plugin-missing')
  assert.match(items[0].action, /不替\S*安装|自己|原来的方式/)
})

test('插件已经装了就报 ok', () => {
  const items = checkPlugins({ thirdParty: ['dshmarket'] }, { thirdParty: ['dshmarket'] })
  assert.equal(items[0].code, 'plugin-installed')
})

test('拿不到本机插件名单时不做判断，也不误报缺插件', () => {
  // 没有 pluginManager 服务是正常情况（插件装上了但该服务缺席），
  // 此时说「你没装这个插件」是假消息。
  assert.deepEqual(checkPlugins({ thirdParty: ['dshmarket'] }, null), [])
})

test('官方插件不进这个检查 —— 它们随 DSH 本体发布', () => {
  assert.deepEqual(checkPlugins({ official: ['@deepseek-ai/dsh-base'], thirdParty: [] }, { official: [] }), [])
})

// ─── 环境变量 ────────────────────────────────────────────────────────

test('引用了但本机没设的环境变量要单独指出来', () => {
  const items = checkEnvRefs(['OPENCODE_GO_API_KEY'], {})
  assert.equal(items[0].level, 'warn')
  assert.equal(items[0].code, 'env-missing')
  assert.match(items[0].message, /OPENCODE_GO_API_KEY/)
})

test('空白的环境变量不算设了 —— 空字符串会让认证失败得更难查', () => {
  const items = checkEnvRefs(['A_KEY'], { A_KEY: '   ' })
  assert.equal(items[0].code, 'env-missing')
})

test('设好了就报 ok', () => {
  const items = checkEnvRefs(['A_KEY'], { A_KEY: 'sk-xxx' })
  assert.equal(items[0].code, 'env-set')
})

test('不把密钥内容写进报告 —— 这一层只谈变量名', () => {
  const items = checkEnvRefs(['A_KEY'], { A_KEY: 'sk-super-secret' })
  assert.ok(!JSON.stringify(items).includes('sk-super-secret'), '报告里不该出现密钥值')
})

// ─── 技能文件 ────────────────────────────────────────────────────────

test('会覆盖本机同名技能时提前说清，并指出备份能救回来', () => {
  const items = checkSkills(
    [{ path: 'skills/demo/SKILL.md' }],
    path => path === 'skills/demo/SKILL.md',
  )
  assert.equal(items[0].code, 'skill-overwrite')
  assert.equal(items[0].level, 'warn')
  assert.match(items[0].action, /备份/)
})

test('本机没有的技能是 ok', () => {
  const items = checkSkills([{ path: 'skills/new/SKILL.md' }], () => false)
  assert.equal(items[0].code, 'skill-new')
})

// ─── 汇总 ────────────────────────────────────────────────────────────

test('只要有一条 block，整份计划就不该放行', () => {
  const summary = summarizeCompat([
    { level: 'ok' }, { level: 'warn' }, { level: 'block' },
  ])
  assert.equal(summary.blocked, true)
  assert.deepEqual(summary.counts, { ok: 1, warn: 1, block: 1 })
})

test('全是 warn 时照样可以继续 —— 提醒不该变成路障', () => {
  const summary = summarizeCompat([{ level: 'warn' }, { level: 'warn' }])
  assert.equal(summary.blocked, false)
  assert.equal(summary.counts.warn, 2)
})

test('级别取值是固定的三个，避免界面按新级别分支时漏掉', () => {
  assert.deepEqual([...COMPAT_LEVELS], ['ok', 'warn', 'block'])
})
