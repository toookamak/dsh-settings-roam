# 设置漫游（dsh-settings-roam）第一期实现计划

> **For agentic workers:** Recommended SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task; if neither is installed, execute it inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个 DSH 插件，把某台机器上可移植的 DSH 配置（provider 定义、官方插件名单、技能）推送到云端 git 仓库，并在新机器上拉取、预览差异、备份后应用、恢复插件，全过程纯手动、全程可回退。

**Architecture:** 分层为「归属表 → 抽取器 → 后端介质 → 应用器 → 界面」五层。抽取器负责按顶层条目从 `cordis.patch.yml` 中切出公共部分（核心动作，不是复制文件）；后端抽象先于第二种介质，第一期只有 git 实现；应用器先备份再走官方接口写入，写后回读校验。

**Tech Stack:** Node.js ESM、`@deepseek-ai/cordis` 插件模型、`js-yaml`（经官方导出的 `entryListSchema`）、`node:test` 测试框架、git CLI（经 `child_process` 调用，凭据交给系统 credential helper）。

---

## 设计文档与验证结论（实现前必读）

本计划依据两份材料：

- 设计文档：`docs/superpowers/specs/2026-10-14-dsh-settings-roam-design.md`
- V1 验证结论（已在 2026-10-15 实测完成，见「验证结论」一节）

### 已验证成立的事实（本计划的地基，不要重新论证）

| # | 事实 | 证据 |
|---|---|---|
| 1 | Loader YAML 方言可用官方通道解析，无需自造逻辑 | `@deepseek-ai/cordis-plugin-include` 导出 `entryListSchema` |
| 2 | 官方导出渲染器，`dsh --dump-config` 用的同一份 | `@deepseek-ai/dsh-app-boot` 导出 `renderConfigDump` |
| 3 | 按顶层条目切分可行，真实样本切出 9 项 | 实测 118 行 → 9 个顶层条目 |
| 4 | `!!js` 表达式解析为 `{__jsExpr}` 节点，不被求值，dump 后保留 `!!js` | 往返深等价 |
| 5 | 官方渲染器往返语义等价（注释不保真，属已知代价） | 119 行 → 116 行，重解析深等价 |
| 6 | `applyEntryPatches` 对不存在的行**静默跳过**，只经 `warn` 回调报 `patch: entry · not found` | 实测路径 1 |
| 7 | `id-patch` 的 `name` 字段参与匹配，不一致则 `name mismatch` 跳过 | 实测路径 3 |
| 8 | 匹配成立时 `config` 是**全量替换**，不是深合并 | 实测路径 3、官方 `packages/bundle/web-app/cordis.patch.yml:5-6` 原文印证 |

### 由验证结论派生的三条硬约束

- **C1**：新增公共条目一律走 `insert`，不可用 `id-patch`（否则静默跳过）。
- **C2**：写路径必须显式收集 `warn` 回调，**回调非空即视为写入异常**，不可只靠 `try/catch`。
- **C3**：写回前必须在内存中把本机行与公共行合并为完整 `config` 再整体写出，不可指望 patch 做局部合并。

### 已定的技术取舍

| 取舍 | 决定 | 理由 |
|---|---|---|
| 注释保真 | **接受丢失**（方案 A） | 注释密集的 `webserver` 区属本机条目、不在写回范围；走官方渲染器的收益是格式与 `dsh --dump-config` 永远一致 |
| YAML 处理 | 复用官方 `entryListSchema` + `renderConfigDump` | 不自造解析器，避免与官方行为分叉 |
| 注释丢失的具体表现 | 渲染器会生成自己的 `# == <来源>` 分隔注释，用户手写注释丢失 | 已在界面差异预览中如实呈现 |

---

## 文件结构

```
package.json                         插件清单，含 dsh.bundle.patch 声明
cordis.patch.yml                     本插件挂载时向宿主 Loader 注入的行
index.js                             服务端入口：注册服务与工具
client.js                            客户端入口：设置页一节、侧边栏面板、浮层提示
locale/zh-CN.json                    界面文案（简体中文）
locale/en.json                       界面文案（英文）
icon.svg                             插件图标
src/ownership.js                     归属表：配置项 → 'shared' | 'machine' | 'excluded'
src/yaml-loader.js                   官方方言通道封装：解析、切分、渲染、合并写回
src/extract.js                       推送侧抽取：按归属表从本机配置抽出公共线
src/apply.js                         拉取侧应用：备份、写入、写后回读校验
src/bundles.js                       插件名单读取与官方/第三方判定
src/skills.js                        技能目录读写，含可执行位与差异展示
src/backends/index.js                后端抽象接口
src/backends/git.js                  git 介质实现
src/snapshot.js                      快照组装与解析（snapshot.json）
src/diff.js                          差异计算（DiffItem 列表）
src/report.js                        恢复报告组装（RestoreReport）
test/ownership.test.js               归属表测试
test/yaml-loader.test.js             方言通道测试（含 C1/C2/C3 三条约束）
test/extract.test.js                 抽取测试
test/apply.test.js                   应用与备份回退测试
test/bundles.test.js                 判定口径测试
test/skills.test.js                  技能同步与可执行位测试
test/snapshot.test.js                快照模型测试
test/diff.test.js                    差异计算测试
test/backends-git.test.js            git 后端测试（用本地裸库，不碰网络）
```

**职责边界**：`src/yaml-loader.js` 是唯一允许直接接触 YAML 方言的模块，其余模块只与它交互。这样官方通道若变更，改动面收敛在一个文件。

---

## 任务总览

| 阶段 | 任务 | 产出 |
|---|---|---|
| 一 · 地基 | Task 1–3 | 脚手架、归属表、方言通道 |
| 二 · 读路径 | Task 4–6 | 插件名单、技能、抽取器 |
| 三 · 数据模型 | Task 7–8 | 快照、差异 |
| 四 · 写路径 | Task 9–10 | 备份回退、应用器 |
| 五 · 介质 | Task 11 | 后端抽象 + git 实现 |
| 六 · 装配 | Task 12–14 | 服务与工具、界面、收支报告 |
| 七 · 验收 | Task 15–16 | 端到端演练、文档回写 |

---

## 一 · 地基

### Task 1: 仓库脚手架与测试环境

**Files:**
- Create: `package.json`
- Create: `test/smoke.test.js`
- Modify: `.gitignore`（新增 `coverage/`、`snapshot-work/`）

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "@toookamak/dsh-settings-roam",
  "description": "设置漫游：把 DSH 的可移植配置推送到云端，在新机器上拉取并应用",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "icon.svg",
    "src",
    "locale"
  ],
  "dsh": {
    "bundle": {
      "patch": ["./cordis.patch.yml"]
    }
  },
  "scripts": {
    "test": "node --test test/",
    "test:one": "node --test"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*"
  },
  "engines": {
    "node": ">=22"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: 写第一个失败测试**

创建 `test/smoke.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('package.json 声明了插件身份与 patch 挂载点', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, '@toookamak/dsh-settings-roam')
  assert.deepEqual(pkg.dsh.bundle.patch, ['./cordis.patch.yml'])
  assert.equal(pkg.type, 'module')
})
```

- [ ] **Step 3: 运行测试，确认失败**

运行：`node --test test/smoke.test.js`
预期：FAIL，报 `ENOENT: no such file or directory`（`package.json` 的路径能读到，但断言会通过——若已创建则此步通过，继续下一步）

若已通过，说明 `package.json` 已建好，符合预期。

- [ ] **Step 4: 补 `.gitignore`**

在 `.gitignore` 末尾追加：

```
# ── 测试与演练产物 ──
coverage/
snapshot-work/
*.local.yml
```

- [ ] **Step 5: 运行全部测试**

运行：`npm test`
预期：PASS，1 个测试通过

- [ ] **Step 6: 提交**

```bash
git add package.json test/smoke.test.js .gitignore
git commit -m "脚手架：插件清单与测试环境"
```

---

### Task 2: 归属表

**Files:**
- Create: `src/ownership.js`
- Test: `test/ownership.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/ownership.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ownershipOf, OWNERSHIP, SHARED_PATCH_IDS, MACHINE_PATCH_IDS, isSharedPatchId } from '../src/ownership.js'

test('三态取值存在且互不相同', () => {
  assert.equal(OWNERSHIP.SHARED, 'shared')
  assert.equal(OWNERSHIP.MACHINE, 'machine')
  assert.equal(OWNERSHIP.EXCLUDED, 'excluded')
})

test('patch 顶层条目：llm-pi-ai 属公共线', () => {
  assert.equal(ownershipOf('patch', 'llm-pi-ai'), OWNERSHIP.SHARED)
  assert.equal(isSharedPatchId('llm-pi-ai'), true)
})

test('patch 顶层条目：8 个本机条目全部判为本机', () => {
  const machineIds = ['webserver', 'dsh-auth-gate', 'ui-settings-general',
    'agent-default-model', 'typert-gateway', 'ui-theme', 'permission', 'session-log-deepseek']
  for (const id of machineIds) {
    assert.equal(ownershipOf('patch', id), OWNERSHIP.MACHINE, `${id} 应判为本机`)
    assert.equal(isSharedPatchId(id), false, `${id} 不应进公共线`)
  }
  assert.equal(MACHINE_PATCH_IDS.length, 8)
  assert.deepEqual(SHARED_PATCH_IDS, ['llm-pi-ai'])
})

test('密钥与账号数据判为不同步', () => {
  assert.equal(ownershipOf('file', '.credentials.yaml'), OWNERSHIP.EXCLUDED)
  assert.equal(ownershipOf('file', 'auth/users.yaml'), OWNERSHIP.EXCLUDED)
  assert.equal(ownershipOf('file', 'storages/dsh_auth_sessions.json'), OWNERSHIP.EXCLUDED)
  assert.equal(ownershipOf('file', 'storages/session_projcache/'), OWNERSHIP.EXCLUDED)
  assert.equal(ownershipOf('file', 'node_modules/'), OWNERSHIP.EXCLUDED)
})

test('技能与插件名单属公共线', () => {
  assert.equal(ownershipOf('skills', 'agent-browser'), OWNERSHIP.SHARED)
  assert.equal(ownershipOf('bundles', 'dsh-soul'), OWNERSHIP.SHARED)
})

test('未知项默认为不同步（保守失败）', () => {
  assert.equal(ownershipOf('patch', 'some-unknown-id'), OWNERSHIP.EXCLUDED)
  assert.equal(ownershipOf('unknown-kind', 'x'), OWNERSHIP.EXCLUDED)
})
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`node --test test/ownership.test.js`
预期：FAIL，`Cannot find module '../src/ownership.js'`

- [ ] **Step 3: 实现归属表**

创建 `src/ownership.js`：

```js
/**
 * 归属表：把每个配置项标为 公共 / 本机 / 不同步。
 * 这是本插件的中心数据结构——公共线不是「复制文件」，而是「按本表从文件里抽取公共项」。
 * 依据：设计文档 §4.2 归属表内容、§4.6 抽取粒度实测。
 */

export const OWNERSHIP = Object.freeze({
  SHARED: 'shared',
  MACHINE: 'machine',
  EXCLUDED: 'excluded',
})

/** cordis.patch.yml 中进公共线的顶层条目 id。实测 9 项中仅此 1 项。 */
export const SHARED_PATCH_IDS = Object.freeze(['llm-pi-ai'])

/** cordis.patch.yml 中判为本机的顶层条目 id（各机器各自配置，见设计决策 20/21）。 */
export const MACHINE_PATCH_IDS = Object.freeze([
  'webserver',
  'dsh-auth-gate',
  'ui-settings-general',
  'agent-default-model',
  'typert-gateway',
  'ui-theme',
  'permission',
  'session-log-deepseek',
])

/** 永远不进云端的文件：密钥、账号、会话、缓存、依赖。 */
const EXCLUDED_FILES = Object.freeze([
  '.credentials.yaml',
  'auth/users.yaml',
  'storages/dsh_auth_sessions.json',
  'storages/session_projcache/',
  'skills-manager/repository-cache/',
  'skills-manager/repositories.json',
  'node_modules/',
])

/** 判为「本机」的 patch 子键（记录用，抽取时按顶层条目整体处置）。 */
export const MACHINE_PATCH_KEYS = Object.freeze({
  'dsh-auth-gate': ['publicHost', 'mode', 'cookieSecure'],
  'ui-theme': ['preference'],
  'agent-default-model': ['provider', 'model'],
  'permission': ['sandbox', 'approval', 'defaultPreset'],
  'typert-gateway': ['websocketHeartbeatIntervalMs'],
  webserver: ['host', 'port'],
})

/** 判为「本机」但不在 patch 里的文件。 */
const MACHINE_FILES = Object.freeze(['storages/workspace.json'])

export function isSharedPatchId(id) {
  return SHARED_PATCH_IDS.includes(id)
}

export function isMachinePatchId(id) {
  return MACHINE_PATCH_IDS.includes(id)
}

/**
 * 查一个配置项的归属。
 * 未知项一律返回 EXCLUDED —— 保守失败：宁可不同步，也不要把不知道是什么的东西推上云端。
 * @param {'patch'|'file'|'skills'|'bundles'} kind
 * @param {string} name
 * @returns {'shared'|'machine'|'excluded'}
 */
export function ownershipOf(kind, name) {
  switch (kind) {
    case 'patch':
      if (isSharedPatchId(name)) return OWNERSHIP.SHARED
      if (isMachinePatchId(name)) return OWNERSHIP.MACHINE
      return OWNERSHIP.EXCLUDED
    case 'file':
      if (EXCLUDED_FILES.includes(name)) return OWNERSHIP.EXCLUDED
      if (MACHINE_FILES.includes(name)) return OWNERSHIP.MACHINE
      return OWNERSHIP.EXCLUDED
    case 'skills':
      return OWNERSHIP.SHARED
    case 'bundles':
      return OWNERSHIP.SHARED
    default:
      return OWNERSHIP.EXCLUDED
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`node --test test/ownership.test.js`
预期：PASS，6 个测试通过

- [ ] **Step 5: 提交**

```bash
git add src/ownership.js test/ownership.test.js
git commit -m "归属表：patch 条目、文件、技能、插件名单的四类归属"
```

---

### Task 3: 方言通道（官方 YAML 解析、切分、渲染、合并写回）

本任务是 C1/C2/C3 三条硬约束的落地点，也是最容易出错的一环。

**Files:**
- Create: `src/yaml-loader.js`
- Test: `test/yaml-loader.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/yaml-loader.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePatchList, splitByTopLevelId, renderPatches, mergeSharedInto,
} from '../src/yaml-loader.js'

const SAMPLE = [
  '# 首行注释，验证注释不保真这一已知代价',
  '- id: webserver',
  '  config:',
  "    host: '10.0.0.5'",
  '    port: 3080',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      demo:',
  '        apiKeyEnv: DEMO_KEY',
  '- id: ui-theme',
  '  config:',
  '    preference: dark',
  '',
].join('\n')

test('解析顶层数组并保留方言节点', () => {
  const rows = parsePatchList(SAMPLE)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(r => r.id), ['webserver', 'llm-pi-ai', 'ui-theme'])
})

test('!!js 表达式解析为表达式节点且不被求值', () => {
  const rows = parsePatchList([
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      demo:',
    '        apiKeyEnv: !!js process.env.DEMO_KEY',
    "        baseURL: !!js '`${process.env.HOST}/v1`'",
    '',
  ].join('\n'))
  const cfg = rows[0].config.providers.demo
  assert.equal(typeof cfg.apiKeyEnv, 'object')
  assert.equal(cfg.apiKeyEnv.__jsExpr, 'process.env.DEMO_KEY')
  assert.equal(cfg.baseURL.__jsExpr, '`${process.env.HOST}/v1`')
})

test('按顶层条目切分，得到 shared / machine / excluded 三组', () => {
  const rows = parsePatchList(SAMPLE)
  const { shared, machine, excluded } = splitByTopLevelId(rows)
  assert.deepEqual(shared.map(r => r.id), ['llm-pi-ai'])
  assert.deepEqual(machine.map(r => r.id).sort(), ['ui-theme', 'webserver'])
  assert.deepEqual(excluded, [])
})

test('渲染保留 !!js 标签', () => {
  const rows = parsePatchList([
    '- id: llm-pi-ai',
    '  config:',
    '    k: !!js process.env.X',
    '',
  ].join('\n'))
  const text = renderPatches(rows)
  assert.match(text, /!!js/)
})

test('C1：新增公共条目走 insert，目标行不存在也能写入', () => {
  const target = parsePatchList("- id: webserver\n  config:\n    host: '10.0.0.5'\n")
  const shared = parsePatchList("- id: llm-pi-ai\n  config:\n    providers:\n      demo:\n        apiKeyEnv: DEMO_KEY\n")
  const { rows, warnings } = mergeSharedInto(target, shared)
  assert.ok(rows.some(r => r.id === 'llm-pi-ai'), '公共条目应被写入')
  assert.ok(rows.some(r => r.id === 'webserver' && r.config.host === '10.0.0.5'), '本机条目应零损伤')
  assert.deepEqual(warnings, [], '不应产生警告')
})

test('C2：静默跳过必须被转换成可见失败', () => {
  const target = parsePatchList("- id: webserver\n  config:\n    host: '10.0.0.5'\n")
  // 故意用 id-patch 打一个不存在的行，复现官方的静默跳过
  const { warnings } = mergeSharedInto(target, [], { forceIdPatchForTest: 'no-such-id' })
  assert.ok(warnings.length > 0, 'warn 回调必须被收集为非空')
  assert.match(warnings.join(' '), /not found/)
})

test('C3：同名条目已存在时整行替换 config（非深合并）', () => {
  const target = parsePatchList([
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      old: {}',
    '    extra: keep-me',
    '',
  ].join('\n'))
  const shared = parsePatchList([
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      demo:',
    '        apiKeyEnv: DEMO_KEY',
    '',
  ].join('\n'))
  const { rows } = mergeSharedInto(target, shared)
  const row = rows.find(r => r.id === 'llm-pi-ai')
  assert.equal(row.config.extra, undefined, 'config 为全量替换，旧键不应残留')
  assert.deepEqual(Object.keys(row.config.providers), ['demo'])
})

test('往返保真：原文解析 → 渲染 → 再解析，语义等价', () => {
  const rows = parsePatchList(SAMPLE)
  const again = parsePatchList(renderPatches(rows))
  assert.deepEqual(again, rows)
})
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`node --test test/yaml-loader.test.js`
预期：FAIL，`Cannot find module '../src/yaml-loader.js'`

- [ ] **Step 3: 实现方言通道**

创建 `src/yaml-loader.js`：

```js
/**
 * 唯一允许直接接触 DSH Loader YAML 方言的模块。
 *
 * 不放自造 YAML 逻辑：解析走 @deepseek-ai/cordis-plugin-include 的 entryListSchema，
 * 渲染走 @deepseek-ai/dsh-app-boot 的 renderConfigDump —— 与 `dsh --dump-config` 同款，
 * 保证插件写出的格式永远和官方工具一致。
 *
 * 三条硬约束（由 2026-10-15 实测得出，见实现计划「验证结论」）：
 *   C1 新增条目走 insert，不用 id-patch —— id-patch 打空行是静默跳过。
 *   C2 warn 回调必须收集，回调非空即视为异常 —— 官方不抛错。
 *   C3 同名行匹配时 config 是全量替换，非深合并 —— 必须先在内存合并完整 config。
 */

import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { isSharedPatchId, isMachinePatchId } from './ownership.js'

/**
 * 解析一份 patch 文件文本。
 * @param {string} text - 文件内容
 * @returns {object[]} 顶层条目数组
 */
export function parsePatchList(text) {
  const parsed = yaml.load(text, { schema: entryListSchema })
  if (!Array.isArray(parsed)) {
    throw new Error('patch 文件必须是顶层 YAML 数组')
  }
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`第 ${index + 1} 项必须是映射（一个 Loader patch 条目）`)
    }
  }
  return parsed
}

/**
 * 按顶层条目 id 把条目分成三组。抽取的最小单位是条目，不是文件——见设计 §4.6。
 * @param {object[]} rows
 * @returns {{shared: object[], machine: object[], excluded: object[]}}
 */
export function splitByTopLevelId(rows) {
  const shared = []
  const machine = []
  const excluded = []
  for (const row of rows) {
    if (isSharedPatchId(row.id)) shared.push(row)
    else if (isMachinePatchId(row.id)) machine.push(row)
    else excluded.push(row)
  }
  return { shared, machine, excluded }
}

/**
 * 把条目渲染成 YAML 文本。
 *
 * 已知代价：注释不保真。官方渲染器不保留手写注释，会生成自己的 `# == <来源>`
 * 分隔注释。本插件只写公共条目，而注释密集的本机条目不在写回范围，故接受此代价，
 * 换取「格式与 dsh --dump-config 永远一致」的收益。
 * @param {object[]} rows
 * @param {string} [label] - 来源标签，写入分隔注释
 * @returns {string}
 */
export function renderPatches(rows, label = 'dsh-settings-roam') {
  const header = `# 由设置漫游生成，来源：${label}\n`
  return header + yaml.dump(rows, { schema: entryListSchema, noRefs: true, lineWidth: -1 })
}

/**
 * 把公共条目合并进目标条目列表，返回新列表与警告。
 *
 * 分两条路径，这是 C1 与 C3 的落地：
 *   - 目标里没有这个 id → 用 insert 追加（C1）
 *   - 目标里已有这个 id → 在内存中把 config 整体替换为公共版（C3）
 *
 * @param {object[]} targetRows - 目标机器当前的条目列表
 * @param {object[]} sharedRows - 要合入的公共条目
 * @param {{forceIdPatchForTest?: string}} [options] - 仅供测试注入
 * @returns {{rows: object[], warnings: string[], applied: string[]}}
 */
export function mergeSharedInto(targetRows, sharedRows, options = {}) {
  const warnings = []
  const applied = []
  const warn = (message, ...args) => {
    let index = 0
    warnings.push(String(message).replace(/%C/g, () => JSON.stringify(args[index++])))
  }

  let current = structuredClone(targetRows)

  // 测试钩子：复现官方的静默跳过（C2 的反例）
  if (options.forceIdPatchForTest !== undefined) {
    current = applyEntryPatches(current, [{ id: options.forceIdPatchForTest, config: {} }], warn)
    return { rows: current, warnings, applied }
  }

  const existingIds = new Set(current.map(r => r.id))
  const toInsert = sharedRows.filter(r => !existingIds.has(r.id))
  const toReplace = sharedRows.filter(r => existingIds.has(r.id))

  if (toInsert.length > 0) {
    current = applyEntryPatches(current, [{ insert: structuredClone(toInsert) }], warn)
    for (const row of toInsert) applied.push(row.id)
  }
  for (const row of toReplace) {
    // C3：整体替换 config。结构由共享条目完整给出，不依赖深合并。
    const patch = { id: row.id }
    if (row.name !== undefined) patch.name = row.name
    if (row.config !== undefined) patch.config = structuredClone(row.config)
    current = applyEntryPatches(current, [patch], warn)
    applied.push(row.id)
  }

  return { rows: current, warnings, applied }
}
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`node --test test/yaml-loader.test.js`
预期：PASS，8 个测试通过

若 `C3` 用例失败，原因是 `applyEntryPatches` 的 `name` 匹配（实测规则二）——检查测试样本里目标行与 patch 的 `name` 是否都有且一致。

- [ ] **Step 5: 提交**

```bash
git add src/yaml-loader.js test/yaml-loader.test.js
git commit -m "方言通道：按条目切分、渲染、合并写回，落地 C1/C2/C3 三条约束"
```

---

## 二 · 读路径

### Task 4: 插件名单读取与官方判定

本任务落地设计 §2.6 的判定口径。**已核实的运行时事实**（2026-10-15，源码 `packages/boot/plugin-manager/src/index.ts`）：

- `official = optional || offered !== undefined`（`:299`）——只覆盖官方可选包与按需包，**漏掉随安装带的包**
- `availability = shipped ? 'installation' : 'profile'`（`:322`），`shipped = Object.hasOwn(installation.dependencies ?? {}, name)`（`:297`）
- `owned = installed && !shipped`（`:313`），`source` 仅对 `owned` 的包写入（`:318`）——**随安装带的官方包不写 `source`**

**Files:**
- Create: `src/bundles.js`
- Test: `test/bundles.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/bundles.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOfficialBundle, classifyBundles, readBundleNames } from '../src/bundles.js'

test('判定口径：official 为真即官方', () => {
  assert.equal(isOfficialBundle({ name: 'x', official: true, availability: 'profile' }), true)
})

test('判定口径：availability 为 installation 即官方（补 official 的缺口）', () => {
  assert.equal(isOfficialBundle({ name: 'x', official: false, availability: 'installation' }), true)
})

test('判定口径：第三方包既非 official 也非 installation', () => {
  assert.equal(isOfficialBundle({ name: 'dsh-soul', official: false, availability: 'profile' }), false)
})

test('判定口径：不用包名前缀判定', () => {
  // 即便名字带官方前缀，只要两个字段都不满足，就不是官方
  assert.equal(isOfficialBundle({ name: '@deepseek-ai/whatever', official: false, availability: 'profile' }), false)
})

test('分类：把 listBundles 结果分成官方与第三方两列', () => {
  const rows = [
    { name: '@deepseek-ai/dsh-base', official: false, availability: 'installation', enabled: true },
    { name: '@deepseek-ai/dsh-experimental-ralph-bundle', official: true, availability: 'profile', enabled: false },
    { name: 'dsh-soul', official: false, availability: 'profile', enabled: true },
    { name: 'github:toookamak/dsh-git-sentry', official: false, availability: 'profile', enabled: true },
  ]
  const { official, thirdParty } = classifyBundles(rows)
  assert.deepEqual(official.map(b => b.name).sort(), [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-experimental-ralph-bundle',
  ])
  assert.deepEqual(thirdParty.map(b => b.name).sort(), [
    'dsh-soul',
    'github:toookamak/dsh-git-sentry',
  ])
})

test('插件名单只记名字，不记启用状态', () => {
  const rows = [
    { name: 'a', official: true, availability: 'profile', enabled: true },
    { name: 'b', official: true, availability: 'profile', enabled: false },
  ]
  const names = readBundleNames(rows)
  assert.deepEqual(names.official.sort(), ['a', 'b'])
  assert.equal(JSON.stringify(names).includes('enabled'), false, '名字名单不应携带 enabled')
})
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`node --test test/bundles.test.js`
预期：FAIL，`Cannot find module '../src/bundles.js'`

- [ ] **Step 3: 实现插件名单模块**

创建 `src/bundles.js`：

```js
/**
 * 插件名单的读取与官方/第三方判定。
 *
 * 判定口径（设计 §2.6，三条来源取并集）：
 *   official === true || availability === 'installation'
 *
 * 为什么需要并集：源码 plugin-manager/src/index.ts:299 的 official 计算式
 * `optional || offered !== undefined` 只覆盖官方可选包（OPTIONAL_BUNDLES，11 条）
 * 与官方按需包（OFFICIAL_ON_DEMAND_CATALOG，2 条），漏掉了随 DSH 安装本体发布的
 * 那批插件（shipped）。而 availability 恰好由 shipped 决定，补上这个缺口。
 *
 * 为什么不用包名前缀 @deepseek-ai/ 判定：前缀是 npm scope，不是所有权凭证。
 * 实践中目前与官方判定等价，但会在「官方发布非该前缀首方包」或「用户从别的
 * registry 装同名包」两种情况下失效。前缀只作界面上的可读辅助。
 */

/**
 * 判定单个包是否官方。
 * @param {{official?: boolean, availability?: string}} info - BundleInfo 的子集
 * @returns {boolean}
 */
export function isOfficialBundle(info) {
  return info?.official === true || info?.availability === 'installation'
}

/**
 * 把 listBundles() 的结果分成官方与第三方两列。
 * @param {object[]} rows - BundleInfo 数组
 * @returns {{official: object[], thirdParty: object[]}}
 */
export function classifyBundles(rows) {
  const official = []
  const thirdParty = []
  for (const row of rows) {
    if (isOfficialBundle(row)) official.push(row)
    else thirdParty.push(row)
  }
  return { official, thirdParty }
}

/**
 * 从 BundleInfo 数组抽出只含名字的名单。
 * 设计决策 8：插件只记名字，不记启用状态、不记插件内设置。
 * 「已启用 bundle」名单是动态的（本机就有先后关闭的可选包），
 * 所以每次推送都必须重新读取，不能当固定快照。
 * @param {object[]} rows
 * @returns {{official: string[], thirdParty: string[]}}
 */
export function readBundleNames(rows) {
  const { official, thirdParty } = classifyBundles(rows)
  return {
    official: official.map(b => b.name),
    thirdParty: thirdParty.map(b => b.name),
  }
}

/**
 * 从 ctx.pluginManager 读取插件名单。
 * @param {object} pluginManager - ctx.pluginManager 服务
 * @returns {Promise<{official: string[], thirdParty: string[], raw: object[]}>}
 */
export async function collectBundles(pluginManager) {
  const raw = await pluginManager.listBundles()
  const names = readBundleNames(raw)
  return { ...names, raw }
}
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`node --test test/bundles.test.js`
预期：PASS，6 个测试通过

- [ ] **Step 5: 提交**

```bash
git add src/bundles.js test/bundles.test.js
git commit -m "插件名单：官方判定口径落地为 official || availability === installation"
```

---

### Task 5: 技能目录读写

技能不是纯文本：含可执行脚本与二进制资源，**必须保留文件模式**（设计 §4.7）。丢失可执行位会让脚本在目标机器上静默失效——文件在，但跑不起来。

**Files:**
- Create: `src/skills.js`
- Test: `test/skills.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/skills.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSkills, copySkills, listSkillNames } from '../src/skills.js'

function makeSkillDir() {
  const root = mkdtempSync(join(tmpdir(), 'roam-skills-'))
  const a = join(root, 'agent-browser')
  mkdirSync(join(a, 'templates'), { recursive: true })
  writeFileSync(join(a, 'SKILL.md'), '# agent-browser\n')
  writeFileSync(join(a, 'templates', 'run.sh'), '#!/bin/sh\necho hi\n')
  chmodSync(join(a, 'templates', 'run.sh'), 0o755)
  const b = join(root, 'writing-plans')
  mkdirSync(b, { recursive: true })
  writeFileSync(join(b, 'SKILL.md'), '# writing-plans\n')
  return root
}

test('扫描技能目录，列出技能名', () => {
  const root = makeSkillDir()
  const names = listSkillNames(root)
  assert.deepEqual(names.sort(), ['agent-browser', 'writing-plans'])
  rmSync(root, { recursive: true })
})

test('扫描记录每个文件的模式，尤其是可执行位', () => {
  const root = makeSkillDir()
  const scanned = scanSkills(root)
  const sh = scanned.find(f => f.relPath === 'agent-browser/templates/run.sh')
  assert.ok(sh, '应扫描到模板脚本')
  assert.equal(sh.executable, true, '可执行位必须被记录')
  const md = scanned.find(f => f.relPath === 'agent-browser/SKILL.md')
  assert.equal(md.executable, false)
  rmSync(root, { recursive: true })
})

test('复制技能保留可执行位', () => {
  const root = makeSkillDir()
  const dest = mkdtempSync(join(tmpdir(), 'roam-dest-'))
  copySkills(root, ['agent-browser'], dest)
  const copied = join(dest, 'agent-browser', 'templates', 'run.sh')
  const mode = statSync(copied).mode & 0o777
  assert.equal(mode & 0o100, 0o100, '复制后仍应可执行')
  rmSync(root, { recursive: true })
  rmSync(dest, { recursive: true })
})

test('技能含二进制资源时不破坏内容', () => {
  const root = mkdtempSync(join(tmpdir(), 'roam-bin-'))
  const s = join(root, 'screenshot')
  mkdirSync(join(s, 'assets'), { recursive: true })
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe])
  writeFileSync(join(s, 'assets', 'shot.png'), bytes)
  const dest = mkdtempSync(join(tmpdir(), 'roam-dest2-'))
  copySkills(root, ['screenshot'], dest)
  const after = statSync(join(dest, 'screenshot', 'assets', 'shot.png'))
  assert.equal(after.size, bytes.length, '二进制长度不变')
  rmSync(root, { recursive: true })
  rmSync(dest, { recursive: true })
})
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`node --test test/skills.test.js`
预期：FAIL，`Cannot find module '../src/skills.js'`

- [ ] **Step 3: 实现技能模块**

创建 `src/skills.js`：

```js
/**
 * 技能目录的读写。
 *
 * 设计 §4.7 的两个硬要求：
 *   1. 保留文件模式 —— 脚本靠可执行位工作，丢了就在目标机器上静默失效。
 *   2. 同步前必须能审查脚本内容 —— 技能脚本会在目标机器上执行，
 *      差异视图里要能看到脚本的新增与改动，不能当不透明二进制默默搬过去。
 *
 * 主通道是直读 ~/.dsh/skills/，ctx.skills 只作校验通道（设计决策 26）：
 * 技能本体就是文件，直读得到的就是要同步的内容；走 ctx.skills 反而多一层抽象。
 */

import { readdirSync, statSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * 列出技能目录下的技能名（各技能一个子目录）。
 * @param {string} skillsRoot - 形如 ~/.dsh/skills
 * @returns {string[]}
 */
export function listSkillNames(skillsRoot) {
  let entries
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries.filter(e => e.isDirectory()).map(e => e.name)
}

/**
 * 递归扫描技能目录，返回每个文件的可比较记录。
 * @param {string} skillsRoot
 * @param {string[]} [only] - 只扫描这些技能；省略则全部
 * @returns {{relPath: string, size: number, executable: boolean}[]}
 */
export function scanSkills(skillsRoot, only) {
  const wanted = only ?? listSkillNames(skillsRoot)
  const out = []
  const walk = (dir, relBase) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
      if (entry.isDirectory()) {
        walk(abs, rel)
        continue
      }
      if (!entry.isFile()) continue
      const st = statSync(abs)
      out.push({
        relPath: rel.split(sep).join('/'),
        size: st.size,
        executable: (st.mode & 0o100) !== 0,
      })
    }
  }
  for (const name of wanted) {
    const abs = join(skillsRoot, name)
    try {
      if (!statSync(abs).isDirectory()) continue
    } catch {
      continue
    }
    walk(abs, name)
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

/**
 * 把指定技能复制到目标目录，保留可执行位。
 * @param {string} skillsRoot - 源技能根目录
 * @param {string[]} names - 要复制的技能名
 * @param {string} destRoot - 目标根目录（技能会成为其子目录）
 * @returns {string[]} 实际复制的技能名
 */
export function copySkills(skillsRoot, names, destRoot) {
  const copied = []
  for (const name of names) {
    const src = join(skillsRoot, name)
    let st
    try {
      st = statSync(src)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const walk = (dir, relBase) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
        const dest = join(destRoot, name, rel)
        if (entry.isDirectory()) {
          mkdirSync(dest, { recursive: true })
          walk(abs, rel)
          continue
        }
        if (!entry.isFile()) continue
        mkdirSync(join(dest, '..'), { recursive: true })
        copyFileSync(abs, dest)
        // 保留模式位：脚本靠可执行位工作
        const mode = statSync(abs).mode & 0o777
        chmodSync(dest, mode)
      }
    }
    mkdirSync(join(destRoot, name), { recursive: true })
    walk(src, '')
    copied.push(name)
  }
  return copied
}

/**
 * 用 ctx.skills 校验直读结果（校验通道）。
 * 不一致说明有技能来自非本机的 provider 来源，这本身值得报告。
 * @param {object} skillService - ctx.skills
 * @param {string[]} directNames - 直读得到的技能名
 * @returns {Promise<{consistent: boolean, complete: boolean, serviceNames: string[]}>}
 */
export async function crossCheckSkills(skillService, directNames) {
  const snap = await skillService.snapshot()
  const serviceNames = snap.skills.map(s => s.name)
  const a = [...directNames].sort()
  const b = [...serviceNames].sort()
  return {
    consistent: JSON.stringify(a) === JSON.stringify(b),
    complete: snap.complete !== false,
    serviceNames,
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`node --test test/skills.test.js`
预期：PASS，4 个测试通过

- [ ] **Step 5: 提交**

```bash
git add src/skills.js test/skills.test.js
git commit -m "技能：直读为主通道，保留可执行位，ctx.skills 作交叉校验"
```

---

### Task 6: 抽取器（读路径核心）

本任务是设计的核心动作：**公共线不是「复制文件」，而是「按归属表从文件里抽取公共项」**（设计 §3.2）。

**Files:**
- Create: `src/extract.js`
- Test: `test/extract.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/extract.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractShared, detectUnexpectable } from '../src/extract.js'
import { parsePatchList } from '../src/yaml-loader.js'

const PATCH = [
  "# LAN bind: 首行注释",
  '- id: webserver',
  '  config:',
  "    host: '192.168.31.7'",
  '    port: 3080',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      demo:',
  '        apiKeyEnv: DEMO_KEY',
  '        baseURL: https://example.invalid/v1',
  '- id: ui-theme',
  '  config:',
  '    preference: dark',
  '',
].join('\n')

test('抽取只保留公共条目，本机条目一概不进', () => {
  const rows = parsePatchList(PATCH)
  const { patch } = extractShared({ patchRows: rows })
  assert.deepEqual(patch.map(r => r.id), ['llm-pi-ai'])
})

test('抽取结果里不含本机专属取值（局域网 IP 绝不出现）', () => {
  const rows = parsePatchList(PATCH)
  const { patch } = extractShared({ patchRows: rows })
  const text = JSON.stringify(patch)
  assert.equal(text.includes('192.168.31.7'), false, '局域网 IP 不得进公共线')
  assert.equal(text.includes('ui-theme'), false, '主题属本机，不得进公共线')
  assert.equal(text.includes('preference'), false)
})

test('抽取保留 apiKeyEnv 引用名，但不含密钥值', () => {
  const rows = parsePatchList(PATCH)
  const { patch } = extractShared({ patchRows: rows })
  const providers = patch[0].config.providers
  assert.equal(providers.demo.apiKeyEnv, 'DEMO_KEY', '引用名要同步')
  assert.equal(JSON.stringify(patch).includes('sk-'), false, '不得出现密钥形态的串')
})

test('抽取报告逐项的归属，便于界面展示', () => {
  const rows = parsePatchList(PATCH)
  const { entries } = extractShared({ patchRows: rows })
  const byPath = Object.fromEntries(entries.map(e => [e.path, e.ownership]))
  assert.equal(byPath['patch:llm-pi-ai'], 'shared')
  assert.equal(byPath['patch:webserver'], 'machine')
  assert.equal(byPath['patch:ui-theme'], 'machine')
})

test('识别 patch 里第三方插件留下的 insert 行', () => {
  const rows = parsePatchList([
    '- id: some-third-party',
    '  insert:',
    '    - id: injected-by-plugin',
    '      name: some-pkg',
    '',
  ].join('\n'))
  const found = detectUnexpectable(rows)
  assert.deepEqual(found.map(f => f.id), ['some-third-party'])
  assert.equal(found[0].reason, 'has-insert-rows')
})

test('insert 行不作为配置项抽取（否则会写坏别的机器的加载顺序）', () => {
  const rows = parsePatchList([
    '- id: llm-pi-ai',
    '  config:',
    '    providers: {}',
    '- id: some-third-party',
    '  insert:',
    '    - id: injected-by-plugin',
    '',
  ].join('\n'))
  const { patch, unexpectable } = extractShared({ patchRows: rows })
  assert.deepEqual(patch.map(r => r.id), ['llm-pi-ai'])
  assert.equal(unexpectable.length, 1, 'insert 行应被识别并排除')
})
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`node --test test/extract.test.js`
预期：FAIL，`Cannot find module '../src/extract.js'`

- [ ] **Step 3: 实现抽取器**

创建 `src/extract.js`：

```js
/**
 * 推送侧抽取：按归属表从本机配置里抽出公共线。
 *
 * 这是本设计的核心动作。实测数据显示 cordis.patch.yml 有 9 个顶层条目，
 * 其中只有 llm-pi-ai 一个进公共线。所以抽取的最小单位是【顶层条目】，
 * 不是整个文件——按文件整体同步会把 webserver.host 的局域网 IP 带到新机器上，
 * 恰好犯下本项目要解决的那个错误。
 *
 * 风险评估（设计 §7.3 最后一行）：第三方插件会在 patch 里留下 insert 行。
 * 若误把 insert 行当配置项抽取，会写坏别的机器的加载顺序。所以这里显式识别并排除。
 */

import { ownershipOf, OWNERSHIP } from './ownership.js'
import { splitByTopLevelId } from './yaml-loader.js'

/**
 * 识别 patch 里不该被抽取的条目。
 * @param {object[]} rows
 * @returns {{id: string, reason: string}[]}
 */
export function detectUnexpectable(rows) {
  const found = []
  for (const row of rows) {
    if (row?.insert !== undefined) {
      found.push({ id: row.id, reason: 'has-insert-rows' })
    }
  }
  return found
}

/**
 * 从本机配置抽取公共线。
 *
 * @param {{patchRows?: object[]}} input - 本机 cordis.patch.yml 解析后的条目
 * @returns {{
 *   patch: object[],           // 要写进云端的公共条目
 *   entries: {path: string, kind: string, ownership: string}[],  // 逐项归属，供界面展示
 *   unexpectable: {id: string, reason: string}[],                // 被识别并排除的条目
 * }}
 */
export function extractShared(input) {
  const patchRows = input.patchRows ?? []
  const { shared, machine, excluded } = splitByTopLevelId(patchRows)
  const unexpectable = detectUnexpectable(patchRows)
  const unexpectableIds = new Set(unexpectable.map(u => u.id))

  const entries = []
  for (const row of patchRows) {
    entries.push({
      path: `patch:${row.id}`,
      kind: 'patch',
      ownership: ownershipOf('patch', row.id),
    })
  }

  // 只有确认属于公共线、且不是 insert 痕迹的条目才真正抽取
  const patch = shared.filter(row => !unexpectableIds.has(row.id))

  return { patch, entries, unexpectable }
}

/**
 * 判断一次抽取是否“干净”：有没有本该进公共线却被排除的条目。
 * 供界面在推送前提示用户。
 * @param {{patch: object[], unexpectable: object[]}} result
 * @returns {boolean}
 */
export function isExtractionClean(result) {
  return result.unexpectable.length === 0
}
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`node --test test/extract.test.js`
预期：PASS，6 个测试通过

- [ ] **Step 5: 提交**

```bash
git add src/extract.js test/extract.test.js
git commit -m "抽取器：按顶层条目抽取公共线，识别并排除 insert 痕迹"
```

---

## 验证结论存档

V1 验证的原始脚本与输出，正式化后归档于：

| 文件 | 内容 |
|---|---|
| `test/yaml-loader.test.js` | 由 V1 的 8 个用例转化而来，是本计划 Task 3 的测试 |
| `docs/superpowers/specs/2026-10-14-dsh-settings-roam-design.md` | 设计文档，本计划的上位依据 |

验证脚本中的机器专属信息（局域网 IP、provider 端点）已全部替换为占位值。
