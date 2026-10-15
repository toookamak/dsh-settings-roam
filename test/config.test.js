import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../index.js'

/** volatile 字段解析后是引用，取值要 .get()；普通字段原样返回。 */
const val = field => (typeof field?.get === 'function' ? field.get() : field)

// 设置页的表单直接由这个 schema 生成（packages/settings/settings/src/index.ts:302
// 的 describe() 把 Config 投影成表单），所以 schema 的形状就是用户看到的界面。
// 这些用例锁的是「用户能不能看懂」这件事——单元测试通常不管，但它决定可用性。

test('留空也能解析：插件默认处于「装着但待配置」状态', () => {
  const value = Config({})

  assert.equal(val(value.repoUrl), '')
  assert.equal(val(value.profileName), '')
  assert.equal(val(value.exportRoot), '')
})

test('每个可配置字段都在，且顺序与界面阅读顺序一致', () => {
  const keys = Object.keys(Config.dict ?? Config.meta?.dict ?? {})

  // schemastery 把 object 的字段放在 dict 上；不同的实例暴露方式略有不同，
  // 这里退化成「解析结果里有这些键」来断言，避免绑死内部结构。
  const parsed = Config({})
  for (const key of ['repoUrl', 'branch', 'profileName', 'exportRoot', 'importRoot']) {
    assert.ok(key in parsed, `字段 ${key} 应存在${keys.length ? `（dict: ${keys.join(',')}）` : ''}`)
  }
})

test('每个字段都有说明文字 —— 设置页上唯一的解释来源', () => {
  const dict = Config.dict
  assert.ok(dict, 'schema 应暴露 dict 以便逐字段核对说明')

  for (const [key, field] of Object.entries(dict)) {
    const description = field?.meta?.description
    assert.equal(
      typeof description, 'string',
      `字段 ${key} 缺少 description；设置页上会变成一个没有解释的输入框`,
    )
    assert.ok(description.length >= 10, `字段 ${key} 的说明太短，不足以说明白`)
  }
})

test('每个字段都已接入，说明里不得再出现「尚未生效」', () => {
  // 这条以前是反过来的：importRoot 当时是占位，必须自称「未生效」。
  // 第二阶段落地后必须把话术撤掉——留着会让人以为填了没用，
  // 而它现在确实会去那个目录里找包。
  for (const key of ['repoUrl', 'branch', 'profileName', 'exportRoot', 'importRoot']) {
    assert.doesNotMatch(
      Config.dict[key].meta.description, /尚未生效|占位/,
      `字段 ${key} 已经接入，说明里不该再标未生效`,
    )
  }
})

test('字符串字段拒绝非字符串，避免配置里塞进对象后在下游才炸', () => {
  assert.throws(() => Config({ repoUrl: { nested: true } }))
  assert.throws(() => Config({ repoUrl: 42 }))
})

// 实测结论（本轮核对）：schemastery 的 object() **不剥离**未声明的键，
// 解析结果里原样带着它们，源码里也没有 delete result[...] 这类逻辑。
// 这不是我们要修的 bug，但它有一个真实的后果必须记下来：
// 用户在 cordis.patch.yml 里把 repoUrl 敲成 repourl 时不会报错，
// 只是「填了却不生效」。所以 apply() 里对未知键显式告警（见 index.js）。
test('未声明的键会被 schemastery 原样保留 —— 因此上层必须自己告警', () => {
  const value = Config({ repoUrl: 'https://x/y.git', repourl: 'https://typo/wrong.git' })

  assert.equal(val(value.repoUrl), 'https://x/y.git')
  assert.equal(
    val(value.repourl), 'https://typo/wrong.git',
    'schemastery 保留未知键；若哪天它改成剥离，这条会失败，正好提醒我们复核告警逻辑',
  )
})
