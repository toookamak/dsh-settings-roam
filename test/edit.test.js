import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  flattenConfig,
  parseFieldValue,
  validatePath,
  setAtPath,
  unsetAtPath,
  applyEdits,
  buildEdits,
  diffConfig,
} from '../src/edit.js'

// ─── 摊平 ────────────────────────────────────────────────────────────

test('嵌套配置摊成扁平字段，路径用点号连接', () => {
  const fields = flattenConfig({
    providers: { demo: { apiKeyEnv: 'DEMO_KEY', baseURL: 'https://x/v1' } },
  })
  assert.deepEqual(fields.map(f => f.path).sort(), [
    'providers.demo.apiKeyEnv',
    'providers.demo.baseURL',
  ])
  assert.equal(fields.find(f => f.path.endsWith('apiKeyEnv')).type, 'string')
})

test('数组当整体看待，不下钻 —— 按下标改会一改就错位', () => {
  const fields = flattenConfig({ models: ['a', 'b'] })
  assert.equal(fields.length, 1)
  assert.equal(fields[0].path, 'models')
  assert.equal(fields[0].type, 'array')
})

// ─── 值解析 ──────────────────────────────────────────────────────────

test('按原类型解析：原来是数字就必须是数字', () => {
  assert.deepEqual(parseFieldValue('42', 'number'), { ok: true, value: 42 })
  const bad = parseFieldValue('四十二', 'number')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /数字/)
})

test('布尔字段只认明确的真假，不搞宽容解析', () => {
  assert.equal(parseFieldValue('true', 'boolean').value, true)
  assert.equal(parseFieldValue('off', 'boolean').value, false)
  // 把 'yes' 当布尔收下，用户下次就会以为 '1' 也可以——最后会在配置里
  // 留下一串看着像布尔其实是字符串的值，那是最难查的一类错。
  assert.equal(parseFieldValue('yes', 'boolean').ok, false)
})

test('数组与对象按 JSON 解析，坏了要说清坏在哪', () => {
  assert.deepEqual(parseFieldValue('["a","b"]', 'array').value, ['a', 'b'])
  const bad = parseFieldValue('[a,', 'array')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /JSON/)
})

test('字符串字段原样收下，不做转换', () => {
  assert.equal(parseFieldValue('sk-123', 'string').value, 'sk-123')
  assert.equal(parseFieldValue('', 'string').value, '')
})

// ─── 路径校验 ────────────────────────────────────────────────────────

test('路径里的段必须能当配置键用', () => {
  assert.equal(validatePath('providers.demo.apiKeyEnv').ok, true)
  assert.equal(validatePath('').ok, false)
  assert.equal(validatePath('providers.有 空格').ok, false)
  assert.match(validatePath('a/b').error, /不能用作配置键/)
})

// ─── 写值 / 删值 ─────────────────────────────────────────────────────

test('按路径写值，中间层不存在时创建它 —— 用户填了就是要加这个供应商', () => {
  const next = setAtPath({ providers: {} }, 'providers.new.baseURL', 'https://x')
  assert.deepEqual(next, { providers: { new: { baseURL: 'https://x' } } })
})

test('写值是纯函数，不改原来那份', () => {
  const before = { providers: { demo: { baseURL: 'a' } } }
  const snapshot = JSON.stringify(before)
  setAtPath(before, 'providers.demo.baseURL', 'b')
  assert.equal(JSON.stringify(before), snapshot, '原对象不该被改动')
})

test('删值只删这一个键，不顺手清理空掉的父对象', () => {
  const next = unsetAtPath({ providers: { demo: { a: 1, b: 2 } } }, 'providers.demo.a')
  assert.deepEqual(next, { providers: { demo: { b: 2 } } })
})

test('删不存在的路径时原样返回，不抛错', () => {
  const before = { a: { b: 1 } }
  assert.deepEqual(unsetAtPath(before, 'a.c.d'), before)
})

// ─── 应用编辑 ────────────────────────────────────────────────────────

test('一组编辑应用到条目上，返回新条目且不动原来那条', () => {
  const entry = { id: 'llm-pi-ai', name: 'pkg', config: { providers: { demo: { baseURL: 'a' } } } }
  const result = applyEdits(entry, [
    { path: 'providers.demo.baseURL', value: 'b' },
    { path: 'providers.demo.apiKeyEnv', value: 'DEMO_KEY' },
  ])

  assert.equal(result.ok, true)
  assert.deepEqual(result.entry.config, {
    providers: { demo: { baseURL: 'b', apiKeyEnv: 'DEMO_KEY' } },
  })
  assert.equal(entry.config.providers.demo.baseURL, 'a', '原条目不该被改')
  assert.equal(result.entry.name, 'pkg', '其余字段原样保留')
})

test('路径非法时整批拒绝，不写一半', () => {
  const entry = { id: 'llm-pi-ai', config: { a: 1 } }
  const result = applyEdits(entry, [
    { path: 'b', value: 2 },
    { path: 'a b', value: 3 },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 1)
  assert.equal(result.entry, undefined, '有错就不该产出新条目')
})

// ─── 从文本构造编辑 ─────────────────────────────────────────────────

test('按字段原类型解析文本输入', () => {
  const result = buildEdits({
    set: { 'providers.demo.baseURL': 'https://x', 'retries': '3' },
    types: { 'providers.demo.baseURL': 'string', retries: 'number' },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.edits, [
    { path: 'providers.demo.baseURL', value: 'https://x' },
    { path: 'retries', value: 3 },
  ])
})

test('一条解析失败时整批拒绝，并指出是哪一条', () => {
  const result = buildEdits({
    set: { retries: '四十二' },
    types: { retries: 'number' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].path, 'retries')
})

test('unset 与 set 可以混在一起', () => {
  const result = buildEdits({ set: { a: '1' }, unset: ['b'] })
  assert.deepEqual(result.edits, [{ path: 'a', value: '1' }, { path: 'b', remove: true }])
})

// ─── 差异 ────────────────────────────────────────────────────────────

test('差异只说到字段这一层，并分出新增、改动、删除', () => {
  const items = diffConfig(
    { a: 1, b: 'x', c: true },
    { a: 2, b: 'x', d: 'new' },
  )
  assert.deepEqual(items.map(i => [i.path, i.action]), [
    ['a', 'set'], ['c', 'remove'], ['d', 'set'],
  ])
  assert.equal(items.find(i => i.path === 'a').from, 1)
})

test('没有变化时差异为空', () => {
  assert.deepEqual(diffConfig({ a: { b: 1 } }, { a: { b: 1 } }), [])
})
