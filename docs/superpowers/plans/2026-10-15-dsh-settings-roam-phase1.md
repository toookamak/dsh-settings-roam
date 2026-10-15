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

（后续任务见下节，本文档按阶段增量补齐）

## 验证结论存档

V1 验证的原始脚本与输出，正式化后归档于：

| 文件 | 内容 |
|---|---|
| `test/yaml-loader.test.js` | 由 V1 的 8 个用例转化而来，是本计划 Task 3 的测试 |
| `docs/superpowers/specs/2026-10-14-dsh-settings-roam-design.md` | 设计文档，本计划的上位依据 |

验证脚本中的机器专属信息（局域网 IP、provider 端点）已全部替换为占位值。
