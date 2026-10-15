# 接手指南：写一个 DSH 插件需要知道的实测事实

**用途**：把实现期间实测到的、踩过坑的 DSH 内部事实集中在一处。
这些知识目前散落在设计文档、实现计划、演练记录与代码注释四处，接手的人不容易找齐。

**本文件的每一条都经过实测，不是推测。** 凡是从官方源码读出来的，都给了文件行号；
凡是脚本验出来的，都指向可重复执行的脚本。**平台无关**——写任何 DSH 插件都用得上，
不限于本项目。

---

## 一、配置层：Loader YAML 方言

### 1.1 patch 文件是顶层数组，按条目切分

`cordis.patch.yml` 是一个顶层 YAML 数组，每个元素是一个「条目」（`- id: xxx` 及其 `config:` 子树）。
**这是可切分的最小单位**，不是文件整体。

实测：本机真实配置 118 行、9 个顶层条目，其中只有 1 项是可跨机器共享的。

**为什么重要**：按文件整体同步会把机器专属值（监听地址、主题、权限）带到别的机器上。
逐条目切分是避免这件事的前提。

相关源码：
- `packages/boot/app-boot/src/index.ts:337` `loadOverlayPatches(binName, file): PatchOptions[]`
- `packages/boot/app-boot/src/index.ts:372` 内部 `yaml.load(content, { schema: userPatchesSchema })`

### 1.2 `!!js` 标签不会被求值，但写法有硬要求

DSH 的方言 schema 支持 `!!js` 表达式标签：

- `vendor/include/src/index.ts:9-15` 定义 `JsExpr` 类型，`construct` 返回 `{__jsExpr: d}`——**不求值**，原样保留
- `vendor/include/src/index.ts:21` `entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)`
- `packages/boot/app-boot/src/index.ts:266` `const userPatchesSchema = entryListSchema`

**里面的内容原样保留、不求值**，所以往返安全。但写法上有坑：

```yaml
# ✗ 错：反引号裸露，YAML 把它当保留指示符
baseURL: !!js `${process.env.HOST}/v1`

# ✓ 对：模板串必须用引号包裹
baseURL: !!js '`${process.env.HOST}/v1`'
```

正确写法见 `packages/mcp/mcp-client/README.md:52`。

**踩坑记录**：写错的报错是
`YAMLException: cannot resolve a node with !<tag:yaml.org,2002:js> explicit tag`，
我先后误判为「两个 js-yaml 实例不兼容」「schema 在独立进程不可用」，逐一排除后才定位到真因。
**教训：脚本报错先怀疑自己的样本，不要先怀疑被测系统。**

### 1.3 写路径的三条硬约束（C1／C2／C3）

这三条是实测得出的官方 Loader 行为事实，**写路径的实现完全由它们决定**。

| # | 约束 | 实测行为 |
|---|---|---|
| **C1** | 目标行不存在时必须用 `insert`，不能用 id-patch | id-patch 打空行**静默跳过**，只经 warn 回调报 `patch: entry <id> not found`，**不抛错** |
| **C2** | warn 回调必须显式收集，**回调非空即视为写入异常** | 匹配失败、`name` 不符，都只经 warn 回调上报 |
| **C3** | 匹配成立时 `config` 是**全量替换**，不是深合并 | 目标行原有的 `extra: keep-me` 被整个抹掉 |

**C3 的独立印证**：官方自己的 `packages/boot/web-app/cordis.patch.yml` 第 5-6 行写道：
「A patch replaces the targeted row's whole `config`, so each row below restates every key it owns.」

**由此派生的实现要求**：合并必须**先在内存里做**——读出本机现状 → 改指定条目 → 整体写回。
不能指望 patch 做局部合并。

**正确示范**（本项目 `cordis.patch.yml` 就是这么写的）：

```yaml
# 用 insert 而不是 id-patch：插件首次安装时目标行必然不存在，
# 用 id-patch 会导致插件永远装不上且没有任何报错。
- insert:
    - id: dsh-settings-roam
      name: '@toookamak/dsh-settings-roam'
```

### 1.4 注释会丢，这是官方行为不是 bug

官方自己的渲染器 `packages/boot/app-boot/src/index.ts:432` `renderConfigDump()`——
即 `dsh --dump-config` 同款——同样会丢掉注释与手工排版。

实测：119 行含 3 行注释 → 渲染后 116 行、1 行注释。

**这不是可以「修好」的东西，而是要提前接受的取舍。** 若你写插件要改写 patch 文件，
应向用户说明这一点。

---

## 二、装配层：Cordis 的 DI 纪律

### 2.1 绝不能往 ctx 上直接挂属性

```js
ctx.settingsRoam = { ... }
// ✗ Error: cannot set property "settingsRoam" without provide
```

源码：`vendor/cordis/src/reflect.ts:178`
（`:258` 是同类检查，`:261` 报「in multiple fibers」）。

**必须走 `ctx.provide(name, value)`**。它同时返回一个随 fiber 清理的 disposer——
这一点比模块级单例正确：插件卸载时服务会自动注销。

```js
// ✓ 对
ctx.provide('settingsRoam', { service, dshRoot, configured: ... })
```

官方同类用法见 `packages/deliverables/workspace-changes/src/index.ts:120`。

**为什么这条最有价值**：「往 ctx 上挂东西」在普通 Node 里是最自然的写法，
在 Cordis 里却被明确禁止。若不真装载一次，这个错误会潜伏到用户安装时才爆发。

### 2.2 数据根目录是运行环境事实，不是用户配置

**不要**把 DSH 的数据根目录做成插件的配置字段。用户不可能知道也不该被要求填一个绝对路径。

```js
// ✗ 错：config.dshHome 通常不存在 → join(undefined, ...) 崩溃
const dshRoot = join(config.dshHome, ...)
```

应当走官方语义解析：`DSH_HOME` 环境变量优先，否则用默认位置
（本项目的 `src/home-paths.js`）。

### 2.3 插件应当能「装着但待配置」

后端对象（如仓库地址、凭据）**没法从 YAML 传进装配阶段**，只有用户能在界面里填。
若 `apply` 里无条件断言后端存在，插件就装不上。

```js
// ✗ 错：仓库地址还没填，插件就装不上了
assertBackend(backend)

// ✓ 对：惰性构造，backend 可以是实例、工厂或 undefined
backend: () => createGitBackend({ repoUrl: config?.repoUrl, workDir })
```

未配置时给**可行动的说明**（「还没配置云端仓库」），并提供一个 `isConfigured()`
供界面判断显示「拉取」还是「去配置」。

### 2.4 声明了 `inject` 就要真的用

`export const inject = ['settings', 'skills']` 表示「缺了这两个服务就不要启动」。
若声明了却从不使用，官方一旦改动服务名，插件会拒绝启动——**但它其实并不需要那个服务**。

---

## 三、浏览器半侧：客户端模块系统

### 3.1 客户端 bundle 必须是 lazy-CJS factory

宿主提供的是**已构建的**客户端 bundle，但**你可以手写**，不必引入打包器：

```js
window.__ModuleLoader__.load({
  id: '@your-scope/your-plugin',        // 必须是裸包名，见 3.2
  factory: (require) => {
    const React = require('react')      // 裸说明符走 loader 的模块表
    // ... 返回你的组件
  },
})
```

**格式约束**：不要改成 ESM `import`。必须由注入的 `require` 解析依赖——
它走 loader 的模块表，不是 import map，也不碰全局。

参考：`packages/client/modules/README.zh.md`，以及官方自己的小 bundle（就是这个形态）。

### 3.2 说明符必须是裸包名

**浏览器半侧只挂在说明符恰为裸包名的那一行上。** 从子路径导出挂载的行永远不带半侧。

```yaml
# ✓ 对
- insert:
    - id: my-plugin
      name: '@your-scope/your-plugin'

# ✗ 错：界面永远不会出现
      name: '@your-scope/your-plugin/client'
```

**重要**：文档曾警告「缺失 bundle 会明确导致激活失败」，且客户端 bundle 通常是打包器产物。
实测确认**手写 lazy-CJS factory 完全可行**——因此无需引入 tsdown 与 TypeScript。

参考：`docs/cookbook/adding-a-settings-card.zh.md` 第 5 节。

### 3.3 往设置分区贡献一节

```js
ctx.slots.inject('settings.section', () => ({ ... }))
```

真实注册范例：`packages/client/ui-agent-preset/src/client/index.ts:267-275`。

**信号**：`settings.section` 用于「拥有自己命名空间的页面」；
宿主半侧为空 `apply` 的伴生包走这条路径。

---

## 四、官方 / 第三方的判定口径

接口里**没有一个是非题**，必须取并集：

```js
const isOfficial = info?.official === true || info?.availability === 'installation'
```

源码（`packages/boot/plugin-manager/src/index.ts`）：

| 行号 | 内容 |
|---|---|
| `:297` | `const shipped = Object.hasOwn(installation.dependencies ?? {}, name)` |
| `:299` | `const official = optional \| offered !== undefined` |
| `:323` | `availability = shipped ? 'installation' : 'profile'` |

**为什么要两项取并集**：`:299` 的 `official` **漏掉了随 DSH 安装本体发布的那批插件**
（`:297` 算了 `shipped` 但没有并入 `official`）。所以官方随安装带的插件，
`official` 可能是 `false`——只能靠 `availability === 'installation'` 兜住。

**另一个独立判据**：`source` 字段仅对**非随安装带的**包写入
（`:318` `owned ? { source: ... } : {}`）。即随安装带的官方包**不写 source**。

---

## 五、读路径：官方接口的失效形态是「静默」

这是本设计必须正视的一点：

| 接口 | 失效形态 |
|---|---|
| `ctx.settings.describe()` | 遇 schema 缺失或 fiber 非 ACTIVE 时 `return []`——**少给，不抛错** |
| `ctx.settings.update()` | 匹配不到时走「无变化」路径——**不抛错**，但经 warn 回调上报 |
| `ctx.skills.snapshot()` | 聚合多个 provider 后的视图，同样可能少给 |

**结论：不能靠 try/catch 判断失败，必须主动校验。**

相关签名：
- `ctx.settings.describe(options?): SettingsDescriptor[]` — `packages/settings/settings/src/index.ts:302`
- `SettingsDescriptor { ns, autoGenerate, schema, value, revision, base?, user?, applies, secrets? }` — 同文件 `:20-31`
- `ctx.settings.update(ns, patch, expectedRevision?): Promise<void>` — 同文件 `:347`
- `ctx.skills.snapshot(options?): Promise<SkillCatalogSnapshot>` 返回 `{ skills, complete }` — `packages/skill/skill/src/index.ts:481`
  - **`complete` 表示「发现是否在稳定版本内完成」**，可用于判断校验通道自身是否可信
- `ctx.skills.list(options?): Promise<SkillSummary[]>` — 同文件 `:470`

**双通道的意义**：主通道走官方接口，校验通道直读文件。最坏情况是「交叉校验报警 + 人工介入」，
而不是「静默同步错内容」。

> **本项目的一个教训**：这条机制实现了、有测试，但**从未接到流程里**——
> `crossCheckSkills()` 全仓库零调用点。功能正确，但安全网不在。
> **测试绿灯不代表机制接上了**，测的是「结果对不对」，不是「有没有走双通道」。

---

## 六、验收方法：三层验证缺一不可

本项目在实现期间，**每一层的缺陷都是上一层抓不到的**：

| 层 | 抓到了什么 |
|---|---|
| 单元测试 | 逻辑正确性。**但抓不到装配、DI、路径语义问题** |
| 真装载验收 | 插件能否被 DSH 装载并激活。抓到了 3 个缺陷：数据根目录 undefined、后端必须装配时就存在、往 ctx 赋值被 DI 拒绝 |
| 端到端演练 | 两条流程在「两台机器」上能否跑通。抓到了报告备份路径错误 |

**真装载验收尤其不可省**：单元测试全绿的情况下，插件可能根本装不上。
项目里的 `scripts/verify-load.mjs` 就是这个用途——自建隔离 `DSH_HOME`，不碰用户 profile。

**写断言的教训**：本项目演练第一版比的是**原始文本**，误报 3 条「本机配置被改动」——
实际只是 `'10.0.0.9'` 被重渲染成 `10.0.0.9`，语义相同。
**凡比对配置是否被改动，必须比语义，不能比文本。**

另有一处断言过弱：`assert.ok(report.backupPath)` 在字段是**错的值**时也为真，
导致一个真实缺陷长期漏网。**断言要能区分「对的值」与「非空的值」。**

---

## 七、速查：最容易踩的五个坑

1. **`!!js` 模板串不加引号** → YAML 解析失败。写法见 §1.2。
2. **用 id-patch 打不存在的行** → 静默跳过，插件永远装不上。用 `insert`。见 §1.3。
3. **往 `ctx` 上直接赋值** → DI 报错，整个条目不激活。用 `ctx.provide`。见 §2.1。
4. **客户端说明符写成子路径**（`.../client`）→ 界面永远不出现。用裸包名。见 §3.2。
5. **只跑单元测试就发布** → 插件可能根本装不上。必须真装载一次。见 §六。

---

## 附：本文件的依据

| 来源 | 内容 |
|---|---|
| [`2026-10-14-dsh-settings-roam-design.md`](../specs/2026-10-14-dsh-settings-roam-design.md) | 设计文档，§2 是 DSH 内部事实的原始记录 |
| [`2026-10-15-dsh-settings-roam-phase1.md`](2026-10-15-dsh-settings-roam-phase1.md) | 实现计划，含 8 条已验证事实表 |
| [`phase1-drill-log.md`](phase1-drill-log.md) | 端到端演练记录，含偏差与遗留缺口 |
| `scripts/verify-load.mjs` | 真装载验收脚本，可重复执行 |
| `scripts/drill-e2e.mjs` | 端到端演练脚本，34 项核对 |
| `test/yaml-loader.test.js` | C1／C2／C3 三条约束的测试依据 |

**DSH 检出路径**：`/home/tokamak/dev/tools/deepseek-harness/`（本文件所有源码行号以此为准）。
