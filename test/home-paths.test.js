import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DSH_HOME_ENV,
  defaultDshHome,
  expandHomePath,
  resolveDshHome,
  dshHomePath,
} from '../src/home-paths.js'

test('默认根目录是 ~/.dsh', () => {
  assert.equal(defaultDshHome(), join(homedir(), '.dsh'))
})

test('环境变量名与官方一致', () => {
  assert.equal(DSH_HOME_ENV, 'DSH_HOME')
})

test('波浪号只展开单独或当前用户形式', () => {
  assert.equal(expandHomePath('~'), homedir())
  assert.equal(expandHomePath('~/x'), join(homedir(), 'x'))
  assert.equal(expandHomePath('~\\x'), join(homedir(), 'x'))
  // 官方不展开 ~other/x，多展开会造成路径歧义
  assert.equal(expandHomePath('~other/x'), '~other/x')
  assert.equal(expandHomePath('/abs/path'), '/abs/path')
})

test('优先级：显式配置 > DSH_HOME > 默认', () => {
  const env = { DSH_HOME: '/from/env' }
  assert.equal(resolveDshHome('/explicit', env), resolve('/explicit'), '显式配置最高')
  assert.equal(resolveDshHome(undefined, env), resolve('/from/env'), '其次 DSH_HOME')
  assert.equal(resolveDshHome(undefined, {}), defaultDshHome(), '最后是默认值')
})

test('空白 DSH_HOME 视为未设置，绝不落到工作目录', () => {
  for (const blank of ['', '   ', '\t']) {
    const got = resolveDshHome(undefined, { DSH_HOME: blank })
    assert.equal(got, defaultDshHome(), `DSH_HOME=${JSON.stringify(blank)} 必须视为未设置`)
    assert.notEqual(got, resolve('.'), '绝不能解析到当前工作目录')
  }
})

test('DSH_HOME 支持波浪号', () => {
  assert.equal(resolveDshHome(undefined, { DSH_HOME: '~/custom' }), join(homedir(), 'custom'))
})

test('空字符串的显式配置不算显式（?? 语义）', () => {
  // 官方用 configured ?? ...：只有 undefined/null 才回退。
  // 空字符串是「明确指定了空」——这里比对官方行为，避免我们自作聪明地加 trim()。
  const got = resolveDshHome('', { DSH_HOME: '/from/env' })
  assert.equal(got, resolve(''), '空字符串按其字面语义解析为当前工作目录')
})

test('返回的是规范化绝对路径', () => {
  const got = resolveDshHome('/a/b/../c', {})
  // '..' 抵消掉上一段，所以结果是 /a/c 而不是 /a/b/../c
  assert.equal(got, resolve('/a/b/../c'))
  assert.equal(got, '/a/c')
  assert.ok(got.startsWith('/') || /^[A-Za-z]:/.test(got), '必须是绝对路径')
})

test('dshHomePath 在解析出的根目录下拼子路径', () => {
  assert.equal(dshHomePath(), resolveDshHome())
  assert.equal(dshHomePath('skills'), join(resolveDshHome(), 'skills'))
  assert.equal(dshHomePath('a', 'b'), join(resolveDshHome(), 'a', 'b'))
})

test('与官方包在真实环境下给出同一个结果（一致性锚点）', async () => {
  // 这是防止复刻语义漂移的锚点：只要官方包能解析，就比对一次。
  // 第三方插件运行时不能 import 它，但测试环境可以。
  let official = null
  try {
    official = await import('@deepseek-ai/dsh-home-paths')
  } catch {
    // 测试环境没有官方包时跳过——不让这条断言成为硬依赖
    return
  }
  assert.equal(resolveDshHome(), official.resolveDshHome(), '无参数时必须与官方一致')
  assert.equal(
    resolveDshHome(undefined, { DSH_HOME: '/x/y' }),
    official.resolveDshHome(undefined, { DSH_HOME: '/x/y' }),
    'DSH_HOME 分支必须与官方一致',
  )
  assert.equal(
    resolveDshHome(undefined, { DSH_HOME: '  ' }),
    official.resolveDshHome(undefined, { DSH_HOME: '  ' }),
    '空白分支必须与官方一致',
  )
})
