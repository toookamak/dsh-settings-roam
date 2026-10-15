import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('package.json 声明了插件身份与 patch 挂载点', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, '@toookamak/dsh-settings-roam')
  assert.deepEqual(pkg.dsh.bundle.patch, ['./cordis.patch.yml'])
  assert.equal(pkg.type, 'module')
})

test('运行期真正 import 的包必须声明在 dependencies 里', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  // 为什么这条要写成测试
  // ────────────────────
  // 从其它机器上安装本插件时，pnpm 不会为它安装 devDependencies。
  // 本机之所以一直能跑，是因为 profile 里恰好有别的包（dshmarket）也依赖 js-yaml，
  // 被提升到了 profile 的 node_modules 根部——也就是说，它**借**来的。
  // 借来的依赖在「新机器上恢复」这个场景里正是最不该依赖的东西：
  // 恰好没有那个包，插件就在启动阶段报 ERR_MODULE_NOT_FOUND。
  //
  // 对照官方生态里的第三方插件 dshmarket：它把 js-yaml 放在 dependencies，
  // 把随 harness 分发的包放在 peerDependencies（其中 schemastery 标 optional）。
  // 本插件的分法与之相同。
  assert.ok(pkg.dependencies?.['js-yaml'], 'js-yaml 是运行期依赖，必须声明在 dependencies')
  assert.equal(
    pkg.devDependencies?.['js-yaml'],
    undefined,
    'js-yaml 不应只声明在 devDependencies——那样在新机器上不会被安装',
  )

  // 随 harness 分发、不在 npm 上独立可装的包只能做 peer，并且必须标 optional：
  // 否则用户装上本插件却缺某个官方包时，安装直接失败，而不是插件降级运行。
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
    assert.ok(pkg.peerDependencies?.[name], `${name} 应声明为 peerDependency`)
    assert.equal(
      pkg.peerDependenciesMeta?.[name]?.optional,
      true,
      `${name} 应标为 optional peerDependency`,
    )
    assert.equal(pkg.dependencies?.[name], undefined, `${name} 不应声明为直接依赖`)
  }
})

