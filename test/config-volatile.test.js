import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../index.js'

// 这一组用例锁的是一个「不报错的静默失败」：
// 设置页的表单由 volatileForm() 过滤得到
// （packages/settings/settings/src/schema.ts:37），只有 volatile 字段才进表单；
// 一个都没有时它返回 undefined，describe()
// （packages/settings/settings/src/index.ts:302）随即跳过整个条目，
// 结果是设置页上什么都不显示，控制台也不会有任何报错。
//
// 换句话说：漏写 .volatile() 不等于「字段不可编辑」，等于「插件在设置页里不存在」。
// 纯读类型签名看不出来，只能靠实测（本轮就是这么发现的）。

/** 复刻官方 volatileForm 的判定逻辑，用于断言「设置页会不会出现」。 */
function volatileForm(schema) {
  if (schema.meta.volatile) return schema
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : { dict }
  }
  return undefined
}

test('每个字段都是 volatile —— 否则整个条目不会出现在设置页', () => {
  for (const [key, field] of Object.entries(Config.dict)) {
    assert.equal(
      field.meta.volatile, true,
      `字段 ${key} 缺少 .volatile()；官方 describe() 会跳过整个条目，设置页将什么都不显示`,
    )
  }
})

test('设置页确实会为这个 schema 生成表单，且每个字段都在', () => {
  const form = volatileForm(Config)

  assert.notEqual(form, undefined, 'volatileForm 返回 undefined 时设置页不会有这个插件')
  assert.deepEqual(
    Object.keys(form.dict).sort(),
    ['branch', 'exportRoot', 'importRoot', 'profileName', 'repoUrl'],
  )
})

test('反面对照：去掉 volatile 就得不到表单 —— 锁住这个机制的判断依据', async () => {
  const z = (await import('@deepseek-ai/schemastery')).default
  const withoutVolatile = z.object({
    repoUrl: z.string().default('').description('仓库地址'),
  })

  assert.equal(
    volatileForm(withoutVolatile), undefined,
    '若这条失败，说明 volatileForm 的语义变了，必须回头复核上面两条结论',
  )
})
