# DSH 设置漫游（dsh-settings-roam）设计文档

- 日期：2026-10-14
- 状态：设计已确认，待写实现计划
- 包名：`@toookamak/dsh-settings-roam`
- 界面显示名：设置漫游

---

## 1. 目的与需求

### 1.1 要解决的问题

用户通常在多台机器上分别运行一份 DSH。每次更换机器或重新安装，都需要重复执行相同的配置工作：安装插件、配置 provider、恢复技能。目前只能依靠手工操作，或整份复制配置目录——而整份复制会将机器专属项（监听地址、公开主机名、工作区绝对路径）一并带入，导致目标机器的配置被破坏。

### 1.2 需求

| # | 需求 | 来源 |
|---|---|---|
| 1 | 把「公共配置」推送到云端，在新机器上一键拉取并应用 | 用户提出 |
| 2 | 纯手动推拉，没有自动同步、没有定时任务 | 用户要求 |
| 3 | 只同步非密钥内容，密钥永不进云端 | 用户要求 |
| 4 | 插件只记名字，恢复时走官方安装流程重装，不复制插件文件 | 用户要求 |
| 5 | 装不上的跳过并显示原因，不中断其余 | 用户要求 |
| 6 | 推送前展示差异、应用前先备份，全过程可预览可回退 | 用户要求 |
| 7 | 附一份自由文本记事本 `notes.md` | 用户提出 |
| 8 | 支持 Linux + Windows（将来可能 macOS） | 用户要求 |
| 9 | 介质支持 git 与 WebDAV，第一期先做 git，第二期加 WebDAV | 用户要求 |
| 10 | 插件不动用 agent，不生成提交信息 | 用户要求 |

### 1.3 非目标

| 不做的事 | 原因 |
|---|---|
| 自动同步、定时推拉 | 用户明确要求纯手动 |
| 代管密钥（API key、token、密码） | 凭据属于只能由人操作的动作 |
| 备份插件自身的文件 | 只记插件名，恢复走官方安装流程 |
| 恢复会话记录、缓存、日志 | 体积大且含隐私，没有跨机价值 |
| 第一期做本机专属配置的同步 | 第一期只做公共线，本机线第三期实现 |
| 主题偏好、工具权限预设、默认模型、心跳参数 | 用户裁定各机器各自配置，见 §4.3 |
| 第三方插件带来的配置内容 | 公共线只覆盖 DSH 自身与其官方插件，见 §4.4 |

---

## 2. 关键事实

以下均为本次会话中在源码与本机环境中核实过的结论。

### 2.1 配置分层

生效顺序是：bundle 自带的 patch 行 → profile 的 `cordis.patch.yml` → 启动参数的 `--patch` 覆盖层。

**推论**：profile 层只有一个 `cordis.patch.yml`，没有原生的「多个 patch 文件」机制。因此公共配置与本机配置的分离必须由本插件完成，无法靠 DSH 的目录结构。

### 2.2 配置与密钥天然分离

`cordis.patch.yml` 里 provider 写的是**引用名**（形如 `apiKeyEnv: <变量名>`），真密钥在另一个文件 `~/.dsh/.credentials.yaml` 里。

**推论**：只要不把 `.credentials.yaml` 放进快照，「密钥不泄露」自动成立，不需要额外设计。这是本方案里唯一「不需要设计方案、只需要守住纪律」的部分。

### 2.3 对官方接口的依赖：只有 5 个方法，且以双通道设计收敛风险

**依赖面刻意压到最小。** 用户要求「优先优雅的方式，但不保险时要能兜底、要能人工介入」。

| # | 服务 | 方法 | 用途 | 兼容性风险 |
|---|---|---|---|---|
| 1 | `ctx.pluginManager` | `listBundles()` | 取插件名单 | 低。`BundleInfo.name` 是包名，语义最稳定 |
| 2 | `ctx.pluginManager` | `installBundle(spec)` | 恢复安装插件 | 低。`parseInstallSpec` 明确接受裸包名，是官方对外承诺的能力 |
| 3 | `ctx.settings` | `describe()` | 读 profile 配置 | 中。见下 |
| 4 | `ctx.settings` | `update(ns, patch, rev?)` | 写回 profile 配置 | 中。见下 |
| 5 | `ctx.skills` | `snapshot()` | 校验技能清单 | 中。仅作校验通道，见下 |

**1、2 号是躲不开的核心依赖**，它们回答「装了哪些插件」与「装个插件」，恰好是语义最窄、最稳定的两个方法。

**3、4、5 号的失效形态都是「静默」的**，这是本设计必须正视的一点：

- `describe()` 遍历当前活跃 entry，遇到 schema 缺失或 fiber 非 ACTIVE 时 `return []` 静默跳过——**不是抛错，而是少给**。
- `update(ns, patch)` 按 ns 匹配 entry，匹配不到时内部走「无变化」路径——**写失败也不报错**。
- `ctx.skills.snapshot()` 聚合多个 provider 后的视图，同样可能少给。

因此**不能靠 try/catch 判断失败**，必须主动校验。这就是下面双通道设计的由来。

#### 读路径（推送时）：双通道交叉校验

```
主通道   ctx.settings.describe()  → 按归属表挑出公共项
校验通道  直读 cordis.patch.yml   → 按同样规则抽出对应的原始行
交叉比对
  一致   → 静默通过，用主通道的结果
  不一致 → 停下来展示差异，由用户裁决用哪一份，或跳过这一项
```

`describe()` 静默少给的场景恰好会在交叉比对中暴露——因为文件里有那一行，而 `describe()` 没给出对应值。**校验通道正好补上主通道的盲区**，所以两条通道互为校验，而不是简单的「A 失败换 B」。

#### 取哪个值：取「持久值」而不是「运行时值」

`ctx.settings.describe()` 的返回里，每个配置项可能同时带 `base` 与 `value` 两个字段。它们不是重复的：

| 字段 | 含义 |
|---|---|
| `base` | 写在 `cordis.patch.yml` 里的那个值，持久化到磁盘 |
| `value` | 本进程当前实际生效的值，可能来自环境变量插值、`!!js` 表达式求值，或运行时动态调整 |

**推送时一律取 `base`。** 理由：

1. **`value` 会把运行时的东西固化进快照。** 如果某个字段在 `cordis.patch.yml` 里写的是 `!!js` 表达式，`value` 存的是求值结果，推到新机器就变成了硬编码的字面量——表达式本身丢失了。
2. **`value` 可能依赖当前环境。** 环境变量插值产生的值，在另一台机器上未必成立。
3. **`base` 才是「用户配置的内容」。** 本插件同步的是配置意图，不是某次运行的状态；快照在语义上应与 `cordis.patch.yml` 一致，这也让交叉校验成为可能。

> 反过来，`value` 并非无用：**读路径的交叉校验里，`base` 与文件内容比对；如果发现 `base` 与 `value` 不同，说明该项是运行时求值的，应在展示差异时提示用户**——因为这类项跨机搬运后行为可能与来源机器不一致。

#### 写路径（拉取时）：先备份 + 写后回读校验

```
1. 备份本机当前文件
2. 走 ctx.settings.update() 写入
3. 立刻用直读通道确认文件里确实变成了预期值
4. 不符 → 报警，并用备份回退这一项，在报告里列为「需人工处理」
```

写路径**不做自动降级**（两条都试可能产生副作用）。把「静默失败」转成「写后立刻可见的失败」即可。

**关于「失败就跳过」**：写路径上「跳过」比读路径危险——跳过意味着这台机器的配置停在半改状态。所以处置是「回退这一项 + 列为需人工处理」，不是留在那里跳过不管。

#### 技能：以直读为主，官方接口作校验

技能本体就是 `~/.dsh/skills/<名字>/` 下的文件，直读得到的就是要同步的内容，走 `ctx.skills` 反而多一层抽象。所以这里主次**反过来**：以直读为主通道，用 `ctx.skills.snapshot()` 校验；两者不一致时，说明有技能来自非本机的 provider 来源，这本身值得报告。

#### 为什么这套设计让依赖变轻而非变重

直读通道是兜底的。即使 `ctx.settings` 或 `ctx.skills` 在未来版本里改了行为，最坏情况是「交叉校验报警 + 人工介入」，而不是「静默同步错内容」。代价是多一次文件读取和一份比对逻辑。

**仍需自行处理的**：官方服务都是「单个 entry / 单个 namespace」粒度的读写，本插件需要额外做「选出哪些属于公共线 → 打包 → 换机后写回」的组装逻辑。

### 2.4 插件安装流程是可编程调用的

`ctx.pluginManager` 是官方服务，图形界面、agent 工具、命令行走的是同一个。关键点：

- `BundleInfo`（`packages/boot/plugin-manager/src/types.ts:47`）字段：`name`、`official`、`availability`、`version?`、`enabled`、`installed`、`source?`、`installTarget?` 等。
- `parseInstallSpec`（`packages/boot/plugin-manager/src/install-spec.ts:69`）**接受裸包名**，所以名单里只存名字就足以重装。
- `installTarget.spec` 由 `officialBundleInstallTarget(name, installAnchor, version)`（`packages/boot/plugin-manager/src/official-install-target.ts:24`）按**当前运行的 DSH 版本**生成，而不是「最新版」。

### 2.5 不存在可复用的官方同步能力

官方包的完整清单（58 个）中，没有 sync / backup / export / snapshot 之类的包。本期功能需要自建。

### 2.6 「官方」的判定口径

归属表要求「DSH 自身与其官方插件进公共线，用户自行安装的第三方插件不进」。所以需要一个确定的判定口径。

**`BundleInfo.official` 单独用是不够的。** 源码 `packages/boot/plugin-manager/src/index.ts:299` 的计算式是：

```
official = optional || offered !== undefined
```

- `optional`：名字在 `OPTIONAL_BUNDLES`（`packages/boot/app-boot/src/profile.ts:223`，11 个条目）
- `offered`：名字在 `OFFICIAL_ON_DEMAND_CATALOG`（`packages/boot/app-boot/src/official-bundles.generated.ts`，只有 2 个条目）

**它漏掉了随 DSH 安装本体发布的那批插件。** 源码 `index.ts:297` 单独算了一个 `shipped`（`Object.hasOwn(installation.dependencies ?? {}, name)`），但没有并入 `official`。所以官方随安装带的插件，这个字段可能是 `false`。

**采用的判定口径为三条来源的并集**，任一命中即为官方：

| 来源 | 判定方式 | 运行时可见性 |
|---|---|---|
| A. 随 DSH 安装发布 | 名字在 DSH 安装清单的 `dependencies` 里（源码的 `shipped`） | 经 `availability === 'installation'` 间接可得（`index.ts:323`） |
| B. 官方可选包 | 名字在 `OPTIONAL_BUNDLES`（11 条） | 无直接字段，`official` 已含入 |
| C. 官方按需包 | 名字在 `OFFICIAL_ON_DEMAND_CATALOG`（2 条） | 无直接字段，`official` 已含入 |

**落地形式**：`official === true || availability === 'installation'`。

**其中 A 的判定属于语义借用**：`availability` 的语义是「这个包从哪里来」（`'installation' | 'profile' | 'missing'`），不是「是不是官方」。第三方包从 profile 装、官方随安装带的包从 installation 来，按此推导 A 成立，但**必须在实现第一步用实测确认**：

- 第三方插件（本机的 `dsh-soul`、`dsh-git-sentry` 等）应满足 `official === false` 且 `availability === 'profile'`
- 官方随安装带的插件应满足 `availability === 'installation'`

**不用「包名前缀 `@deepseek-ai/`」判定。** 前缀是 npm scope，不是所有权凭证。实践中它与官方判定**目前**等价（这个 scope 外人无法注册），但它会在两种情况下失效：官方发布非该前缀的首方包，或用户从别的 registry 安装了同名包。前缀只作文档与界面上的可读辅助，不作判定依据。

**副产品**：`dsh.profile.bundles` 这个「已启用 bundle」名单是**动态的**——本机就有关闭的官方可选包（`dsh-experimental-ralph-bundle`、`dsh-experimental-cot-translation-bundle`）。所以插件名单不能当作固定快照，每次推送都必须重新读取。

### 2.7 本机环境实测

**机器专属项**（绝不能跨机搬运）：

| 配置项 | 说明 |
|---|---|
| `webserver.host` | 本机局域网 IP，每台机器不同 |
| `dsh-auth-gate` 的 `publicHost` | 本机对外地址，随上一条同源变化 |
| `dsh-auth-gate` 的 `mode` | 本机如何鉴权，不跨机搬运 |
| 工作区绝对路径 | 记录在 `~/.dsh/storages/workspace.json`，每台机器不同 |

> 此处只描述「哪些项属于机器专属」，不记录任何一台机器的实际取值。本仓库是公开的插件仓库，不承载用户的配置内容。

**目录构成**：

```
~/.dsh/
  skills/                    ← 7 个技能
  skills-manager/            ← repositories.json (608 KB), repository-cache/ 等
  storages/                  ← dsh_auth_sessions.json, session_projcache/, workspace.json
  auth/users.yaml
  .credentials.yaml          ← 真密钥，永不进快照
  profiles/web/
    cordis.patch.yml         ← 核心配置（公共与本机混合，需拆分）
    package.json             ← dependencies + dsh.profile.bundles
    pnpm-lock.yaml
    node_modules/            ← 不进快照
```

**插件名单**（profile `package.json` 的 `dsh.profile.bundles`，15 项）：

```
官方：@deepseek-ai/dsh-base
      @deepseek-ai/dsh-web-app
      @deepseek-ai/dsh-experimental-agent-team-profile
      @deepseek-ai/dsh-experimental-inspector-profile
      @deepseek-ai/dsh-experimental-cot-translation-bundle
      @deepseek-ai/dsh-experimental-ralph-bundle

第三方：dsh-auth-gate、dshmarket、dsh-better-sidebar、dsh-context、billion-context、
        dsh-soul、@michengai/dsh-agency-agents、@michengai/dsh-skills-manager、
        @changfenhuang/dsh-genui
```

**注**：`dsh.profile.bundles` 是「哪些包作为 bundle 挂载」的声明，与「装了哪些依赖」（`dependencies`）是两件事。快照需要前者加后者。

---

## 3. 选型与流程

### 3.1 路线选择

讨论过三条路线，选定 **B · 清单 + 差异应用**：

| 路线 | 做法 | 结论 |
|---|---|---|
| A · 快照覆盖式 | 整包推、整包拉，拉下来即覆盖 | 否决：跨平台差异没地方放，无预览无回退 |
| **B · 清单 + 差异应用** | 云端存可移植配置，推前拉前列差异，应用前备份 | **选定**：能容纳多机之间的差异，每步可预览可回退 |
| C · 逐项手工 | 保持现状，只做文档 | 否决：不解决问题 |

### 3.2 推送流程

```
1. 读取本机配置（走 §2.3 的官方接口，必要时直读文件）
2. 按归属表剔除「本机」与「不同步」的项
3. 调 listBundles()，生成插件名单
4. 组装快照 + snapshot.json
5. 写入云端工作副本
6. 展示差异
7. 用户确认 → commit + push
```

第 2 步是本设计的核心动作：公共线不是「复制文件」，而是「按归属表从文件里抽取公共项」。第 6、7 步是有意的人工确认——推送是对外可见的写操作。

### 3.3 拉取流程

```
1. 从云端取回
2. 与本机逐项比对，生成 DiffItem 列表
3. 展示差异
4. 用户确认
5. 备份本机当前文件（带时间戳的目录）
6. 应用文件类配置
7. 恢复插件（逐条走官方流程，失败跳过）
8. 出报告（含 needsCredentials 与 needsRestart）
```

第 5 步是「可回退」的实现方式。第 6、7 步分离：文件类配置是原子的，插件恢复是逐条独立的，两者失败语义不同。

### 3.4 插件恢复规则

1. **逐条独立**：任何一条失败都不中断其余。
2. **失败即跳过并显示**，不能只报一句「失败」：

| 原因 | 触发条件 | 给用户的说明 |
|---|---|---|
| `local-path-source` | `BundleInfo.source` 是绝对路径，目标机器上不存在 | 指出原始路径，建议发布到 registry 或 git |
| `version-incompatible` | 官方流程的 peer 依赖校验不通过 | 指出需要什么版本的 DSH；这是保护而非故障 |
| `registry-unreachable` | registry 或 git host 不可达 | 指出尝试过的 registry |
| `build-blocked` | 安装脚本需要批准 | 列出待批准的构建脚本 |

3. **不留含糊状态**：跳过时必须能看出这个插件当前到底装没装。

### 3.5 分期

| 期 | 内容 |
|---|---|
| 第一期 | 公共线 + git 介质：推送、拉取、差异预览、备份回退、插件重装、记事本 |
| 第二期 | WebDAV 介质：抽出后端接口（取回、推送、比对），加 WebDAV 实现，设置页可切换。**同步逻辑一行不改** |
| 第三期 | 本机线：归属表里判为「本机」的项按机器分开存，复用第一期已写好的四样东西 |

---

## 4. 归属表

### 4.1 中心概念

每个配置项标一个归属：**公共**（三台共享）、**本机**（各机不同）、**不同步**（永不进云端）。归属表是本设计的中心，第一期就写全三态，为第三期预留位置。

### 4.2 归属表内容

**公共线只覆盖 DSH 自身与其官方插件。**

| 配置项 | 归属 | 说明 |
|---|---|---|
| 插件清单（**仅名称**） | 公共 | 名单需区分官方与第三方 |
| provider 定义（名称、地址、模型名、`apiKeyEnv` 引用名） | 公共 | 引用名不是密钥 |
| agent presets | 公共 | |
| 技能（`~/.dsh/skills/`） | 公共 | 含可执行脚本与二进制资源，见 §4.6 |
| 主题偏好（`ui-theme` 的 `preference`） | **本机** | 各机各自配置 |
| 工具权限预设（三档 `sandbox` + `approval`、`defaultPreset`） | **本机** | 各机各自配置 |
| 默认模型（`agent-default-model` 的 `provider` / `model`） | **本机** | 各机各自配置 |
| 欢迎通知版本号（`ui-settings-general`） | **本机** | 偏好类 |
| WebSocket 心跳参数（`typert-gateway`） | **本机** | 依赖各机网络链路 |
| `webserver.host` | **本机** | 各机监听地址不同 |
| `dsh-auth-gate` 的 `publicHost`、`mode`、`cookieSecure` | **本机** | |
| 工作区绝对路径（`storages/workspace.json`） | **本机** | |
| 第三方插件的内容（`soul-config.json` 全部键，以及 `dshmarket`、`dsh-better-sidebar`、`dsh-context`、`billion-context`、`@changfenhuang/dsh-genui`、`@michengai/*`、`dsh-git-sentry` 的配置） | 不同步 | 插件内容归插件 |
| 第三方插件在 `cordis.patch.yml` 中留下的安装痕迹（`insert` 行等） | 不同步 | 抽取时必须识别并排除 |
| `.credentials.yaml` | 不同步 | 真密钥 |
| `auth/users.yaml` | 不同步 | 账号数据 |
| `storages/dsh_auth_sessions.json` | 不同步 | 登录会话 |
| `storages/session_projcache/` | 不同步 | 缓存 |
| `skills-manager/repository-cache/`、`repositories.json` | 不同步（第一期） | 体积大且含缓存，第二期再评估 |
| `node_modules/` | 不同步 | 由官方安装流程重建 |
| 会话记录、日志 | 不同步 | |

### 4.3 判为「本机」的偏好类：包含什么、去掉会怎样

| 项 | 在 patch 里的形态 | 去掉之后 |
|---|---|---|
| 主题偏好 | `ui-theme` 节的 `preference: dark` | 新机器回到默认浅色，需手动切一次 |
| 工具权限预设 | `permission` 节的三档 `sandbox` + `approval` 组合，以及 `defaultPreset: danger-full-access` | 回落到默认 `ask` 档，工具调用会弹批准框；本机的 `danger-full-access` + `approval: never` 状态消失，需手动选回 |
| 默认模型 | `agent-default-model` 节的 `provider: muyuan`、`model: deepseek-v4.1-flash` | **默认模型为空**，新会话不会自动选中，需手动选一次 |
| 心跳参数 | `typert-gateway` 的 `websocketHeartbeatIntervalMs: 15000` | 回到默认 2000 毫秒；经远程链路使用时可能重新出现连接偶发中断 |

**一处容易误读的地方**：provider 定义本身**仍在公共线里**。所以拉取后模型的**可选项是齐全的**（用户定义过的 provider 都在），丢的只是「默认选哪一个」。

### 4.4 判为「不同步」的第三方插件内容：包含什么、去掉会怎样

**包含什么**：用户后来自己安装的第三方插件所拥有的全部配置——人设插件 `dsh-soul` 的 `~/.dsh/soul-config.json` 全部 13 个键（昵称、职业、简介、风格、标题列表、表情、表格、回复长度、语言、自定义指令、人设总开关、变更需确认、拖尾动画四项），以及 `dshmarket`、`dsh-better-sidebar`、`dsh-context`、`billion-context`、`@changfenhuang/dsh-genui`、`@michengai/*`、`dsh-git-sentry` 各自的配置。

**去掉之后**：

- 人设不会恢复，需要在新机器上重新设置一遍。
- 第三方插件的外观与行为回到它们的默认值。
- **但第三方插件本身仍会被重新安装**——只要它在插件名单里，§3.4 的流程就会安装它。丢失的只是配置内容，不是插件本身。

**判定依据不是「值是否合理不同」，而是「所有权」**：官方插件连同其配置算公共，用户后来安装的第三方插件的内容不进公共线。

### 4.5 一个待定的衍生项

DSH 原生自带 `@deepseek-ai/dsh-persona`（官方包，实现在 `packages/preset/persona`），其配置直接写在 `cordis.patch.yml` 的 `persona` 节里，天然属于公共线抽取范围。用户表示「后面再看看怎么通过官方插件来设定」，故本期不配置也不同步；机制上它随时可用。见 §7 开放项 5。

### 4.6 抽取粒度：按条目，不是按文件

**这是本设计的关键约束，实测数据支撑。**

`cordis.patch.yml` 是本项目的核心同步对象，但它的内容**绝大部分是本机专属的**。实测取样中，该文件共 118 行、9 个顶层条目：

| 顶层条目 | 归属 |
|---|---|
| `webserver` | 本机 |
| `dsh-auth-gate` | 本机 |
| `ui-settings-general` | 本机 |
| `llm-pi-ai` | **公共** |
| `agent-default-model` | 本机 |
| `typert-gateway` | 本机 |
| `ui-theme` | 本机 |
| `permission` | 本机 |
| `session-log-deepseek` | 本机 |

**9 个条目里只有 1 个进公共线。** 所以：

- 抽取的最小单位是**顶层条目**（`- id: <插件 id>` 这一项及其 `config:` 子树），不是整个文件。
- 按文件整体同步会恰好犯下本项目要解决的那个错误——把 `webserver.host` 的局域网 IP 带到新机器上。
- 实现时需要一个能按顶层条目切分 Loader YAML 的解析器（见 §9 第一个待验证项）。

**条目内部也可能混着两类。** `llm-pi-ai` 整体判为公共，但它的 `providers.<名字>.baseURL` 指向的是外部服务端点——这仍然属于公共（它是服务地址，不是本机地址）。需要区分的是「外部服务端点」与「本机监听/对外地址」，二者形式相似、性质相反。

### 4.7 技能不是纯文本：含脚本与二进制

技能目录（`~/.dsh/skills/<名字>/`）并不只是 `SKILL.md`。实测 9 个技能合计约 **404 KB**，其中：

| 内容类型 | 实例 |
|---|---|
| 可执行脚本 | `agent-browser` 的 `templates/*.sh`、`screenshot` 的 `scripts/*.py` / `*.ps1` / `*.swift`、`brainstorming` 的 `scripts/server.cjs` |
| 二进制资源 | `screenshot` 的 `assets/screenshot.png` |
| 认证与许可文件 | 多个技能含 `LICENSE.txt`、`agents/openai.yaml` |
| 文档与模板 | `references/*.md`、`examples/*.md`、`scripts/frame-template.html` |

**两个必须处理的点**：

1. **保留文件模式。** 脚本靠可执行位工作。同步时若丢失权限位，脚本在目标机器上会静默失效——文件在，但跑不起来。
2. **同步前必须能审查脚本内容。** 技能脚本会在目标机器上被执行。推送前应能在差异视图里看到脚本的新增与改动，而不是当作不透明二进制默默搬过去。

第 2 点不是额外的安全设计——§3.5 的差异预览本来就要求展示将要同步的内容。这里只是明确**技能脚本必须纳入可读的差异展示**，不能因为「技能是整体目录」就跳过逐文件差异。

---

## 5. 云端结构与数据模型

### 5.1 云端结构

云端是一份 git 仓库（第二期会加 WebDAV 作为可切换的替代介质）。

```
snapshot.json                   清单：schema 版本、生成时间、来源机器、文件摘要
notes.md                        记事本，自由文本，插件不做解析
config/
  profile.patch.yml             从本机 cordis.patch.yml 抽出的「公共键」部分
  bundles.json                  插件名单（官方 / 第三方分列）
  package.json                  含 dependencies 与 dsh.profile.bundles
  pnpm-lock.yaml                锁文件
skills/<技能名>/...              技能本体
```

本结构不含人设、主题、权限预设、默认模型、心跳参数，也不含任何第三方插件内容；体积主要由 `skills/` 与 `pnpm-lock.yaml` 决定。

**为什么 `pnpm-lock.yaml` 也在云端**：插件清单只记名字，版本会随解析时间漂移。锁文件记录的是**依赖树的完整解析结果**，用途不是强制钉版本，而是当恢复结果与预期不符时有一份可对照的参照。

### 5.2 数据模型

```
Snapshot
  schemaVersion: number
  generatedAt: string          // ISO 时间
  generatedBy: string          // 机器标识（主机名）
  entries: Entry[]             // 逐文件摘要，用于快速比对

Entry
  path: string                 // 云端相对路径
  kind: 'shared' | 'machine' | 'excluded'
  hash: string                 // 内容摘要

DiffItem
  path: string
  action: 'add' | 'modify' | 'delete' | 'skip'
  ownership: 'shared' | 'machine' | 'excluded'
  summary: string              // 人类可读的一句话

RestoreReport
  applied: RestoreItem[]
  skipped: RestoreItem[]
  needsRestart: boolean
  needsCredentials: string[]   // 需要补密钥的 provider 引用名
  backupPath: string           // 本次应用前的备份位置

RestoreItem
  kind: 'file' | 'plugin'
  name: string
  result: 'ok' | 'skipped'
  reason?: SkipReason

SkipReason
  = 'local-path-source' | 'version-incompatible' | 'registry-unreachable'
  | 'build-blocked' | 'unknown'
```

**本机档案**（`MachineProfile`）在第一期不实现，但归属表的「本机」态先标出来，为第三期预留。

---

## 6. 界面、密钥与记事本

### 6.1 界面落点

| 落点 | 内容 |
|---|---|
| 设置页一节（slot `settings.section`） | 云端仓库地址、推送按钮、拉取按钮、上次同步时间、介质切换（第二期启用） |
| 侧边栏主面板（slot `sidebar.panellist` + `main`） | 差异预览、恢复报告、跳过清单 |
| 浮层提示（slot `shell.overlay`） | 推送完成、恢复完成等一次性提示 |

`shell.overlay` 是官方提供的正规落点，当前已有 9 个占用者（各类 toast、快捷键提示）；用新 id 注册是并列添加，不会替换掉它们。

### 6.2 密钥边界

| 项 | 进不进云端 |
|---|---|
| `.credentials.yaml`（真密钥） | **永不** |
| 客户端会话 | **永不** |
| provider 定义（名称、地址、模型名） | 进 |
| `apiKeyEnv` 引用名（形如 `<变量名>`） | 进 |

**新机器上的预期表现**：provider 列表齐全，模型能选中，但一发消息就报认证失败。**这不是缺陷，是设计。** 恢复报告会在这之前列出缺哪几个 key、引用名分别是什么。

**凭据交给系统 git / credential helper 处理。** 插件不读、不存、不传密钥，也不弹输入框。凭据配置属于只能由人做的动作。

### 6.3 记事本

`notes.md` 是云端一份自由文本：插件不做任何解析，不把它当配置读，只在新机器或拉取时提示一次它的存在。用途是记某个 key 从哪里取、钉某个插件的版本、记某台机器的特殊处理。

---

## 7. 已锁定决策与开放项

### 7.1 已锁定的决策

| # | 决策 | 来源 |
|---|---|---|
| 1 | 解决多台机器间 DSH 设置与插件的重复配置问题 | 用户提出 |
| 2 | 只同步非密钥内容 | 用户选择 |
| 3 | 纯手动推拉，无自动同步 | 用户选择 |
| 4 | git 与 WebDAV 都做、可切换；第一期先做 git | 用户选择 |
| 5 | 需要支持 Linux + Windows，将来可能 macOS | 用户选择 |
| 6 | 路线 B（清单 + 差异应用） | 用户选择 |
| 7 | 第一期只做公共线；本机线预留 | 用户提出 |
| 8 | 插件只记名字，不记启用状态、不记插件内设置 | 用户选择 |
| 9 | 装不上的插件跳过并显示 | 用户提出 |
| 10 | 新增记事本文件 `notes.md` | 用户提出 |
| 11 | ~~人设：文字类公共，视觉类本机~~ **已作废**，见决策 19 | 用户选择 |
| 12 | 命名 `@toookamak/dsh-settings-roam`，显示名「设置漫游」 | 用户选择 |
| 13 | 独立仓库（公开），远程为 GitHub 上的 `toookamak/dsh-settings-roam` | 用户选择 |
| 14 | 归属表第一期就写出三态 | 本设计（为第三期预留） |
| 15 | 后端抽象先于第二种介质 | 本设计 |
| 16 | 插件不引导密钥输入 | 本设计 |
| 17 | 应用前先备份，支持回退 | 本设计 |
| 18 | 推送前展示 diff 并要求确认 | 本设计 |
| 19 | 公共线只覆盖 DSH 自身与其官方插件；用户后来安装的第三方插件，其配置内容不进公共线 | 用户裁定 |
| 20 | 主题偏好、工具权限预设、默认模型判为「本机」，各机器各自配置 | 用户裁定 |
| 21 | WebSocket 心跳参数判为「本机」 | 用户裁定 |
| 22 | 凭据交给系统 git / credential helper，插件不读、不存、不弹框 | 用户裁定 |
| 23 | 人设第一期不做（第三方插件带的不考虑；官方 `dsh-persona` 留待后续议） | 用户裁定 |
| 24 | 读路径采用**双通道交叉校验**：主通道走官方接口，校验通道直读文件，不一致时停下由用户裁决 | 用户裁定 |
| 25 | 写路径采用**先备份 + 走官方接口写入 + 写后回读校验**，不符则回退并列为需人工处理；不做自动降级 | 用户裁定 |
| 26 | 技能以**直读 `~/.dsh/skills/` 为主通道**，`ctx.skills` 作校验通道 | 用户裁定 |

### 7.2 开放项

| # | 开放项 | 什么时候定 |
|---|---|---|
| 1 | 关闭 —— 已由 §2.6 定了判定口径：`official === true \|\| availability === 'installation'`，三条来源取并集。实现第一步需实测确认（第三方包应满足 `official === false` 且 `availability === 'profile'`） | 已定（口径已定，实测待做） |
| 2 | 关闭 —— 已由决策 24–26 定了读、写、技能三条路径的做法 | 已定 |
| 3 | 交叉校验不一致时的**裁决界面**形态（在侧边栏主面板里逐项选，还是弹窗统一裁决） | 第一期实现时 |
| 4 | WebDAV 的历史版本策略（git 天然带历史，WebDAV 需自己按时间戳存快照） | 第二期 |
| 5 | 本机线的具体形态；以及「找回这台机器之前的某个设置」意味着本机线需要历史版本 | 第三期 |
| 6 | 官方原生人设（`@deepseek-ai/dsh-persona`）的启用形态与同步 | 用户决定启用时 |
| 7 | Windows 下的路径处理（配置里的绝对路径、备份目录位置） | 第一期实现时 |
| 8 | 恢复后的「体验断裂」是否要在报告里显式提示。由于主题 / 权限 / 默认模型已判为本机，拉取完成后界面与默认行为会与来源机器不同，用户可能误以为恢复失败 | 第一期实现时 |
| 9 | GitHub Gist 作为第四种介质（不进任何一期验收；不备份 `skills/`） | 后端抽象成熟后 |

### 7.3 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 插件版本漂移 | 只记名字不记版本，不同时间恢复结果不同 | 用户可在 `notes.md` 中钉版本；`pnpm-lock.yaml` 提供对照参照 |
| 恢复后 DSH 无法启动 | 配置是 DSH 的启动依赖，写错会导致起不来 | 走官方编辑路径（自带原子写与加锁）；应用前必备份；回退路径在报告里明确给出 |
| 多台机器 DSH 版本不一致 | 官方安装流程的兼容检查会拒绝安装 | 这是保护而非故障；在报告中明确指出需要什么版本 |
| 快照体积 | `repositories.json` 单文件 608 KB | 第一期把 `skills-manager/` 整体排除 |
| 官方 / 第三方界线识别 | 归属表要求区分两者，但现有接口没有一个是非题 | 见 §7.2 开放项 1 |
| 静默漏抽 / 静默写失败 | 官方服务（`ctx.settings`、`ctx.skills`）的失效形态是少给数据或不写入，**均不抛错** | 读路径用双通道交叉校验，不一致时停下由用户裁决；写路径用写后回读校验，不符则回退并在报告里列为需人工处理。见 §2.3 |
| 第三方插件在 patch 里留下 `insert` 行 | 抽取时若误把 `insert` 行当作配置项，会写坏别的机器的加载顺序 | 抽取时识别并排除；用交叉校验对比文件原始行，排除项也要能对上 |

---

## 8. 术语

| 术语 | 含义 |
|---|---|
| 公共线 | 多台机器共享的那一份配置，存在云端的公共路径 |
| 本机线 | 每台机器各自的配置，第一期不实现，第三期落地 |
| 归属表 | 把每个配置项标为公共 / 本机 / 不同步的那张表 |
| 官方安装流程 | `ctx.pluginManager.installBundle`，图形界面与 agent 工具所用的同一服务 |
| 快照 | 推送到云端的那一份内容（文件 + `snapshot.json`） |
| 应用 | 把云端内容写到本机配置里的动作 |
