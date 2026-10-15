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

 - [x] **Step 1: 创建 `package.json`**

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

 - [x] **Step 2: 写第一个失败测试**

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

 - [x] **Step 3: 运行测试，确认失败**

运行：`node --test test/smoke.test.js`
预期：FAIL，报 `ENOENT: no such file or directory`（`package.json` 的路径能读到，但断言会通过——若已创建则此步通过，继续下一步）

若已通过，说明 `package.json` 已建好，符合预期。

 - [x] **Step 4: 补 `.gitignore`**

在 `.gitignore` 末尾追加：

```
# ── 测试与演练产物 ──
coverage/
snapshot-work/
*.local.yml
```

 - [x] **Step 5: 运行全部测试**

运行：`npm test`
预期：PASS，1 个测试通过

 - [x] **Step 6: 提交**

```bash
git add package.json test/smoke.test.js .gitignore
git commit -m "脚手架：插件清单与测试环境"
```

---

### Task 2: 归属表

**Files:**
- Create: `src/ownership.js`
- Test: `test/ownership.test.js`

 - [x] **Step 1: 写失败测试**

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

 - [x] **Step 2: 运行测试，确认失败**

运行：`node --test test/ownership.test.js`
预期：FAIL，`Cannot find module '../src/ownership.js'`

 - [x] **Step 3: 实现归属表**

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

 - [x] **Step 4: 运行测试，确认通过**

运行：`node --test test/ownership.test.js`
预期：PASS，6 个测试通过

 - [x] **Step 5: 提交**

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

 - [x] **Step 1: 写失败测试**

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

 - [x] **Step 2: 运行测试，确认失败**

运行：`node --test test/yaml-loader.test.js`
预期：FAIL，`Cannot find module '../src/yaml-loader.js'`

 - [x] **Step 3: 实现方言通道**

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

 - [x] **Step 4: 运行测试，确认通过**

运行：`node --test test/yaml-loader.test.js`
预期：PASS，8 个测试通过

若 `C3` 用例失败，原因是 `applyEntryPatches` 的 `name` 匹配（实测规则二）——检查测试样本里目标行与 patch 的 `name` 是否都有且一致。

 - [x] **Step 5: 提交**

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

 - [x] **Step 1: 写失败测试**

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

 - [x] **Step 2: 运行测试，确认失败**

运行：`node --test test/bundles.test.js`
预期：FAIL，`Cannot find module '../src/bundles.js'`

 - [x] **Step 3: 实现插件名单模块**

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

 - [x] **Step 4: 运行测试，确认通过**

运行：`node --test test/bundles.test.js`
预期：PASS，6 个测试通过

 - [x] **Step 5: 提交**

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

 - [x] **Step 1: 写失败测试**

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

 - [x] **Step 2: 运行测试，确认失败**

运行：`node --test test/skills.test.js`
预期：FAIL，`Cannot find module '../src/skills.js'`

 - [x] **Step 3: 实现技能模块**

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

 - [x] **Step 4: 运行测试，确认通过**

运行：`node --test test/skills.test.js`
预期：PASS，4 个测试通过

 - [x] **Step 5: 提交**

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

 - [x] **Step 1: 写失败测试**

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

 - [x] **Step 2: 运行测试，确认失败**

运行：`node --test test/extract.test.js`
预期：FAIL，`Cannot find module '../src/extract.js'`

 - [x] **Step 3: 实现抽取器**

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

 - [x] **Step 4: 运行测试，确认通过**

运行：`node --test test/extract.test.js`
预期：PASS，6 个测试通过

 - [x] **Step 5: 提交**

```bash
git add src/extract.js test/extract.test.js
git commit -m "抽取器：按顶层条目抽取公共线，识别并排除 insert 痕迹"
```

---

## 三 · 数据模型

### Task 7: 快照组装与解析

**Files:**
- Create: `src/snapshot.js`
- Test: `test/snapshot.test.js`

 - [x] **Step 1: 写失败测试**

创建 `test/snapshot.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCHEMA_VERSION, buildSnapshot, serializeSnapshot, parseSnapshot } from '../src/snapshot.js'

test('快照模型含 schema 版本、生成时间、来源机器与逐项摘要', () => {
  const snap = buildSnapshot({
    generatedBy: 'test-machine',
    generatedAt: '2026-10-15T00:00:00.000Z',
    files: [
      { path: 'config/profile.patch.yml', kind: 'shared', content: 'x' },
      { path: 'notes.md', kind: 'shared', content: 'y' },
    ],
  })
  assert.equal(snap.schemaVersion, SCHEMA_VERSION)
  assert.equal(snap.generatedBy, 'test-machine')
  assert.equal(snap.generatedAt, '2026-10-15T00:00:00.000Z')
  assert.equal(snap.entries.length, 2)
  assert.equal(snap.entries[0].path, 'config/profile.patch.yml')
  assert.equal(typeof snap.entries[0].hash, 'string')
  assert.ok(snap.entries[0].hash.length > 0, '每项应有内容摘要')
})

test('相同内容摘要相同，内容变化摘要变化', () => {
  const a = buildSnapshot({ generatedBy: 'm', generatedAt: 'T', files: [{ path: 'p', kind: 'shared', content: 'abc' }] })
  const b = buildSnapshot({ generatedBy: 'm', generatedAt: 'T', files: [{ path: 'p', kind: 'shared', content: 'abc' }] })
  const c = buildSnapshot({ generatedBy: 'm', generatedAt: 'T', files: [{ path: 'p', kind: 'shared', content: 'abd' }] })
  assert.equal(a.entries[0].hash, b.entries[0].hash)
  assert.notEqual(a.entries[0].hash, c.entries[0].hash)
})

test('序列化与解析往返保真', () => {
  const snap = buildSnapshot({
    generatedBy: 'm', generatedAt: 'T',
    files: [{ path: 'p', kind: 'shared', content: 'abc' }],
  })
  const text = serializeSnapshot(snap)
  const back = parseSnapshot(text)
  assert.deepEqual(back, snap)
})

test('解析非法快照时抛出可读错误', () => {
  assert.throws(() => parseSnapshot('{"schemaVersion":999,"entries":[]}'), /schema 版本/)
  assert.throws(() => parseSnapshot('not json'), /不是合法 JSON/)
})
```

 - [x] **Step 2: 运行测试，确认失败**

运行：`node --test test/snapshot.test.js`
预期：FAIL，`Cannot find module '../src/snapshot.js'`

 - [x] **Step 3: 实现快照模块**

创建 `src/snapshot.js`：

```js
/**
 * 快照模型：推送到云端的那一份内容的清单。
 * 数据模型见设计 §5.2。entries 逐文件记摘要，用于快速比对而不必读全部内容。
 */

import { createHash } from 'node:crypto'

/** 快照格式版本。云端是跨机器共享的，读不懂的版本必须明确拒绝而不是猜。 */
export const SCHEMA_VERSION = 1

function hashOf(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * 组装快照清单。
 * @param {{generatedBy: string, generatedAt: string, files: {path: string, kind: string, content: string|Buffer}[]}} input
 * @returns {object}
 */
export function buildSnapshot(input) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy,
    entries: input.files.map(f => ({
      path: f.path,
      kind: f.kind,
      hash: hashOf(f.content),
    })),
  }
}

export function serializeSnapshot(snapshot) {
  return JSON.stringify(snapshot, null, 2) + '\n'
}

/**
 * 解析云端取回的快照清单。
 * 版本不符时明确拒绝——不能拿不懂的格式去写用户的配置。
 * @param {string} text
 * @returns {object}
 */
export function parseSnapshot(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`快照清单不是合法 JSON：${String(error.message)}`)
  }
  if (parsed?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`快照清单 schema 版本不受支持：期望 ${SCHEMA_VERSION}，实际 ${parsed?.schemaVersion}`)
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error('快照清单缺少 entries 数组')
  }
  return parsed
}
```

 - [x] **Step 4: 运行测试，确认通过**

运行：`node --test test/snapshot.test.js`
预期：PASS，4 个测试通过

 - [x] **Step 5: 提交**

```bash
git add src/snapshot.js test/snapshot.test.js
git commit -m "快照：清单模型与内容摘要，拒绝读不懂的 schema 版本"
```

---

### Task 8: 差异计算

**Files:**
- Create: `src/diff.js`
- Test: `test/diff.test.js`

 - [x] **Step 1: 写失败测试**

创建 `test/diff.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffSnapshots, summarizeDiff } from '../src/diff.js'

const snapshotOf = (pairs) => ({
  schemaVersion: 1, generatedAt: 'T', generatedBy: 'm',
  entries: pairs.map(([path, hash]) => ({ path, kind: 'shared', hash })),
})

test('识别新增项', () => {
  const local = snapshotOf([['a', 'h1']])
  const remote = snapshotOf([['a', 'h1'], ['b', 'h2']])
  const items = diffSnapshots(local, remote)
  const b = items.find(i => i.path === 'b')
  assert.equal(b.action, 'add')
})

test('识别修改项', () => {
  const local = snapshotOf([['a', 'h1']])
  const remote = snapshotOf([['a', 'h2']])
  const items = diffSnapshots(local, remote)
  assert.equal(items.length, 1)
  assert.equal(items[0].action, 'modify')
})

test('识别删除项', () => {
  const local = snapshotOf([['a', 'h1'], ['b', 'h2']])
  const remote = snapshotOf([['a', 'h1']])
  const items = diffSnapshots(local, remote)
  const b = items.find(i => i.path === 'b')
  assert.equal(b.action, 'delete')
})

test('相同项不进差异列表', () => {
  const local = snapshotOf([['a', 'h1']])
  const remote = snapshotOf([['a', 'h1']])
  assert.deepEqual(diffSnapshots(local, remote), [])
})

test('每项带归属与人类可读的一句话说明', () => {
  const local = snapshotOf([['a', 'h1']])
  const remote = snapshotOf([['a', 'h2'], ['b', 'h3']])
  const items = diffSnapshots(local, remote)
  for (const item of items) {
    assert.ok(item.ownership, '应有归属字段')
    assert.ok(typeof item.summary === 'string' && item.summary.length > 0, '应有一句话说明')
  }
})

test('汇总差异条数，供界面与报告使用', () => {
  const local = snapshotOf([['a', 'h1'], ['b', 'h2']])
  const remote = snapshotOf([['a', 'h2'], ['c', 'h3']])
  const stats = summarizeDiff(diffSnapshots(local, remote))
  assert.equal(stats.add, 1)
  assert.equal(stats.modify, 1)
  assert.equal(stats.delete, 1)
  assert.equal(stats.total, 3)
})
```

 - [x] **Step 2: 运行测试，确认失败**

运行：`node --test test/diff.test.js`
预期：FAIL，`Cannot find module '../src/diff.js'`

 - [x] **Step 3: 实现差异计算**

创建 `src/diff.js`：

```js
/**
 * 差异计算：本机现状 与 云端快照 逐项比对，生成 DiffItem 列表。
 * 数据模型见设计 §5.2。推送与拉取共用这一份逻辑，只是参数方向不同。
 */

/**
 * 计算差异。
 * @param {{entries: object[]}} local - 本机现状清单
 * @param {{entries: object[]}} remote - 云端快照清单
 * @returns {{path: string, action: string, ownership: string, summary: string}[]}
 */
export function diffSnapshots(local, remote) {
  const localMap = new Map((local?.entries ?? []).map(e => [e.path, e]))
  const remoteMap = new Map((remote?.entries ?? []).map(e => [e.path, e]))
  const items = []

  for (const [path, remoteEntry] of remoteMap) {
    const localEntry = localMap.get(path)
    if (localEntry === undefined) {
      items.push({
        path,
        action: 'add',
        ownership: remoteEntry.kind ?? 'shared',
        summary: `${path}：本机没有，将从云端新增`,
      })
      continue
    }
    if (localEntry.hash !== remoteEntry.hash) {
      items.push({
        path,
        action: 'modify',
        ownership: remoteEntry.kind ?? 'shared',
        summary: `${path}：本机与云端内容不同`,
      })
    }
  }

  for (const [path, localEntry] of localMap) {
    if (remoteMap.has(path)) continue
    items.push({
      path,
      action: 'delete',
      ownership: localEntry.kind ?? 'shared',
      summary: `${path}：云端没有，本机存在（本次不会删除，仅供确认）`,
    })
  }

  return items.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 汇总差异条数。
 * @param {object[]} items
 * @returns {{add: number, modify: number, delete: number, total: number}}
 */
export function summarizeDiff(items) {
  const stats = { add: 0, modify: 0, delete: 0, total: items.length }
  for (const item of items) {
    if (item.action === 'add') stats.add += 1
    else if (item.action === 'modify') stats.modify += 1
    else if (item.action === 'delete') stats.delete += 1
  }
  return stats
}
```

 - [x] **Step 4: 运行测试，确认通过**

运行：`node --test test/diff.test.js`
预期：PASS，6 个测试通过

 - [x] **Step 5: 提交**

```bash
git add src/diff.js test/diff.test.js
git commit -m "差异：快照逐项比对，推送与拉取共用一份逻辑"
```

---

## 四 · 写路径

### Task 9: 备份与回退

设计决策 17：应用前先备份，支持回退。这是「可回退」这条需求的实现方式。

**Files:**
- Create: `src/backup.js`
- Test: `test/backup.test.js`

 - [x] **Step 1: 写失败测试**

创建 `test/backup.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackup, restoreFromBackup } from '../src/backup.js'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'roam-bk-'))
  mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'web', 'cordis.patch.yml'), 'original\n')
  return root
}

test('备份把指定文件复制到带时间戳的目录', () => {
  const root = sandbox()
  const dest = mkdtempSync(join(tmpdir(), 'roam-bkdest-'))
  const info = createBackup({
    files: [join(root, 'profiles', 'web', 'cordis.patch.yml')],
    destRoot: dest,
    stamp: '20261015-120000',
  })
  assert.ok(info.backupPath.includes('20261015-120000'), '备份路径应带时间戳')
  assert.ok(existsSync(join(info.backupPath, 'profiles', 'web', 'cordis.patch.yml')))
  rmSync(root, { recursive: true }); rmSync(dest, { recursive: true })
})

test('备份不修改原文件', () => {
  const root = sandbox()
  const dest = mkdtempSync(join(tmpdir(), 'roam-bkdest-'))
  createBackup({ files: [join(root, 'profiles', 'web', 'cordis.patch.yml')], destRoot: dest, stamp: 'S' })
  assert.equal(readFileSync(join(root, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), 'original\n')
  rmSync(root, { recursive: true }); rmSync(dest, { recursive: true })
})

test('回退把文件恢复为备份时的内容', () => {
  const root = sandbox()
  const dest = mkdtempSync(join(tmpdir(), 'roam-bkdest-'))
  const target = join(root, 'profiles', 'web', 'cordis.patch.yml')
  const info = createBackup({ files: [target], destRoot: dest, stamp: 'S' })
  writeFileSync(target, 'broken\n')
  restoreFromBackup(info, [target])
  assert.equal(readFileSync(target, 'utf8'), 'original\n')
  rmSync(root, { recursive: true }); rmSync(dest, { recursive: true })
})

test('备份不存在的文件时记录失败而不中断', () => {
  const dest = mkdtempSync(join(tmpdir(), 'roam-bkdest-'))
  const info = createBackup({ files: ['/nonexistent/path/x.yml'], destRoot: dest, stamp: 'S' })
  assert.deepEqual(info.backedUp, [])
  assert.equal(info.failed.length, 1)
  rmSync(dest, { recursive: true })
})
```

 - [x] **Step 2: 运行测试，确认失败**

运行：`node --test test/backup.test.js`
预期：FAIL，`Cannot find module '../src/backup.js'`

 - [x] **Step 3: 实现备份模块**

创建 `src/backup.js`：

```js
/**
 * 备份与回退。
 * 设计决策 17：应用前先备份，支持回退。这是「可回退」需求的落地。
 *
 * 备份目录按时间戳分开，而不是覆盖同一个目录——用户可能需要回到更早的一次状态。
 */

import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, isAbsolute, relative } from 'node:path'

/**
 * 生成时间戳字符串，形如 20261015-120000。
 * @param {Date} [now]
 * @returns {string}
 */
export function timestamp(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/**
 * 把一组文件备份到带时间戳的目录下。
 *
 * 路径在备份目录内按【绝对路径去掉根】保留层级，这样回退时能还原到原位，
 * 且不会因不同盘符或前缀而互相覆盖。
 *
 * @param {{files: string[], destRoot: string, stamp?: string}} input
 * @returns {{backupPath: string, backedUp: string[], failed: {path: string, error: string}[]}}
 */
export function createBackup(input) {
  const stamp = input.stamp ?? timestamp()
  const backupPath = join(input.destRoot, stamp)
  mkdirSync(backupPath, { recursive: true })
  const backedUp = []
  const failed = []
  for (const file of input.files) {
    try {
      if (!existsSync(file) || !statSync(file).isFile()) {
        failed.push({ path: file, error: '文件不存在' })
        continue
      }
      const rel = isAbsolute(file) ? relative('/', file) : file
      const dest = join(backupPath, rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(file, dest)
      backedUp.push(file)
    } catch (error) {
      failed.push({ path: file, error: String(error?.message ?? error) })
    }
  }
  return { backupPath, backedUp, failed }
}

/**
 * 从备份回退指定文件。
 * @param {{backupPath: string}} info - createBackup 的返回
 * @param {string[]} files - 要回退的文件（绝对路径，与备份时一致）
 * @returns {{restored: string[], failed: {path: string, error: string}[]}}
 */
export function restoreFromBackup(info, files) {
  const restored = []
  const failed = []
  for (const file of files) {
    try {
      const rel = isAbsolute(file) ? relative('/', file) : file
      const src = join(info.backupPath, rel)
      if (!existsSync(src)) {
        failed.push({ path: file, error: '备份中没有这个文件' })
        continue
      }
      mkdirSync(dirname(file), { recursive: true })
      copyFileSync(src, file)
      restored.push(file)
    } catch (error) {
      failed.push({ path: file, error: String(error?.message ?? error) })
    }
  }
  return { restored, failed }
}
```

 - [x] **Step 4: 运行测试，确认通过**

运行：`node --test test/backup.test.js`
预期：PASS，4 个测试通过

 - [x] **Step 5: 提交**

```bash
git add src/backup.js test/backup.test.js
git commit -m "备份：应用前按时间戳备份，支持逐文件回退"
```

---

### Task 10: 应用器（写路径核心）

本任务落地设计决策 25 与实测约束 C2、C3。**关键点**：写路径不做自动降级（两条都试可能产生副作用），而是把「静默失败」转成「写后立刻可见的失败」。

**Files:**
- Create: `src/apply.js`
- Test: `test/apply.test.js`

 - [x] **Step 1: 写失败测试**

创建 `test/apply.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPatchFile, verifyWriteBack } from '../src/apply.js'
import { parsePatchList } from '../src/yaml-loader.js'

const REMOTE = [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      demo:',
  '        apiKeyEnv: DEMO_KEY',
  '',
].join('\n')

const LOCAL = [
  '- id: webserver',
  '  config:',
  "    host: '10.0.0.9'",
  '- id: ui-theme',
  '  config:',
  '    preference: light',
  '',
].join('\n')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'roam-apply-'))
  const file = join(root, 'cordis.patch.yml')
  writeFileSync(file, LOCAL)
  return { root, file }
}

test('应用公共条目后，本机条目零损伤', () => {
  const { root, file } = sandbox()
  const result = applyPatchFile({ targetFile: file, sharedRows: parsePatchList(REMOTE) })
  assert.deepEqual(result.warnings, [], '不应有警告')
  const after = parsePatchList(readFileSync(file, 'utf8'))
  assert.ok(after.some(r => r.id === 'llm-pi-ai'), '公共条目应已写入')
  assert.equal(after.find(r => r.id === 'webserver').config.host, '10.0.0.9', '本机值不得被改')
  assert.equal(after.find(r => r.id === 'ui-theme').config.preference, 'light')
  rmSync(root, { recursive: true })
})

test('写后回读校验：内容确实落盘才算成功', () => {
  const { root, file } = sandbox()
  applyPatchFile({ targetFile: file, sharedRows: parsePatchList(REMOTE) })
  const check = verifyWriteBack(file, parsePatchList(REMOTE))
  assert.equal(check.ok, true)
  assert.deepEqual(check.missing, [])
  rmSync(root, { recursive: true })
})

test('写后回读校验能发现缺失的条目', () => {
  const { root, file } = sandbox()
  const check = verifyWriteBack(file, parsePatchList(REMOTE))
  assert.equal(check.ok, false)
  assert.deepEqual(check.missing, ['llm-pi-ai'])
  rmSync(root, { recursive: true })
})

test('应用前自动备份，回退可还原', () => {
  const { root, file } = sandbox()
  const result = applyPatchFile({
    targetFile: file,
    sharedRows: parsePatchList(REMOTE),
    backupRoot: join(root, 'backup'),
  })
  assert.ok(result.backup, '应产生备份信息')
  assert.equal(result.backup.backedUp.length, 1)
  rmSync(root, { recursive: true })
})

test('目标文件不存在时也能建立（新机器场景）', () => {
  const root = mkdtempSync(join(tmpdir(), 'roam-new-'))
  const file = join(root, 'cordis.patch.yml')
  const result = applyPatchFile({ targetFile: file, sharedRows: parsePatchList(REMOTE) })
  assert.deepEqual(result.warnings, [])
  const after = parsePatchList(readFileSync(file, 'utf8'))
  assert.deepEqual(after.map(r => r.id), ['llm-pi-ai'])
  rmSync(root, { recursive: true })
})

test('C2：写入产生警告时如实上报，不静默吞掉', () => {
  const { root, file } = sandbox()
  const result = applyPatchFile({
    targetFile: file,
    sharedRows: parsePatchList(REMOTE),
    __forceWarnForTest: true,
  })
  assert.ok(result.warnings.length > 0, '警告必须出现在返回值里')
  assert.equal(result.ok, false, '有警告即视为未完全成功')
  rmSync(root, { recursive: true })
})
```

 - [x] **Step 2: 运行测试，确认失败**

运行：`node --test test/apply.test.js`
预期：FAIL，`Cannot find module '../src/apply.js'`

 - [x] **Step 3: 实现应用器**

创建 `src/apply.js`：

```js
/**
 * 拉取侧应用：备份 → 写入 → 写后回读校验。
 *
 * 设计决策 25 的落地，并遵守两条实测约束：
 *   C2：applyEntryPatches 的 warn 回调必须收集，回调非空即视为写入异常。
 *       官方在目标行不存在时【不抛错】，只经 warn 报一句 not found。
 *   C3：同名行匹配时 config 是全量替换而非深合并，合并必须在内存中先做好。
 *
 * 不做自动降级：读路径可以「A 失败换 B」，写路径不行——两条都试可能产生副作用，
 * 跳过则意味着这台机器的配置停在半改状态。处置是「回退这一项 + 列为需人工处理」。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parsePatchList, renderPatches, mergeSharedInto } from './yaml-loader.js'
import { createBackup } from './backup.js'

/**
 * 把云端的公共条目应用到本机 patch 文件。
 *
 * 路径：先备份 → 读取本机现状 → 在内存中合并 → 渲染 → 写出 → 调用方随后回读校验。
 *
 * @param {{
 *   targetFile: string,
 *   sharedRows: object[],
 *   backupRoot?: string,
 *   __forceWarnForTest?: boolean,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   warnings: string[],
 *   applied: string[],
 *   backup: object|null,
 *   wrote: boolean,
 * }}
 */
export function applyPatchFile(input) {
  const { targetFile, sharedRows, backupRoot } = input

  // 1. 备份（文件不存在时不备份——新机器场景没有可备份的内容）
  let backup = null
  if (backupRoot !== undefined && existsSync(targetFile)) {
    backup = createBackup({ files: [targetFile], destRoot: backupRoot })
  }

  // 2. 读取本机现状
  let localRows = []
  if (existsSync(targetFile)) {
    const text = readFileSync(targetFile, 'utf8')
    localRows = text.trim() === '' ? [] : parsePatchList(text)
  }

  // 3. 在内存中合并（C3：不指望 patch 做局部合并）
  const merged = mergeSharedInto(
    localRows,
    sharedRows,
    input.__forceWarnForTest === true ? { forceIdPatchForTest: 'no-such-id-for-warning' } : {},
  )

  // 4. 渲染并写出
  mkdirSync(dirname(targetFile), { recursive: true })
  writeFileSync(targetFile, renderPatches(merged.rows, 'settings-roam'), 'utf8')

  const warnings = merged.warnings
  return {
    ok: warnings.length === 0,
    warnings,
    applied: merged.applied,
    backup,
    wrote: true,
  }
}

/**
 * 写后回读校验：确认文件里确实变成了预期值。
 * 这是把「静默失败」转换成「可见失败」的那一步。
 * @param {string} targetFile
 * @param {object[]} expectedRows - 期望存在的公共条目
 * @returns {{ok: boolean, missing: string[], mismatch: string[]}}
 */
export function verifyWriteBack(targetFile, expectedRows) {
  if (!existsSync(targetFile)) {
    return { ok: false, missing: expectedRows.map(r => r.id), mismatch: [] }
  }
  const actual = parsePatchList(readFileSync(targetFile, 'utf8'))
  const actualMap = new Map(actual.map(r => [r.id, r]))
  const missing = []
  const mismatch = []
  for (const expected of expectedRows) {
    const got = actualMap.get(expected.id)
    if (got === undefined) {
      missing.push(expected.id)
      continue
    }
    if (JSON.stringify(got.config) !== JSON.stringify(expected.config)) {
      mismatch.push(expected.id)
    }
  }
  return { ok: missing.length === 0 && mismatch.length === 0, missing, mismatch }
}

/**
 * 回退一项已应用的配置。
 * 写路径不「跳过」，而是「回退这一项 + 列为需人工处理」。
 * @param {{backupPath: string}} backupInfo
 * @param {string} targetFile
 * @returns {{restored: string[], failed: object[]}}
 */
export function rollbackApplied(backupInfo, targetFile) {
  const { restoreFromBackup } = await import('./backup.js')
  return restoreFromBackup(backupInfo, [targetFile])
}
```

**注意**：`rollbackApplied` 里使用了顶层 `await import`，需将其改为静态导入或把函数改为 `async`。正确写法是把该函数声明为 `async`：

```js
export async function rollbackApplied(backupInfo, targetFile) {
  const { restoreFromBackup } = await import('./backup.js')
  return restoreFromBackup(backupInfo, [targetFile])
}
```

更简单的做法是直接在文件顶部与 `createBackup` 一起静态导入 `restoreFromBackup`：

```js
import { createBackup, restoreFromBackup } from './backup.js'

export function rollbackApplied(backupInfo, targetFile) {
  return restoreFromBackup(backupInfo, [targetFile])
}
```

 - [x] **Step 4: 运行测试，确认通过**

运行：`node --test test/apply.test.js`
预期：PASS，6 个测试通过

 - [x] **Step 5: 提交**

```bash
git add src/apply.js test/apply.test.js
git commit -m "应用器：备份→合并→写入→写后回读校验，警告即失败"
```

---

## 五 · 介质

### Task 11: 后端抽象与 git 实现

设计 §5.1 只给了一句话：云端是一份 git 仓库。接口边界由此任务定义。

**为什么先定抽象再写 git**：第二期要加 WebDAV。若 git 的具体细节渗进服务层，第二期就得回头改服务层。抽象只有 5 个动作，成本低、收益明确。

**为什么凭据交给系统 git**（设计 §6.2）：插件不读、不存、不传密钥，也不弹输入框。所有网络操作都通过子进程调用 `git`，由系统的 credential helper 处理认证。这样插件代码里**永远不会出现密钥**，密钥也不会进入插件的日志或错误信息。

**Files:**
- Create: `src/backends/index.js`
- Create: `src/backends/git.js`
- Test: `test/backends-git.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/backends-git.test.js`。全程只用本地裸库，**不碰网络**：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { BACKEND_METHODS, assertBackend } from '../src/backends/index.js'
import { createGitBackend } from '../src/backends/git.js'

/** 建一个本地裸库当云端，不碰网络。 */
function bareRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'roam-bare-'))
  execFileSync('git', ['init', '--bare', '--quiet', dir])
  return dir
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'roam-be-'))
  return { root, work: join(root, 'work'), repo: bareRepo() }
}

test('后端接口只约定 5 个动作', () => {
  assert.deepEqual(
    [...BACKEND_METHODS].sort(),
    ['ensureReady', 'pull', 'push', 'readFile', 'writeFile'],
  )
})

test('接口校验：缺方法的对象被明确拒绝', () => {
  assert.throws(() => assertBackend({ push: () => {} }), /缺少方法/)
  const ok = {
    ensureReady: async () => {}, pull: async () => {},
    push: async () => {}, readFile: async () => {}, writeFile: async () => {},
  }
  assert.doesNotThrow(() => assertBackend(ok))
})

test('ensureReady 克隆空的裸库并落盘，可重复调用', async () => {
  const { root, work, repo } = sandbox()
  const backend = createGitBackend({ repoUrl: repo, workDir: work })
  await backend.ensureReady()
  assert.ok(existsSync(join(work, '.git')), '工作区应已就绪')
  await backend.ensureReady()
  assert.ok(existsSync(join(work, '.git')), '重复调用不应报错')
  rmSync(root, { recursive: true })
})

test('writeFile 落盘并推送到裸库，内容可被再次克隆读到', async () => {
  const { root, work, repo } = sandbox()
  const backend = createGitBackend({ repoUrl: repo, workDir: work })
  await backend.ensureReady()
  await backend.writeFile('config/bundles.json', '{"official":["a"]}\n', '测试写入')
  await backend.push('测试写入')

  // 换一个工作区重新克隆，确认内容真的到了「云端」
  const backend2 = createGitBackend({ repoUrl: repo, workDir: join(root, 'work2') })
  await backend2.ensureReady()
  assert.equal(await backend2.readFile('config/bundles.json'), '{"official":["a"]}\n')
  rmSync(root, { recursive: true })
})

test('readFile 读不存在的路径返回 null，不抛错', async () => {
  const { root, work, repo } = sandbox()
  const backend = createGitBackend({ repoUrl: repo, workDir: work })
  await backend.ensureReady()
  assert.equal(await backend.readFile('config/nope.json'), null)
  rmSync(root, { recursive: true })
})

test('writeFile 自动建立多级目录', async () => {
  const { root, work, repo } = sandbox()
  const backend = createGitBackend({ repoUrl: repo, workDir: work })
  await backend.ensureReady()
  await backend.writeFile('skills/demo/scripts/run.sh', '#!/bin/sh\n', '加技能')
  assert.ok(existsSync(join(work, 'skills', 'demo', 'scripts', 'run.sh')))
  rmSync(root, { recursive: true })
})

test('pull 把裸库上的新提交取回工作区', async () => {
  const { root, work, repo } = sandbox()
  const a = createGitBackend({ repoUrl: repo, workDir: work })
  await a.ensureReady()
  await a.writeFile('notes.md', 'first\n', '写记事本')
  await a.push('写记事本')

  const b = createGitBackend({ repoUrl: repo, workDir: join(root, 'work2') })
  await b.ensureReady()
  await b.writeFile('notes.md', 'second\n', '改记事本')
  await b.push('改记事本')

  await a.pull()
  assert.equal(await a.readFile('notes.md'), 'second\n')
  rmSync(root, { recursive: true })
})

test('无改动时 push 不产生空提交', async () => {
  const { root, work, repo } = sandbox()
  const backend = createGitBackend({ repoUrl: repo, workDir: work })
  await backend.ensureReady()
  await backend.writeFile('a.txt', 'x\n', '第一次')
  await backend.push('第一次')
  await assert.doesNotReject(() => backend.push('再推一次'))
  rmSync(root, { recursive: true })
})

test('凭据边界：后端源码里不出现密钥相关字段', () => {
  const src = readFileSync(new URL('../src/backends/git.js', import.meta.url), 'utf8')
  for (const word of ['password', 'token', 'apiKey', 'api_key', 'secret']) {
    assert.ok(!src.includes(word), `后端源码不应出现 ${word} —— 凭据交给系统 git`)
  }
})

test('错误信息不泄露 URL 中的凭据', async () => {
  const { root } = sandbox()
  const backend = createGitBackend({
    repoUrl: 'https://user:TOPSECRET@127.0.0.1:1/nonexistent.git',
    workDir: join(root, 'w'),
  })
  await assert.rejects(
    () => backend.ensureReady(),
    (error) => {
      assert.ok(!String(error.message).includes('TOPSECRET'), '错误信息不得包含凭据')
      return true
    },
  )
  rmSync(root, { recursive: true })
})
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`node --test test/backends-git.test.js`
预期：FAIL，`Cannot find module '../src/backends/index.js'`

- [ ] **Step 3: 实现后端抽象**

创建 `src/backends/index.js`：

```js
/**
 * 后端抽象：云端介质的最小接口。
 *
 * 设计 §5.1 说云端是一份 git 仓库，第二期会加 WebDAV。这里有两点刻意的克制：
 *
 *   1. 只约定 5 个动作。接口越窄，第二期加介质时改动面越小。
 *   2. 不认识「分支」「远端」「暂存区」这些 git 概念。服务层不该知道介质是什么。
 *
 * 凭据边界（设计 §6.2）：接口里没有任何与认证相关的参数。
 * 认证属于只能由人配置的系统级设置，交给系统 git 的 credential helper。
 */

/** 后端必须实现的方法。顺序即典型调用顺序。 */
export const BACKEND_METHODS = Object.freeze([
  'ensureReady',
  'pull',
  'push',
  'readFile',
  'writeFile',
])

/**
 * 校验一个对象是否满足后端接口。
 * 缺少方法时立即失败——与其在同步中途报「undefined is not a function」，
 * 不如在装配时就挡住。
 * @param {object} backend
 */
export function assertBackend(backend) {
  const missing = BACKEND_METHODS.filter(m => typeof backend?.[m] !== 'function')
  if (missing.length > 0) {
    throw new Error(`后端缺少方法：${missing.join(', ')}`)
  }
}
```

- [ ] **Step 4: 实现 git 后端**

创建 `src/backends/git.js`：

```js
/**
 * git 介质实现。
 *
 * 三条实现约束：
 *
 *   1. 一律走子进程调用系统 git，不自造 git 客户端。
 *      认证因此全部落在系统 credential helper 上，插件代码里永不出现密钥。
 *
 *   2. 错误信息必须脱敏。git 的报错会把 URL 原样带出来，
 *      而 URL 里可能含用户名与密码。所有对外抛出的消息都要先过 scrub()。
 *
 *   3. 无改动时不提交。云端仓库的历史被当作审计轨迹用，
 *      塞满「无改动」的空提交会让这份轨迹失去意义。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { assertBackend } from './index.js'

/**
 * 抹掉文本里可能出现的凭据。
 * 形如 scheme://user:pass@host 的部分，把 user:pass 换成掩码。
 * @param {string} text
 * @returns {string}
 */
export function scrub(text) {
  return String(text).replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@')
}

/**
 * 在指定工作区运行一条 git 命令。
 * @param {string} cwd
 * @param {string[]} args
 * @param {{allowFailure?: boolean}} [options]
 * @returns {string} stdout
 */
function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (options.allowFailure === true) return ''
    const detail = scrub(error?.stderr || error?.message || '未知错误').trim()
    throw new Error(`git ${args[0]} 失败：${detail}`)
  }
}

/**
 * 建一个 git 后端。
 * @param {{repoUrl: string, workDir: string, branch?: string,
 *          author?: {name: string, email: string}}} config
 * @returns {object} 满足 BACKEND_METHODS 的后端
 */
export function createGitBackend(config) {
  const { repoUrl, workDir, branch = 'main' } = config
  const author = config.author ?? { name: 'dsh-settings-roam', email: 'roam@localhost' }
  const safeUrl = scrub(repoUrl)

  const isRepo = () => existsSync(join(workDir, '.git'))

  /**
   * 取工作区当前的实际分支名。
   *
   * 不硬编码分支名：系统的 init.defaultBranch 可能是 main 也可能是 master，
   * 而克隆一个已有仓库时分支名由远端决定。硬编码会让 push 报
   * 「源引用规格 main 没有匹配」——这个错误在实践中很难一眼看出成因。
   */
  function currentBranch() {
    const name = git(workDir, ['symbolic-ref', '--short', 'HEAD']).trim()
    return name === '' ? branch : name
  }

  function commit(message) {
    // 先看有没有待提交的东西。没有就直接返回，避免空提交污染历史。
    const status = git(workDir, ['status', '--porcelain']).trim()
    if (status === '') return false
    git(workDir, ['add', '-A'])
    git(workDir, [
      '-c', `user.name=${author.name}`,
      '-c', `user.email=${author.email}`,
      'commit', '--quiet', '-m', message,
    ])
    return true
  }

  const backend = {
    /** 准备工作区：没有就克隆。可重复调用。 */
    async ensureReady() {
      if (isRepo()) return
      mkdirSync(dirname(workDir), { recursive: true })
      // 克隆到临时目录再改名：克隆中途失败时不会留下半个工作区，
      // 否则下次启动会被 isRepo() 误判为已就绪。
      const staging = `${workDir}.staging-${process.pid}-${Date.now()}`
      try {
        git(dirname(workDir), ['clone', '--quiet', '--branch', branch, repoUrl, staging])
      } catch (error) {
        // 空裸库没有 main 分支，直接 clone 会报错。这是「新建云端」的正常情况，
        // 退到不指定分支的克隆。仍然失败才把原始错误交出（已脱敏）。
        try {
          git(dirname(workDir), ['clone', '--quiet', repoUrl, staging])
        } catch {
          rmSync(staging, { recursive: true, force: true })
          throw error
        }
      }
      rmSync(workDir, { recursive: true, force: true })
      renameSync(staging, workDir)
    },

    /** 把远端的新提交取回工作区。 */
    async pull() {
      if (!isRepo()) throw new Error(`工作区未就绪：${workDir}`)
      git(workDir, ['pull', '--quiet', '--no-rebase', 'origin', currentBranch()], {
        allowFailure: true,
      })
    },

    /**
     * 提交并推送到远端。无改动时什么都不做。
     * @returns {Promise<{committed: boolean}>}
     */
    async push(message) {
      if (!isRepo()) throw new Error(`工作区未就绪：${workDir}`)
      if (!commit(message)) return { committed: false }
      git(workDir, ['push', '--quiet', 'origin', currentBranch()])
      return { committed: true }
    },

    /**
     * 读云端文件。不存在返回 null —— 调用方要区分「没有这份配置」与「读取失败」。
     * @returns {Promise<string|null>}
     */
    async readFile(relPath) {
      const abs = join(workDir, relPath)
      if (!existsSync(abs)) return null
      return readFileSync(abs, 'utf8')
    },

    /** 写云端文件并落盘到工作区（提交由 push 统一做）。 */
    async writeFile(relPath, content) {
      const abs = join(workDir, relPath)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf8')
    },

    /** 供界面与错误信息使用，已脱敏。 */
    describe() {
      return `git 仓库 ${safeUrl}（分支 ${branch}）`
    },
  }

  assertBackend(backend)
  return backend
}
```

- [ ] **Step 5: 运行测试，确认通过**

运行：`node --test test/backends-git.test.js`
预期：PASS，10 个测试通过

- [ ] **Step 6: 提交**

```bash
git add src/backends/index.js src/backends/git.js test/backends-git.test.js
git commit -m "介质：后端抽象与 git 实现，凭据交给系统 git 且错误信息脱敏"
```

---

## 六 · 装配

### Task 12: 同步服务与数据组装

把前面 11 个任务产出的模块接成两个动作。设计 §3.2／§3.3 给出了流程，本任务把它落成代码。

**为什么拆成两个阶段，而不是一个 `push()`**：设计 §3.2 第 6、7 步写明了「展示差异 → 用户确认 → commit + push」是**有意的人工确认**——推送是对外可见的写操作。所以服务层必须提供「准备」与「执行」两段，中间把差异交给界面。若做成一个原子 `push()`，这个确认点在架构上就没有位置了。

这是本任务最重要的设计约束，不是实现细节上的取舍。

**Files:**
- Create: `src/service.js`
- Test: `test/service.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/service.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSyncService } from '../src/service.js'

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
  const root = mkdtempSync(join(tmpdir(), 'roam-svc-'))
  const dshRoot = join(root, '.dsh')
  mkdirSync(dshRoot, { recursive: true })
  writeFileSync(join(dshRoot, 'cordis.patch.yml'), PATCH)
  const skillsRoot = join(dshRoot, 'skills')
  mkdirSync(join(skillsRoot, 'demo'), { recursive: true })
  writeFileSync(join(skillsRoot, 'demo', 'SKILL.md'), '# demo\n')
  return { root, dshRoot, skillsRoot, workDir: join(root, 'cloud') }
}

test('preparePush 组装出云端结构，且不含本机项', async () => {
  const { root, dshRoot, skillsRoot, workDir } = sandbox()
  const backend = fakeBackend()
  const service = createSyncService({ backend, workDir, dshRoot, skillsRoot })

  const plan = await service.preparePush({ generatedBy: 'test-machine' })

  const patch = backend.files['config/profile.patch.yml']
  assert.ok(patch === undefined, 'preparePush 不应直接写后端 —— 确认点之前不许落盘')
  assert.ok(plan.files.some(f => f.path === 'config/profile.patch.yml'))
  const patchFile = plan.files.find(f => f.path === 'config/profile.patch.yml')
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

test('技能随推送进入云端，且保留可执行位信息', async () => {
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
  // 云端已有一份不同的 patch
  const remote = fakeBackend({
    'config/profile.patch.yml': '- id: llm-pi-ai\n  config:\n    providers:\n      x:\n        apiKeyEnv: X\n',
    'snapshot.json': JSON.stringify({ schemaVersion: 1, generatedAt: 'T', generatedBy: 'other', entries: [] }),
  })
  const service = createSyncService({ backend: remote, workDir, dshRoot, skillsRoot })

  const before = (await import('node:fs')).readFileSync(join(dshRoot, 'cordis.patch.yml'), 'utf8')
  const plan = await service.preparePull()
  const after = (await import('node:fs')).readFileSync(join(dshRoot, 'cordis.patch.yml'), 'utf8')

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

  const { parsePatchList } = await import('../src/yaml-loader.js')
  const { readFileSync } = await import('node:fs')
  const after = parsePatchList(readFileSync(join(dshRoot, 'cordis.patch.yml'), 'utf8'))
  assert.equal(after.find(r => r.id === 'webserver').config.host, '10.0.0.9', '本机值不得被改')
  assert.ok(after.find(r => r.id === 'llm-pi-ai').config.providers.x, '公共条目应已应用')
  assert.ok(report.backupPath, '报告应含备份位置')
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
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`node --test test/service.test.js`
预期：FAIL，`Cannot find module '../src/service.js'`

- [ ] **Step 3: 实现同步服务**

创建 `src/service.js`：

```js
/**
 * 同步服务：把读路径、数据模型、写路径、介质层接成推送与拉取两个动作。
 *
 * 本模块的核心设计约束来自设计 §3.2 第 6、7 步：
 * 「展示差异 → 用户确认 → commit + push」是**有意的人工确认**，
 * 因为推送是对外可见的写操作。
 *
 * 所以两个方向都拆成 prepare / confirm 两段：
 *   - prepareXxx：只读，算出要写什么与差异，绝不落盘、绝不改本机文件
 *   - confirmPush / applyPull：真正执行写入
 *
 * 只要 prepare 阶段有任何写副作用，「确认」这个动作就名存实亡了。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parsePatchList, renderPatches } from './yaml-loader.js'
import { extractShared } from './extract.js'
import { buildSnapshot, serializeSnapshot } from './snapshot.js'
import { diffSnapshots, summarizeDiff } from './diff.js'
import { applyPatchFile, verifyWriteBack } from './apply.js'
import { scanSkills, listSkillNames } from './skills.js'
import { assertBackend } from './backends/index.js'

/** 云端布局，见设计 §5.1。 */
export const CLOUD_PATHS = Object.freeze({
  snapshot: 'snapshot.json',
  patch: 'config/profile.patch.yml',
  bundles: 'config/bundles.json',
  notes: 'notes.md',
})

function hashOf(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * 从 patch 文本里收集 provider 的 apiKeyEnv 引用名。
 *
 * 引用名不是密钥（设计 §6.2），但新机器上若没配这个环境变量，
 * 一发消息就会认证失败。报告提前把它列出来，用户就不必猜。
 *
 * @param {object[]} rows
 * @returns {string[]}
 */
export function collectApiKeyRefs(rows) {
  const refs = []
  for (const row of rows) {
    const providers = row?.config?.providers
    if (providers === undefined || typeof providers !== 'object') continue
    for (const def of Object.values(providers)) {
      const ref = def?.apiKeyEnv
      if (typeof ref === 'string' && ref !== '' && !refs.includes(ref)) refs.push(ref)
    }
  }
  return refs.sort()
}

/**
 * 建一个同步服务。
 * @param {{backend: object, workDir: string, dshRoot: string, skillsRoot?: string}} config
 */
export function createSyncService(config) {
  const { backend, workDir, dshRoot } = config
  const skillsRoot = config.skillsRoot ?? join(dshRoot, 'skills')
  assertBackend(backend)

  const patchFile = join(dshRoot, 'cordis.patch.yml')

  /** 读本机 patch 条目。文件不存在时视为空。 */
  function readLocalRows() {
    if (!existsSync(patchFile)) return []
    const text = readFileSync(patchFile, 'utf8')
    return text.trim() === '' ? [] : parsePatchList(text)
  }

  /** 收集技能文件内容：{ 'skills/<名>/<相对路径>': 内容 }。 */
  function collectSkillFiles() {
    const out = {}
    for (const name of listSkillNames(skillsRoot)) {
      for (const record of scanSkills(skillsRoot, [name])) {
        const abs = join(skillsRoot, record.relPath)
        out[`skills/${record.relPath}`] = readFileSync(abs, 'utf8')
      }
    }
    return out
  }

  return {
    /**
     * 推送准备：组装要写入云端的文件与差异。**只读，不写任何地方。**
     * @param {{generatedBy: string, bundles?: object, now?: Date}} input
     * @returns {Promise<{files: {path: string, content: string}[], diff: object[], summary: object}>}
     */
    async preparePush(input = {}) {
      const rows = readLocalRows()
      const { patch } = extractShared({ patchRows: rows })

      const patchContent = renderPatches(patch, 'settings-roam')
      const files = [
        { path: CLOUD_PATHS.patch, content: patchContent },
        ...Object.entries(collectSkillFiles()).map(([path, content]) => ({ path, content })),
      ]
      if (input.bundles !== undefined) {
        files.push({ path: CLOUD_PATHS.bundles, content: JSON.stringify(input.bundles, null, 2) + '\n' })
      }

      // 与云端现状比对，供界面展示
      await backend.pull()
      const remoteSnapshotText = await backend.readFile(CLOUD_PATHS.snapshot)
      const remoteEntries = remoteSnapshotText === null
        ? []
        : (JSON.parse(remoteSnapshotText).entries ?? [])

      const localSnapshot = buildSnapshot({
        generatedBy: input.generatedBy ?? 'unknown',
        generatedAt: (input.now ?? new Date()).toISOString(),
        files,
      })
      const diff = diffSnapshots({ entries: remoteEntries }, localSnapshot)

      const snapshotFile = {
        path: CLOUD_PATHS.snapshot,
        content: serializeSnapshot({
          ...localSnapshot,
          entries: [
            ...localSnapshot.entries,
            ...Object.entries(remoteEntries)
              .filter(([path]) => !localSnapshot.entries.some(e => e.path === path))
              .map(([, entry]) => entry),
          ],
        }),
      }

      return {
        files: [...files, snapshotFile],
        diff,
        summary: summarizeDiff(diff),
        patchRows: patch,
      }
    },

    /**
     * 执行推送：把 prepare 的结果写入云端。这一步之后内容对外可见，故须用户确认。
     * @param {object} plan - preparePush 的返回
     * @param {string} [message]
     */
    async confirmPush(plan, message = '设置漫游：推送') {
      await backend.ensureReady()
      for (const file of plan.files) {
        await backend.writeFile(file.path, file.content)
      }
      await backend.push(message)
      return { pushed: plan.files.map(f => f.path) }
    },

    /**
     * 拉取准备：算出云端与本机的差异。**只读，绝不改本机文件。**
     * @returns {Promise<{diff: object[], summary: object, remoteFiles: object}>}
     */
    async preparePull() {
      await backend.ensureReady()
      await backend.pull()

      const patchText = await backend.readFile(CLOUD_PATHS.patch)
      const remoteRows = patchText === null ? [] : parsePatchList(patchText)

      const localRows = readLocalRows()
      const localEntries = localRows.map(row => ({
        path: `patch:${row.id}`,
        kind: 'shared',
        hash: hashOf(JSON.stringify(row)),
      }))
      const remoteEntries = remoteRows.map(row => ({
        path: `patch:${row.id}`,
        kind: 'shared',
        hash: hashOf(JSON.stringify(row)),
      }))

      const diff = diffSnapshots({ entries: localEntries }, { entries: remoteEntries })
      return {
        diff,
        summary: summarizeDiff(diff),
        remoteRows,
        remotePatchText: patchText,
      }
    },

    /**
     * 执行拉取：应用配置、出报告。
     *
     * 文件类配置走备份 → 合并 → 写入 → 回读校验（Task 9、10 已有的两条约束）。
     * @param {object} plan - preparePull 的返回
     * @param {{backupRoot: string}} options
     * @returns {Promise<object>} RestoreReport
     */
    async applyPull(plan, options) {
      const applied = []
      const skipped = []

      if (plan.remoteRows.length > 0) {
        const result = applyPatchFile({
          targetFile: patchFile,
          sharedRows: plan.remoteRows,
          backupRoot: options?.backupRoot,
        })

        // 写后回读校验：C2 的落地。警告非空即视为失败，不静默放过。
        const check = verifyWriteBack(patchFile, plan.remoteRows)
        if (result.ok && check.ok) {
          for (const id of result.applied) {
            applied.push({ kind: 'file', name: `patch:${id}`, result: 'ok' })
          }
        } else {
          for (const id of [...result.warnings, ...check.missing, ...check.mismatch]) {
            skipped.push({ kind: 'file', name: String(id), result: 'skipped', reason: 'unknown' })
          }
        }
      }

      return {
        applied,
        skipped,
        needsRestart: applied.length > 0,
        needsCredentials: collectApiKeyRefs(plan.remoteRows),
        backupPath: options?.backupRoot ?? '',
      }
    },
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`node --test test/service.test.js`
预期：PASS，7 个测试通过

- [ ] **Step 5: 提交**

```bash
git add src/service.js test/service.test.js
git commit -m "服务：推送与拉取各拆 prepare/confirm 两段，确认点前绝不落盘"
```

---

### Task 13: 恢复报告

设计 §5.2 定义了 `RestoreReport` 结构，设计决策 8 补了一条产品要求：**恢复后的「体验断裂」必须显式提示**——主题、权限、默认模型已判为本机，拉取完成后界面与默认行为和来源机器不同，用户可能误以为恢复失败。

本任务的职责不只是格式化数据，而是**把机器状态翻译成人能看懂的话**。设计 §3.4 第 2 条说得很直白：跳过时「不能只报一句失败」。

**Files:**
- Create: `src/report.js`
- Test: `test/report.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/report.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SKIP_REASONS, explainSkip, buildReportView } from '../src/report.js'

test('四类跳过原因都有针对性的说明，不是一句「失败」', () => {
  const seen = new Set()
  for (const reason of ['local-path-source', 'version-incompatible', 'registry-unreachable', 'build-blocked', 'unknown']) {
    const text = explainSkip({ reason, name: 'demo-plugin' })
    assert.ok(typeof text === 'string' && text.length > 10, `${reason} 应有足够具体的说明`)
    seen.add(text)
  }
  assert.equal(seen.size, 5, '每类原因的说明必须彼此不同')
})

test('两种跳过原因指向同一个插件时，说明也不相同', () => {
  const a = explainSkip({ reason: 'local-path-source', name: 'demo' })
  const b = explainSkip({ reason: 'build-blocked', name: 'demo' })
  assert.notEqual(a, b)
})

test('本机路径来源的说明要指出原始路径', () => {
  const text = explainSkip({ reason: 'local-path-source', name: 'demo', detail: '/home/alice/src/demo' })
  assert.ok(text.includes('/home/alice/src/demo'), '要指出是哪条路径')
})

test('版本不兼容要说明这是保护而非故障', () => {
  const text = explainSkip({ reason: 'version-incompatible', name: 'demo' })
  assert.ok(/保护|不是故障|并非故障/.test(text), '要让用户理解这不是故障')
})

test('跳过时必须能看出这个插件当前到底装没装', () => {
  const view = buildReportView({
    applied: [],
    skipped: [{ kind: 'plugin', name: 'demo', result: 'skipped', reason: 'build-blocked' }],
    needsRestart: false,
    needsCredentials: [],
    backupPath: '/tmp/bk',
  })
  assert.equal(view.plugins.length, 1)
  assert.ok(view.plugins[0].installed === false, '应明确标出未安装')
})

test('报告要提示本机偏好未随行，避免被误读为恢复失败', () => {
  const view = buildReportView({
    applied: [{ kind: 'file', name: 'patch:llm-pi-ai', result: 'ok' }],
    skipped: [],
    needsRestart: true,
    needsCredentials: ['DEMO_KEY'],
    backupPath: '/tmp/bk',
  })
  assert.ok(view.notices.some(n => n.includes('本机')), '应有本机偏好说明')
  assert.ok(view.notices.some(n => n.includes('DEMO_KEY')), '应列出要补的密钥')
  assert.ok(view.notices.some(n => n.includes('重启')), '应提示重启')
  assert.equal(view.empty, false)
})

test('空报告不产生误导性的提示', () => {
  const view = buildReportView({
    applied: [], skipped: [], needsRestart: false, needsCredentials: [], backupPath: '/b',
  })
  assert.equal(view.empty, true)
  assert.deepEqual(view.notices, [], '没有变化时不应提示重启或密钥')
})

test('跳过原因常量表覆盖设计规定的全部取值', () => {
  assert.deepEqual(
    [...SKIP_REASONS].sort(),
    ['build-blocked', 'local-path-source', 'registry-unreachable', 'unknown', 'version-incompatible'],
  )
})
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`node --test test/report.test.js`
预期：FAIL，`Cannot find module '../src/report.js'`

- [ ] **Step 3: 实现报告模块**

创建 `src/report.js`：

```js
/**
 * 恢复报告：把机器状态翻译成人能看懂的话。
 *
 * 设计 §3.4 第 2 条：「失败即跳过并显示，不能只报一句失败」。
 * 所以这里的核心不是格式化，而是为每一类跳过原因给出一条具体、可据以行动的说明。
 *
 * 设计决策 8 另有一条产品要求：恢复后的「体验断裂」要显式提示。
 * 主题、权限、默认模型已判为本机，拉取完成后界面与默认行为和来源机器不同，
 * 用户很可能误以为恢复失败。这句话必须出现在报告里，而不是留给用户自己猜。
 */

/** 跳过原因，取值见设计 §5.2 的 SkipReason。 */
export const SKIP_REASONS = Object.freeze([
  'local-path-source',
  'version-incompatible',
  'registry-unreachable',
  'build-blocked',
  'unknown',
])

/**
 * 为一类跳过原因给出说明。
 * @param {{reason: string, name: string, detail?: string}} item
 * @returns {string}
 */
export function explainSkip(item) {
  const { reason, name } = item
  const detail = item.detail ?? ''
  switch (reason) {
    case 'local-path-source':
      return `${name} 来自本机的目录路径${detail === '' ? '' : `（${detail}）`}，这台机器上没有这个目录。`
        + '把它发布到 registry 或 git 之后才能同步过来。'
    case 'version-incompatible':
      return `${name} 要求的 DSH 版本与这台机器不一致，官方安装流程拒绝了安装。`
        + '这是保护而不是故障——版本不符时装上去会让 DSH 起不来。'
        + '把两台机器的 DSH 升到同一版本后重试。'
    case 'registry-unreachable':
      return `${name} 没能从 registry 取到包，可能是网络或 registry 地址不通。`
        + '确认这台机器能访问 npm registry，然后再拉取一次。'
    case 'build-blocked':
      return `${name} 的安装脚本需要批准后才能运行。`
        + '在 DSH 里批准这个插件的构建脚本，然后重新拉取。'
    default:
      return `${name} 未能恢复，原因不明。`
        + '它的配置没有被修改；可以单独重试这一个插件。'
  }
}

/**
 * 把 RestoreReport 转成界面与提示可用的视图模型。
 * @param {object} report - RestoreReport，见设计 §5.2
 * @returns {{applied: object[], skipped: object[], plugins: object[], notices: string[], empty: boolean}}
 */
export function buildReportView(report) {
  const applied = report?.applied ?? []
  const skipped = report?.skipped ?? []
  const needsCredentials = report?.needsCredentials ?? []

  const plugins = skipped
    .filter(item => item.kind === 'plugin')
    .map(item => ({
      name: item.name,
      // 设计 §3.4 第 3 条：跳过时必须能看出这个插件当前装没装。
      installed: false,
      explanation: explainSkip(item),
    }))

  const notices = []
  if (applied.length === 0 && skipped.length === 0) {
    return { applied, skipped, plugins, notices: [], empty: true }
  }

  if (applied.length > 0) {
    notices.push('本机的主题、工具权限预设与默认模型属于本机配置，不会随拉取改变，'
      + '所以界面与默认行为和来源机器可能不同。这不是恢复失败。')
  }
  if (needsCredentials.length > 0) {
    notices.push(`以下环境变量需要在每台机器上各自配置：${needsCredentials.join('、')}。`
      + '密钥本身不进云端，缺了它会一发消息就认证失败。')
  }
  if (report?.needsRestart === true) {
    notices.push('配置已写入，需要重启 DSH 后生效。')
  }

  return { applied, skipped, plugins, notices, empty: false }
}
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`node --test test/report.test.js`
预期：PASS，8 个测试通过

- [ ] **Step 5: 提交**

```bash
git add src/report.js test/report.test.js
git commit -m "报告：四类跳过原因各给可行动的说明，并提示本机偏好未随行"
```

---

### Task 14: 插件装载层与设置界面

把已经写好但**还装不进 DSH** 的插件骨架补齐：`index.js`（宿主半侧）、`client.js`（浏览器半侧）、`cordis.patch.yml`、`icon.svg`、`locale/`。package.json 早已声明了这五样，但文件都不存在。

#### 14.0 装载前必须知道的四条硬约束

这四条是查官方源码与文档实测得到的，不是推断。任何一条搞错，插件都装不上或装上后界面空白。

| # | 约束 | 依据 |
|---|---|---|
| E1 | 宿主提供的是**已构建**的客户端 bundle，缺失 bundle 会**明确导致激活失败** | `packages/client/modules/README.zh.md` 构建要求节 |
| E2 | 浏览器半侧只挂在说明符恰为**裸包名**的那一行上；从子路径导出挂载的行永远不带半侧 | `docs/cookbook/adding-a-settings-card.zh.md` 第 5 节 |
| E3 | `client.js` 必须是 **lazy-CJS factory** 格式：调用 `window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 内用 `require('react')` 这类裸说明符解析依赖，**不要 import map、不要全局变量** | `packages/client/tsdown.client.ts` 文件头注释；官方 `packages/session-query/session-log-export/lib/client.js` 实际形态 |
| E4 | 该格式**可以手写**——官方自己 12KB 的小 bundle 就是这个形态，不依赖特定打包器产物 | 同上实物比对 |

**E4 是「纯 JS 无构建」路线成立的唯一依据。** 若 E4 不成立，就必须引入 tsdown + TypeScript，而 `clientBundle` 预设不在任何已发布的包里（文档原话：「仓库之外的包要自己复刻这一步构建」），代价会很大。所以本任务第一步是**先验证 E4**，再动手写界面。

#### 14.1 界面决策（设计 §7.3，已定）

| # | 决策 | 选择 |
|---|---|---|
| U1 | 推送前确认 | 每次推送都弹差异预览，等确认 |
| U2 | 拉取入口 | 仅设置页一节（slot `settings.section`） |
| U3 | 文案调性 | 极简，只给一句话 |

**U3 与设计 §3.4 的张力必须显式处理**：§3.4 要求跳过时「不能只报一句失败」。U3 的「极简」指不铺垫、不解释设计意图，**不是省掉行动指引**。落到代码上就是：外层没有解释性引言，但每条跳过项仍带 `explainSkip()` 产出的那一句可行动说明（Task 13 已实现）。这两条不矛盾，但容易在实现时被误读成「界面只显示一个失败计数」，那会直接违反 §3.4。

**U1 是服务层拆成 `preparePush` / `confirmPush` 两段的原因**（Task 12 已按此实现）。界面只负责把 `preview` 渲染出来并调用 `confirmPush`。

#### 14.2 槽位 API（实测签名，照抄不要改）

真实注册代码见 `packages/client/ui-agent-preset/src/client/index.ts:267-275`：

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'settings.roam',
  order: 100,
  label: () => ctx.locale.bind('settings.roam')('nav'),
  locale: 'settings.roam',
  inject: () => ({ ... }),
}, SectionComponent))
```

三个候选落点在槽位树中的位置（`docs/subsystems/slots.zh.md`）：

```
sidebar
├─ sidebar.panellist
└─ sidebar.settings
   └─ settings.section      ← U2 选定
shell
└─ shell.overlay
```

**注意**：`settings.section` 在槽位树里写作 `sidebar.settings.settings.section`，但其注册名是**字符串 `'settings.section'`**，不是路径。照抄上面实测签名。

**Files:**
- Create: `index.js`
- Create: `client.js`
- Create: `cordis.patch.yml`
- Create: `icon.svg`
- Create: `locale/zh.json`、`locale/en.json`
- Create: `test/loader-shape.test.js`
- Modify: `package.json`（补 `dsh.client`）

---

- [ ] **Step 1: 先验证 E4——手写 lazy-CJS bundle 能否被真装载**

这一步是本任务的成立性前提，**必须先做**。在做界面之前，先写一个最小体量的 `client.js` 装进去，确认它被客户端模块系统接受。

先写测试固化产物形态（真装载在 Step 8 手工验收）：

创建 `test/loader-shape.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')

test('package.json 声明的每个文件都真实存在', () => {
  const pkg = JSON.parse(read('package.json'))
  for (const f of pkg.files) {
    // files 里的目录项也要存在
    assert.ok(existsSync(join(root, f)), `package.json 的 files 声明了 ${f}，但文件不存在`)
  }
})

test('客户端 bundle 是 lazy-CJS factory 形态（E3）', () => {
  const src = read('client.js')
  assert.match(src, /__ModuleLoader__\.load\(/, '必须调用 window.__ModuleLoader__.load')
  assert.match(src, /factory\s*[:(]/, '必须提供 factory')
  assert.ok(
    !/^\s*import\s/m.test(src),
    '不得使用 ESM import——解析靠注入的 require，不是 import map',
  )
})

test('客户端 bundle 登记的 id 与包名一致', () => {
  const pkg = JSON.parse(read('package.json'))
  const src = read('client.js')
  const id = pkg.name
  assert.ok(src.includes(`"${id}"`) || src.includes(`'${id}'`), `bundle 里的 id 必须是 ${id}`)
})

test('浏览器半侧挂在裸包名那一行（E2）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.dsh?.client, 'package.json 必须有 dsh.client')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject), 'inject 必须是数组')
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'),
    '要往设置分区贡献界面，必须 inject ui-settings',
  )
})

test('宿主半侧导出 apply，且不依赖构建产物', () => {
  const src = read('index.js')
  assert.match(src, /export\s+(async\s+)?function\s+apply\s*\(/, '宿主半侧必须导出 apply')
  assert.ok(!src.includes('lib/'), '宿主半侧不得引用 lib/ 构建产物')
})

test('patch 文件把自己插进 Loader（E1 的配套）', () => {
  const src = read('cordis.patch.yml')
  const pkg = JSON.parse(read('package.json'))
  assert.match(src, /- insert:/, 'patch 必须用 insert 把自己插进 Loader')
  assert.ok(src.includes(pkg.name), 'patch 里的 name 必须是裸包名（E2）')
})
```

- [ ] **Step 2: 运行测试，确认全部失败**

运行：`node --test test/loader-shape.test.js`

预期：FAIL。报错指向 `index.js`、`client.js`、`cordis.patch.yml` 不存在。这正是要修的缺口。

- [ ] **Step 3: 写 `cordis.patch.yml`**

参照官方 `dshmarket` 的形态（`~/.dsh/profiles/web/node_modules/dshmarket/cordis.patch.yml`），它的 patch 极简，只有一行 insert：

```yaml
# dsh-settings-roam: inserts this plugin into the profile's layer stack.
- insert:
    - id: dsh-settings-roam
      name: '@toookamak/dsh-settings-roam'
```

**用 insert 而不是 id-patch**：这与本项目 V1 验证的规则一（C1）一致——目标行不存在时必须 insert，id-patch 打空行会静默跳过并只在 warn 回调里报一句。我们自己的 patch 更要守这条。

`name` 必须是**裸包名**（E2），写成子路径会导致浏览器半侧挂不上。

- [ ] **Step 4: 写 `index.js`（宿主半侧）**

宿主半侧的职责：注册一个工具供模型调用，把 Task 12 的服务暴露出去。**真实的工具注册 API 见官方 Task 相关文档**；本期先做到「插件能被加载、设置分区能出现」为止，工具注册若接口不确定就留 TODO 并在文档里记明，不要凭印象写。

```js
import { createSyncService } from './src/service.js'

export const name = 'settings-roam'
export const inject = ['settings', 'skills']

/**
 * 设置漫游的宿主半侧。
 *
 * 浏览器半侧（client.js）负责界面，这里只负责在宿主侧建立服务实例，
 * 供界面经由槽位的 inject 与后续的工具调用使用。
 */
export function apply(ctx, config) {
  const service = createSyncService({
    dshRoot: config?.dshRoot,
    backend: config?.backend,
  })

  // 供浏览器半侧读取的数据入口。挂在 ctx 上而不是导出模块级单例，
  // 因为一个进程可能加载多份 profile。
  ctx.settingsRoam = { service }

  ctx.logger?.info?.('设置漫游已就绪')
}
```

- [ ] **Step 5: 写 `client.js`（浏览器半侧，手写 lazy-CJS）**

严格按 E3 的格式。下面是最小可用形态，依赖只取 `react` 与设置分区注入进来的能力：

```js
window.__ModuleLoader__.load({
  id: '@toookamak/dsh-settings-roam',
  factory: (require) => {
    const React = require('react')

    // U3：极简文案，只给一句话。
    // 注意与设计 §3.4 的关系——极简指不铺垫，不是省掉行动指引。
    function StatusLine({ state }) {
      if (state.kind === 'empty-cloud') return React.createElement('div', null, '云端还没有内容。先在这台机器上推送一次。')
      if (state.kind === 'has-diff') return React.createElement('div', null, `云端有 ${state.count} 项变化待拉取。`)
      return React.createElement('div', null, '已与本机一致。')
    }

    function Section({ slots }) {
      const view = slots?.report ?? { kind: 'clean' }
      return React.createElement(
        'div',
        null,
        React.createElement(StatusLine, { state: view }),
      )
    }

    return { Section }
  },
})
```

**这一段就是 E4 的验证物**：它没有经过任何打包器，全是手写的普通 JS。若 Step 8 的真装载通过，则「纯 JS 无构建」路线成立，后续界面继续用这个形态扩写；若不通过，则必须在这里停下，引入 tsdown 并把结论写回设计文档。

- [ ] **Step 6: 补 `package.json` 的 `dsh.client` 与 `icon.svg`、`locale/`**

`package.json` 补（保持 `bundle.patch` 不变，它是宿主半侧的装载）：

```jsonc
"dsh": {
  "bundle": { "patch": ["./cordis.patch.yml"] },
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-settings"]
  }
}
```

`icon.svg`：单色矢量图标，随主题着色，不含文字。

`locale/zh.json` 与 `locale/en.json`，照官方 `dshmarket` 的形态：

```json
{
  "meta": {
    "title": "设置漫游",
    "description": "把可移植的配置推到云端，在新机器上拉回来。"
  }
}
```

- [ ] **Step 7: 运行测试，确认通过**

运行：`node --test test/loader-shape.test.js`
预期：PASS，6 个测试通过

再跑全量：`npm test`，确认既有 76 个用例没有回归。

- [ ] **Step 8: 真装载验收（本任务的关键一步，手工）**

这一步**不能用单元测试替代**。E1／E4 是装载期的行为，只有真装一次才算验证。

1. 把插件挂进一个测试 profile
2. 启动 DSH，确认进程没有因缺 bundle 而激活失败（E1）
3. 打开设置，确认「设置漫游」分区出现（U2 落点生效）
4. 确认界面渲染出文案（E4 成立）

**若第 4 步界面空白但分区在**：说明 bundle 格式有偏差，回到 E3 逐条对照。
**若第 2 步就激活失败**：说明 E1 被触发，检查 `dsh.client` 是否声明完整。

把这次验收的结论（通过或偏差）追加到本任务末尾，作为 E4 的实测记录。

#### 14.3 真装载验收实测记录（2026-10-15）

**结论：E4 成立，「纯 JS 无构建」路线可用。同时暴露三个单元测试抓不到的缺陷。**

验收脚本：`scripts/verify-load.mjs`（可重复执行，自建隔离 DSH_HOME，不碰用户 profile）。

**通过的项：**

| 项 | 结果 |
|---|---|
| 手写 lazy-CJS bundle 被模块加载器接受 | ✓ 登记的 id 是裸包名，`factory(require)` 内 `require('react')` 正常解析 |
| 插件条目进入 Loader 组合树 | ✓ `--dump-config` 出现 `# == @toookamak/dsh-settings-roam` 层注释 |
| 插件被成功激活 | ✓ 启动时无 `1 entry did not activate` 告警 |
| DSH 正常启动到服务监听阶段 | ✓ |

**暴露的三个缺陷（按发现顺序，全部由真装载发现，单元测试零覆盖）：**

1. **数据根目录取到 undefined**
   `apply` 把 `dshRoot` 当成 `config` 字段，而 `cordis.patch.yml` 里根本没有它，
   于是 `join(undefined, ...)` 崩溃。**教训：DSH 装在哪是运行环境事实，不是用户配置。**
   用户不可能知道也不该被要求填一个绝对路径。改为走官方语义解析（`src/home-paths.js`）。

2. **后端必须在装配时就存在**
   `createSyncService` 无条件 `assertBackend(backend)`，但仓库地址只能由用户在界面填，
   YAML 里传不进对象实例。**教训：插件应当能「装着但待配置」，而不是装不上。**
   改为惰性构造：`backend` 可以是实例、工厂或 undefined，未配置时给
   「还没配置云端仓库」这样的可行动说明，并新增 `isConfigured()` 供界面判断。

3. **直接往 ctx 赋值被 DI 拒绝**
   `ctx.settingsRoam = {...}` 抛 `cannot set property "settingsRoam" without provide`。
   **教训：Cordis 的 DI 纪律——服务必须经 `ctx.provide(name, value)` 注册**，
   它同时提供了随 fiber 清理的 disposer，比模块级单例正确。
   官方同类用法见 `packages/deliverables/workspace-changes/src/index.ts:120`。

**第三个缺陷是这三个里最有价值的**：它说明「往 ctx 上挂东西」这个在普通 Node 里最自然的写法，
在 Cordis 里是被明确禁止的。若不真装载一次，这个错误会一直潜伏到用户安装时才爆发。

**顺带发现并修复的一处测试卫生问题：**
`test/backends-git.test.js` 的 `sandbox()` 把裸库建在独立临时目录，但清理只删了 `root`，
导致每跑一次测试就往 `/tmp` 残留一批目录（实测累积 78 个）。已改为 `cleanup()` 一并删除。

**未能实测的一项（诚实标注）：** Step 8 第 3、4 步（设置分区出现、界面渲染文案）
需要浏览器交互，本脚本只能验证到「宿主半侧激活 + 无装载期错误」。
界面是否真的渲染出来，留待 Task 15 端到端演练用浏览器确认。

- [x] **Step 9: 提交**

```bash
git add index.js client.js cordis.patch.yml icon.svg locale test/ scripts/ package.json src/service.js
git commit -m "装载层：宿主半侧、手写 lazy-CJS 浏览器半侧与真装载验收"
```

---

### Task 15: 端到端演练与验收

前面 14 个任务都是分模块验证的。本任务把整条链路在真实环境里走一遍，验证的是**设计 §3.2／§3.3 的两个流程能否真的跑通**，而不是某个函数返回什么。

**这一任务的价值在于发现「各模块都对、连起来不对」的问题。** 前 14 个任务各自绿灯并不能推出整链路成立——契约边界、时序、真实 DSH 的行为差异都只在这里暴露。

**Files:**
- Create: `docs/superpowers/plans/phase1-drill-log.md`（演练记录，含实测输出）

- [ ] **Step 1: 准备两台机器状态（或两个 profile 模拟）**

用两个独立的 `.dsh` 根目录模拟两台机器。准备主机 A 与从机 B，两者都配好一个可用的 git 后端（本地裸仓库即可，不需要真远端）。

- [ ] **Step 2: 走通推送流程（设计 §3.2）**

在 A 上执行推送的 prepare → 展示 diff → confirm 三段，逐项核对：

| 核对项 | 预期 |
|---|---|
| 公共线只含 `llm-pi-ai` | patch 里只有这一项进快照 |
| `webserver.host` 的局域网 IP **不在**快照里 | 这是本项目要解决的根本问题，必须确认 |
| 未预期的盘外配置触发提示 | 设计 §7.3 的 insert 行风险有告警 |
| 技能目录被收进去 | Task 5 的读写生效 |
| 云端仓库出现一次提交 | git 后端工作正常 |

- [ ] **Step 3: 走通拉取流程（设计 §3.3）**

在 B 上执行拉取，逐项核对：

| 核对项 | 预期 |
|---|---|
| B 的 `cordis.patch.yml` 里 `llm-pi-ai` 被更新 | 按条目合并写回生效 |
| B 自己那 8 项本机配置**一处未动** | 按条目抽取的核心价值 |
| B 的主题、权限、默认模型未变 | 本机判定生效 |
| 报告里出现「本机偏好未随行」的提示 | 设计决策 8 |
| 备份目录里有拉取前的副本 | 回退路径可用 |

- [ ] **Step 4: 反向验证——故意造成失败，确认报告说得清楚**

这一步验证的是**失败时用户能不能看懂**，而不是成功路径。

1. 在快照里放一个来自本机路径的插件，再让 B 拉取 → 确认报告指出是哪条路径、说出来源机器
2. 把 B 的备份恢复回去 → 确认回退可用

- [ ] **Step 5: 记录演练结论**

把每一步的实际输出与偏差写进 `docs/superpowers/plans/phase1-drill-log.md`。**偏差要原样记录，不要只写「通过」**——这是后续任务与二期决策的依据。

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers/plans/phase1-drill-log.md
git commit -m "演练：第一期端到端流程记录与偏差"
```

---

### Task 16: 文档回写

实现完成后，设计文档与 README 必须反映**实际做出来的东西**，而不是当初计划的东西。第一期已经出现过两次「计划假设与实测不符」，不回写就会一直误导后续开发。

**已知需要回写的两处：**

1. **设计 §2.3 关于 update() 失败行为的描述**——原文说匹配不到时「写失败也不报错」。V1 实测表明并非完全不报错，而是经 warn 回调报 `patch: entry <id> not found`（规则 C2）。这是**利好**：原设计假设「不能靠 try/catch 判断失败，必须写后回读」，现在多了更早更轻的信号源，应当在文档里写明。
2. **README 第 60-62 行的「第一个待验证项」**——V1 已完成，该段的时态与措辞需要从「待验证」改为「已验证，结论见…」。

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-dsh-settings-roam-design.md`
- Modify: `README.md`

- [ ] **Step 1: 回写设计文档的 update() 失败行为**

把 §2.3 的相关句子改为实测结论，并注明依据来自 V1 验证（`test/yaml-loader.test.js`）。保留原有的「必须写后回读」要求，但补充 warn 回调是更早的信号源。

- [ ] **Step 2: 回写 README**

第 60-62 行从「待验证」改成「已验证」，结论指向设计文档 §7.3 与 `test/yaml-loader.test.js`。同时更新 README 的「尚未存在的东西」清单——第一期做完后，那些东西大部分已经存在了，**这份清单必须与事实一致，否则它就是错误的文档**。

- [ ] **Step 3: 核对设计文档的引文偏移**

已知一处：设计文档引用 `packages/boot/plugin-manager/src/index.ts:323`，实际 `availability` 的赋值在 `:322`。校对设计文档中所有文件行号引用，修正偏移。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-10-14-dsh-settings-roam-design.md README.md
git commit -m "文档回写：update() 失败行为、README 现状清单、引文行号"
```

---

## 验证结论存档

V1 验证的原始脚本与输出，正式化后归档于：

| 文件 | 内容 |
|---|---|
| `test/yaml-loader.test.js` | 由 V1 的 8 个用例转化而来，是本计划 Task 3 的测试 |
| `docs/superpowers/specs/2026-10-14-dsh-settings-roam-design.md` | 设计文档，本计划的上位依据 |

验证脚本中的机器专属信息（局域网 IP、provider 端点）已全部替换为占位值。
