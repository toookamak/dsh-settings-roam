/**
 * 设置漫游的浏览器半侧。
 *
 * 格式约束（不要改成 ESM import）：
 *   客户端模块系统要求这个文件是 lazy-CJS factory——一段脚本，调用
 *   window.__ModuleLoader__.load({ id, factory })，并由注入的 require 解析依赖
 *   （require('react') 这类裸说明符走 loader 的模块表，不是 import map，也不碰全局）。
 *   官方自己的小 bundle 就是这个形态，所以本文件不需要任何打包器。
 *
 * 与宿主半侧的交汇方式（这三点缺一不可，实测过）：
 *   1. 必须导出 apply 与 inject。只导出一堆组件是不行的——模块加载器会接受它，
 *      但没有任何东西会去挂载，界面上一片空白且不报错。官方
 *      packages/session-query/session-log-export/lib/client.js 末尾同样是
 *      `exports.apply = apply; exports.inject = inject`。
 *   2. 必须经 ctx.slots.register 注册到 'settings.section' 槽位，
 *      注册名是字符串 'settings.section'，不是槽位树的路径
 *      （packages/client/ui-agent-preset/src/client/index.ts:267 的用法）。
 *   3. 宿主数据只能发 HTTP 取。浏览器半侧拿不到宿主模块，也读不了文件。
 *
 * 视觉约束（这是一处实测纠正）：
 *   界面必须用宿主的设计系统，不能用裸 h('div')/h('button') 自己糊。
 *   裸元素拿到的是浏览器默认样式：按钮是灰色系统方块、文字是默认字号行高，
 *   跟旁边官方的分区放在一起会明显不像一个软件。宿主已经把需要的都给了：
 *     · 组件：'@deepseek-ai/dsh-client-ui-primitives'（Button/Input/StateDot/图标），
 *       它已在 web bundle 的 boot manifest 里，require 能解析到；
 *     · 样式：全是 CSS 变量（--dsw-alias-*、--dsw-radius-*），颜色随主题走，
 *       所以本文件自带一张注入式样式表，不进打包器也不需要 CSS 文件。
 *
 * 配置项为什么由我们自己渲染：
 *   Config schema 的 volatile 表单**不会**自动出现在这一节里。
 *   实测：autoGenerate 的表单只渲染在「插件」页的插件详情里
 *   （packages/client/ui-settings-plugins 里的配置卡），而本插件是以
 *   profile 包的形态装进来的，不在那个插件清单里，所以没有任何界面会替我们渲染它。
 *   结论：要「设置页面有基础的配置选项」（用户要求），只能自己接
 *   ctx.configForms 把表单画出来。
 *
 * 界面决策 U2：只往设置分区贡献一节（slot 'settings.section'），不占侧边栏。
 * 界面决策 U3：文案极简，不铺垫、不解释设计意图。
 * U3 与设计 §3.4 的关系：§3.4 要求「跳过时不能只报一句失败」。U3 的极简指不铺垫，
 * 不是省掉行动指引——所以状态行是短句，但每条跳过项仍带一句可据以行动的说明。
 */
window.__ModuleLoader__.load({
  id: '@toookamak/dsh-settings-roam',
  factory: (require) => {
    const React = require('react')

    const h = React.createElement

    const NS = '@toookamak/dsh-settings-roam'

    /**
     * 宿主的设计系统。
     *
     * 这里有兜底：万一宿主没提供这个包（更名、或更早的版本），
     * 缺的后果是「这一节整个不显示」，那比样式退化严重得多，
     * 所以退回最小的原生元素也要把这一节画出来。兜底只保底，不做样式仿真。
     */
    let UI = {}
    try {
      UI = require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
    } catch (error) {
      // 浏览器控制台是这里唯一能说话的地方；不写日志的话
      // 表现就是「这一节变丑了」，看不出原因。
      console.warn('[设置漫游] 未能加载宿主界面组件，已退回最简样式：', error?.message ?? error)
    }

    /** 兜底按钮：结构与官方 Button 一致，只是没有官方样式。 */
    function PlainButton({ icon, children, ...rest }) {
      return h('button', { type: 'button', ...rest }, children)
    }

    const Button = UI.Button ?? PlainButton
    const Input = UI.Input ?? 'input'
    const StateDot = UI.StateDot ?? null
    const IconExport = UI.IconDownloadOutlineRegular ?? null
    const IconImport = UI.IconFolderOpenOutlineRegular ?? null
    const IconPull = UI.IconRefreshOutlineRegular ?? null
    const IconPush = UI.IconRightUpOutlineRegular ?? null
    const IconOpen = UI.IconFolderOpenOutlineRegular ?? null

    /**
     * 本插件的语言包。结构与 locale/*.json 一致（那边给宿主侧插件清单读
     * meta.title／meta.description），两边内容由测试锁住。
     *
     * 注意键是嵌套的，而宿主语言服务查的是**扁平键**（packages/client/locale/
     * src/client/index.ts 的 lookup 直接 dict[key]，不做点号下钻），
     * 所以登记前要 flatten 一次。
     */
    const LOCALES = {
      zh: {
        meta: {
          title: '设置漫游',
          description: '把可移植的配置推到云端，在新机器上拉回来。',
        },
        nav: '设置漫游',
        title: '设置漫游',
        intro: '这里只管能跟着你走的配置（模型与接口地址）。本机地址、主题、工具权限、默认模型留在本机，不会跟着走。',
        config: {
          title: '云端仓库',
          loading: '正在读取配置…',
          unavailable: '设置服务还没就绪，配置项暂时不可编辑。等页面重新加载后再试。',
          saving: '正在保存…',
          saved: '已保存。',
          failed: '没有保存成功。多半是这个条目在别处也被声明了（例如 profile 的 cordis.patch.yml 或启动参数），那样写入会被它覆盖。',
          repoUrl: {
            label: '仓库地址',
            hint: '远程 Git 仓库地址。填上之后「推送」「拉取」才可用。',
          },
          branch: {
            label: '备份放在哪条分支',
            hint: '同一个仓库可以放多个插件的备份，各占一条分支，免得互相覆盖。留空用 settings-roam。',
          },
          profileName: {
            label: '同步哪个 profile',
            hint: '留空自动判断；本机有多个 profile 时必须填，否则会明确报错而不是猜。',
          },
          exportRoot: {
            label: '导出目录',
            hint: '「导出到文件」把要备份的内容写到这里；留空用默认目录。',
          },
          importRoot: {
            label: '导入目录',
            hint: '「导入」去这个目录里找之前导出的包；留空就用上面的导出目录。',
          },
        },
        status: {
          loading: '正在读取本机配置…',
          needsConfig: '还没配置云端仓库。在下面的「云端仓库」里填上地址，就能推送了。',
          emptyCloud: '云端还没有内容。先在这台机器上导出或推送一次。',
          clean: '已与本机一致。',
          diff: '云端有 {n} 项变化待拉取。',
          review: '请核对上面的差异，确认后才会真正写入。',
          needsProfile: '这台机器上有多个 profile，在第一块里选一个要同步的。',
          error: '操作失败，请重试。',
        },
        busy: {
          status: '正在读取本机配置…',
          export: '正在把要备份的内容写到文件…',
          pushPrepare: '正在算要推送什么…',
          pullPrepare: '正在算云端差异…',
          importPrepare: '正在核对导入包…',
          importConfirm: '正在写回本机…',
          editPrepare: '正在核对改了什么…',
          editConfirm: '正在写回配置…',
          updateCheck: '正在问远端最新版本…',
          updateApply: '正在更新…',
          pushConfirm: '正在推送…',
          pullConfirm: '正在应用…',
        },
        action: {
          export: '导出到文件',
          import: '导入',
          pull: '拉取',
          push: '推送',
          confirm: '确认',
          confirmPush: '确认推送',
          confirmPull: '确认拉取',
          confirmImport: '确认导入',
          confirmEdit: '确认改动',
          confirmUpdate: '确认更新',
          cancel: '取消',
          copy: '复制路径',
          copied: '已复制',
        },
        pending: {
          push: '将推送 {files} 个文件，其中 {n} 项与云端不同。确认后写入云端。',
          pull: '云端有 {remote} 条配置，其中 {n} 项与本机不同。确认后改动本机。',
          import: '将写回 {n} 项，本机原有的监听地址、主题等不受影响。确认后改动本机。',
          edit: '将改动 {n} 处配置。确认后写入并重跑插件。',
          update: '会把依赖改成 {spec}，更新完要重启 DSH。确认后开始更新。',
        },
        compat: {
          blocked: '上面这些必须先处理：直接写下去不会报错，但也不会生效。',
        },
        edit: {
          title: '可移植的配置',
          intro: '这些是会跟着走的配置（{name}）。改完点保存，会先给你看改了哪几项。',
          save: '保存修改',
          removed: '（删除这一项）',
          noop: '跟原来一样，没有需要改的。',
        },
        update: {
          title: '插件自身',
          installed: '当前版本 {short}',
          unknown: '认不出当前版本：依赖清单里没有记下提交号。',
          noSpec: '这个 profile 的依赖清单里没有本插件，认不出它是怎么装进来的。',
          notGit: '这一份是本地链接安装的，改完代码重启 DSH 即可，不用在这里更新。',
          check: '检查更新',
          available: '有新版本：{from} → {to}',
          availableUnknown: '有新版本：{to}（当前这一版认不出来）',
        },
        preview: {
          title: '预览',
          empty: '还没有内容。点下面的「导出到文件」，先看看会带走什么。',
          pickTitle: '先选一个要同步的 profile',
          pickHint: '这台机器上有 {names}。选中的那个才会被同步，其余的保持原样。',
          pickSaved: '已选 {name}。',
        },
        actions: { title: '操作' },
        overview: { title: '这次同步了什么' },
        skips: { title: '这些项留在了本机' },
        result: {
          done: '操作已完成。',
          exported: '已导出 {total} 项。',
          updated: '已更新到 {to}。重启 DSH 后生效。',
          upToDate: '已经是最新版本（{from}）。',
        },
      },
      en: {
        meta: {
          title: 'Settings Roam',
          description: 'Push portable settings to the cloud, pull them back on a new machine.',
        },
        nav: 'Settings Roam',
        title: 'Settings Roam',
        intro: 'This section only carries settings that can travel (models and endpoints). Machine addresses, theme, tool permissions, and the default model stay here.',
        config: {
          title: 'Cloud repository',
          loading: 'Reading configuration…',
          unavailable: 'The settings service is not ready, so these fields cannot be edited yet. Reload the page and try again.',
          saving: 'Saving…',
          saved: 'Saved.',
          failed: 'The change was not saved. This entry is most likely declared somewhere else too (for example the profile cordis.patch.yml or the command line), which would override the edit.',
          repoUrl: {
            label: 'Repository URL',
            hint: 'Remote Git repository. Push and Pull become available once this is set.',
          },
          branch: {
            label: 'Branch for the backup',
            hint: 'One repository can hold backups from several plugins, each on its own branch. Empty uses settings-roam.',
          },
          profileName: {
            label: 'Profile to sync',
            hint: 'Leave empty to detect automatically. Required when this machine has several profiles.',
          },
          exportRoot: {
            label: 'Export directory',
            hint: 'Export to file writes the backup here. Empty uses the default directory.',
          },
          importRoot: {
            label: 'Import directory',
            hint: 'Import looks here for a previously exported package; empty uses the export directory above.',
          },
        },
        status: {
          loading: 'Reading local settings…',
          needsConfig: 'No cloud repository yet. Fill in the repository URL under \u201cCloud repository\u201d below to enable pushing.',
          emptyCloud: 'The cloud is still empty. Export or push once from this machine first.',
          clean: 'In sync with this machine.',
          diff: '{n} changes on the cloud are waiting to be pulled.',
          review: 'Check the differences above; nothing is written until you confirm.',
          needsProfile: 'This machine has several profiles — pick the one to sync in the first block.',
          error: 'The operation failed. Try again.',
        },
        busy: {
          status: 'Reading local settings…',
          export: 'Writing the backup to disk…',
          pushPrepare: 'Working out what would be pushed…',
          pullPrepare: 'Comparing with the cloud…',
          importPrepare: 'Checking the package…',
          importConfirm: 'Writing back to this machine…',
          editPrepare: 'Checking what changed…',
          editConfirm: 'Writing the change…',
          updateCheck: 'Asking the remote for the latest commit…',
          updateApply: 'Updating…',
          pushConfirm: 'Pushing…',
          pullConfirm: 'Applying…',
        },
        action: {
          export: 'Export to file',
          import: 'Import',
          pull: 'Pull',
          push: 'Push',
          confirm: 'Confirm',
          confirmPush: 'Confirm push',
          confirmPull: 'Confirm pull',
          confirmImport: 'Confirm import',
          confirmEdit: 'Confirm change',
          confirmUpdate: 'Confirm update',
          cancel: 'Cancel',
          copy: 'Copy path',
          copied: 'Copied',
        },
        pending: {
          push: 'This pushes {files} files, {n} of them differing from the cloud. Confirm to write it.',
          pull: 'The cloud holds {remote} entries, {n} of them differing from this machine. Confirm to change this machine.',
          import: 'This writes {n} items. This machine\u2019s own listen address, theme, and so on are left alone. Confirm to change this machine.',
          edit: 'This changes {n} settings. Confirm to write them and reload the plugin.',
          update: 'The dependency will be set to {spec}; DSH must be restarted afterwards. Update now?',
        },
        compat: {
          blocked: 'Fix the items above first: writing them now would silently do nothing.',
        },
        edit: {
          title: 'Portable settings',
          intro: 'These are the settings that travel ({name}). Save, and you will see exactly what changed first.',
          save: 'Save changes',
          removed: '(remove this entry)',
          noop: 'No change from the current settings.',
        },
        update: {
          title: 'This plugin',
          installed: 'Installed {short}',
          unknown: 'The installed commit is unknown: the profile manifest records no commit for it.',
          noSpec: 'This profile does not list the plugin as a dependency, so the installed version cannot be told.',
          notGit: 'This copy is a local link install. Edit the code and restart DSH instead.',
          check: 'Check for updates',
          available: 'Newer version available: {from} → {to}',
          availableUnknown: 'Newer version available: {to} (the installed one cannot be identified)',
        },
        preview: {
          title: 'Preview',
          empty: 'Nothing yet. Use \u201cExport to file\u201d below to see what would be taken.',
          pickTitle: 'Choose the profile to sync',
          pickHint: 'This machine has {names}. Only the selected one is synced; the rest stay as they are.',
          pickSaved: 'Selected {name}.',
        },
        actions: { title: 'Actions' },
        overview: { title: 'What this sync covered' },
        skips: { title: 'These stayed on this machine' },
        result: {
          done: 'Done.',
          exported: 'Exported {total} items.',
          updated: 'Updated to {to}. Restart DSH for it to take effect.',
          upToDate: 'Already up to date ({from}).',
        },
      },
    }

    /**
     * 路由路径。必须与宿主半侧 src/routes.js 的 ROUTES 保持一致——
     * 这里不能 import 它（一个是浏览器 bundle、一个是宿主模块），
     * 所以只能各写一份，改动时两边一起改。
     */
    const ROUTES = {
      status: '/api/settings-roam.status',
      export: '/api/settings-roam.export',
      import: '/api/settings-roam.import',
      push: '/api/settings-roam.push',
      pull: '/api/settings-roam.pull',
      edit: '/api/settings-roam.edit',
      update: '/api/settings-roam.update',
    }

    /**
     * 三种「预览 → 确认」动作的差异表。
     *
     * 放在这里而不是散在流程里，是因为这三种动作的骨架完全相同，
     * 只有「发到哪、说什么、确认按钮叫什么」不同。散着写就会有三份
     * 各自慢慢走样的流程，而它们本该永远一致。
     */
    const KIND_SPEC = {
      push: {
        route: ROUTES.push,
        busyPrepare: 'busy.pushPrepare',
        busyConfirm: 'busy.pushConfirm',
        confirmLabel: 'action.confirmPush',
        pending: 'pending.push',
      },
      pull: {
        route: ROUTES.pull,
        busyPrepare: 'busy.pullPrepare',
        busyConfirm: 'busy.pullConfirm',
        confirmLabel: 'action.confirmPull',
        pending: 'pending.pull',
      },
      import: {
        route: ROUTES.import,
        busyPrepare: 'busy.importPrepare',
        busyConfirm: 'busy.importConfirm',
        confirmLabel: 'action.confirmImport',
        pending: 'pending.import',
      },
      edit: {
        route: ROUTES.edit,
        busyPrepare: 'busy.editPrepare',
        busyConfirm: 'busy.editConfirm',
        confirmLabel: 'action.confirmEdit',
        pending: 'pending.edit',
      },
      update: {
        route: ROUTES.update,
        busyPrepare: 'busy.updateCheck',
        busyConfirm: 'busy.updateApply',
        confirmLabel: 'action.confirmUpdate',
        pending: 'pending.update',
      },
    }

    /**
     * 把「不写回的项」统一成列表能显示的形态。
     *
     * 两个来源的字段名不一样：导入计划里叫 path（按文件说），
     * 报告里叫 name（按条目说）。界面只认一个，否则会出现一行空白。
     * @param {Array<object>|undefined} items
     * @returns {Array<{name: string, explanation: string}>}
     */
    /**
     * 从检查结果里挑出需要注意的项。
     *
     * ok 的那些是「不需要做什么」，逐条摆出来只会把真正要注意的几条淹掉。
     * 单列成纯函数是为了能直接断言，不必展开整棵渲染树。
     */
    /**
     * 把配置里的值显示成输入框里的一串文本。
     *
     * 数组与对象用紧凑 JSON：它们本来就是整体编辑的，换行显示反而更难改。
     */
    /**
     * 差异里显示一个值。空值显示成「（空）」而不是空白，
     * 否则用户看到的是一个指向右边的箭头，读不出改了什么。
     */
    function formatChange(value) {
      if (value === undefined || value === null) return '（空）'
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
    }

    function formatFieldValue(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
    }

    function compatNotable(compat) {
      if (!compat || !Array.isArray(compat.items)) return []
      return compat.items.filter(entry => entry?.level !== 'ok')
    }

    /**
     * 「插件自身」那行小字要说什么。
     *
     * 只说**已经知道**的事：装的是哪一条依赖、装在哪一版。
     * 「有没有新版」必须问过远端才知道，而状态接口刻意不联网——
     * 猜一句「有新版本」很容易，但那是一句假话，用户点下去只会白等一轮。
     * @returns {string|null} null 表示这一份认不出安装方式，整行不显示
     */
    /** 提交号认不出来时用「未知版本」顶上——不要留一段空白，那看着像界面坏了。 */
    function shortOr(value) {
      return typeof value === 'string' && value !== '' ? value : '未知版本'
    }

    function updateNote(state, t) {
      const info = state?.status?.update
      if (!info || typeof info !== 'object') return null
      if (typeof info.installedSpec !== 'string' || info.installedSpec === '') return null
      if (info.reason === 'no-spec') return t('update.noSpec')
      if (info.reason === 'not-git') return t('update.notGit')
      if (typeof info.installedCommit !== 'string' || info.installedCommit === '') {
        return t('update.unknown')
      }
      return t('update.installed', { short: info.installedCommit.slice(0, 7) })
    }

    function normalizeRefused(items) {
      if (!Array.isArray(items)) return []
      return items.map(item => ({
        name: item?.name ?? item?.path ?? '',
        explanation: item?.explanation ?? '',
      }))
    }

    /**
     * apply 拿到的客户端上下文。
     *
     * 组件在渲染时要读当前语言，而槽位组件的参数里没有 ctx
     * （packages/client/ui-settings 的 settings.section 不向注册者传上下文），
     * 所以只能在这里留一个引用。
     */
    let hostContext = null

    /** 我们自己声明的配置字段，用来在设置目录里认出本插件的那一条。 */
    const FIELD_KEYS = ['repoUrl', 'branch', 'profileName', 'exportRoot', 'importRoot']

    /** 表单里要画出来的字段，顺序即界面顺序。 */
    const FIELDS = [
      { key: 'repoUrl', copy: 'repoUrl' },
      { key: 'branch', copy: 'branch' },
      { key: 'profileName', copy: 'profileName' },
      { key: 'exportRoot', copy: 'exportRoot' },
      { key: 'importRoot', copy: 'importRoot' },
    ]

    /**
     * 注入式样式表。
     *
     * 用 CSS 变量而不是写死颜色：这套界面有明暗主题，变量是唯一能跟着走的写法。
     * 类名统一 roam- 前缀，避免和宿主的类撞上（宿主的类名是 CSS Modules 哈希过的，
     * 但我们用的是全局 <style>，必须自己保证不冲突）。
     */
    const STYLE_ID = 'dsh-settings-roam-style'
    const CSS = [
      '.roam{display:flex;flex-direction:column;gap:14px;max-width:720px;padding-bottom:24px;color:var(--dsw-alias-label-primary)}',
      '.roam-head{display:flex;flex-direction:column;gap:4px}',
      '.roam-title{margin:0;font-size:16px;line-height:24px;font-weight:500}',
      '.roam-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.roam-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:0.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl)}',
      '.roam-card-title{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.roam-status{display:flex;align-items:center;gap:8px;font-size:14px;line-height:22px}',
      '.roam-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.roam-status[data-tone="ongoing"]{color:var(--dsw-alias-label-secondary)}',
      '.roam-field{display:flex;flex-direction:column;gap:6px}',
      '.roam-field-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.roam-field-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.roam-field-input{width:100%}',
      '.roam-field-input input{width:100%}',
      '.roam-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.roam-note[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.roam-note[data-tone="bad"]{color:var(--dsw-alias-state-error-primary)}',
      '.roam-stats{display:flex;flex-wrap:wrap;gap:18px}',
      '.roam-stat{display:flex;flex-direction:column;gap:2px;min-width:64px}',
      '.roam-stat-value{font-size:20px;line-height:28px;font-weight:500}',
      '.roam-stat-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.roam-meta{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);display:flex;flex-direction:column;gap:2px}',
      '.roam-loc{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.roam-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.roam-path{color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.roam-skips{display:flex;flex-direction:column;gap:8px}',
      '.roam-skip{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2)}',
      '.roam-skip-name{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.roam-skip-reason{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.roam-pick{display:flex;flex-direction:column;gap:6px}',
      '.roam-pick-title{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.roam-pick-options{display:flex;flex-wrap:wrap;gap:8px}',
      '.roam-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.roam-pending-text{margin:0;font-size:13px;line-height:20px}',
      '.roam-pending-actions{display:flex;gap:8px}',
      '.roam-compat{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}',
      '.roam-compat-item{font-size:12px;line-height:18px}',
      '.roam-compat-message{margin:0;color:var(--dsw-alias-label-secondary)}',
      '.roam-compat-block .roam-compat-message{color:var(--dsw-alias-state-error-primary)}',
      '.roam-compat-warn .roam-compat-message{color:var(--dsw-alias-state-warn-label)}',
      '.roam-compat-action{margin:2px 0 0;color:var(--dsw-alias-label-tertiary)}',
      '.roam-edit-fields{display:flex;flex-direction:column;gap:10px}',
      '.roam-edit-path{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0 0 4px}',
      '.roam-changed{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px}',
      '.roam-changed-path{color:var(--dsw-alias-label-secondary)}',
      '.roam-overview{display:flex;flex-direction:column;gap:12px}',
      '.roam-empty{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.roam-block{display:flex;flex-direction:column;gap:12px}',
      '.roam-preview .roam-skips{margin-top:4px}',
      '.roam-actions-card .roam-pending{border:0;background:transparent;padding:0}',
      '.roam-update{display:flex;align-items:center;gap:10px;margin-top:2px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l3)}',
      '.roam-update-note{margin:0;flex:1;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.roam-update-line{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
    ].join('')

    /**
     * 把样式表挂进文档。
     *
     * 按 id 幂等：这一节会被反复挂载（切走再切回、配置重载后整插件重跑 apply），
     * 每次插一张会导致样式表越堆越多。
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /**
     * 把嵌套语言包摊成宿主语言服务认得的扁平键。
     * @param {object} dict
     * @param {string} [prefix]
     * @param {object} [out]
     * @returns {Record<string, string>}
     */
    function flatten(dict, prefix = '', out = {}) {
      for (const [key, value] of Object.entries(dict ?? {})) {
        const path = prefix ? `${prefix}.${key}` : key
        if (value !== null && typeof value === 'object') flatten(value, path, out)
        else out[path] = String(value)
      }
      return out
    }

    /**
     * 当前语言。语言服务缺席时按中文（浏览器不认识的语言里，中文是最不意外的兜底）。
     * @param {object} ctx
     * @returns {string}
     */
    function activeLang(ctx) {
      try {
        return ctx.locale?.getSnapshot?.()?.active ?? 'zh'
      } catch {
        return 'zh'
      }
    }

    /**
     * 造一个取文案的函数。
     *
     * 直接读内联语言包而不是走 ctx.locale.bind(ns)：内联包就在手边，
     * 少一次跨服务查询，也不会因为语言包没登记成功而整节文案退化成键名。
     * @param {string} lang
     * @returns {(key: string, vars?: object) => string}
     */
    function makeT(lang) {
      const table = flatten(LOCALES[lang] ?? LOCALES.zh)
      const fallback = flatten(LOCALES.zh)
      return (key, vars) => {
        const text = table[key] ?? fallback[key] ?? key
        if (!vars) return text
        return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
      }
    }

    /**
     * 订阅当前语言，语言切换时让这一节重画。
     * @param {object} ctx
     * @returns {string}
     */
    function useLang(ctx) {
      const [lang, setLang] = React.useState(() => activeLang(ctx))
      React.useEffect(() => {
        setLang(activeLang(ctx))
        const off = ctx.locale?.subscribe?.(() => setLang(activeLang(ctx)))
        return typeof off === 'function' ? off : undefined
      }, [ctx])
      return lang
    }

    /**
     * 状态行：一句话说清「现在是什么状况」（U3）。
     *
     * 带状态点而不只是文字：设计 §3.4 要求用户能一眼看出云端有没有东西、
     * 我该做什么。一眼的前提是形态而不只是措辞。
     */
    function StatusLine({ state, t = makeT('zh') }) {
      const view = describeStatus(state, t)
      return h(
        'div',
        { className: 'roam-status', 'data-tone': view.tone, 'data-kind': view.dot },
        StateDot ? h(StateDot, { state: view.dot }) : null,
        h('span', null, view.text),
      )
    }

    /**
     * 把状态折算成「状态点的形态 + 一句话」。
     * @param {object} state
     * @param {Function} t
     * @returns {{dot: string, tone: string, text: string}}
     */
    function describeStatus(state, t) {
      switch (state?.kind) {
        case 'loading':
          return { dot: 'ongoing', tone: 'ongoing', text: t('status.loading') }
        case 'busy':
          return { dot: 'ongoing', tone: 'ongoing', text: state.text ?? t('status.loading') }
        case 'error':
          return { dot: 'error', tone: 'error', text: state.message ?? t('status.error') }
        case 'needs-config':
          return { dot: 'warning', tone: 'warning', text: t('status.needsConfig') }
        case 'needs-profile':
          return { dot: 'warning', tone: 'warning', text: t('status.needsProfile') }
        case 'empty-cloud':
          return { dot: 'idle', tone: 'idle', text: t('status.emptyCloud') }
        case 'has-diff':
          return { dot: 'warning', tone: 'warning', text: t('status.diff', { n: state.count ?? 0 }) }
        case 'review':
          return { dot: 'warning', tone: 'warning', text: t('status.review') }
        case 'done':
          return { dot: 'done', tone: 'done', text: state.text ?? t('result.done') }
        // clean 既可能来自「本机与云端一致」，也可能来自「这一次动作没产生变化」
        // （编辑时没改东西、检查更新时已经是最新）。后者必须能自己说话——
        // 统一显示「已与本机一致」，用户会以为自己的操作跑偏了。
        case 'clean':
          return { dot: 'done', tone: 'done', text: state.text ?? t('status.clean') }
        default:
          return { dot: 'done', tone: 'done', text: t('status.clean') }
      }
    }

    /**
     * 一个配置字段：标签 + 输入框 + 说明。
     *
     * 说明文字不是装饰。schemastery 不剥离未声明的键，字段名敲错了既不报错
     * 也不生效（实测）；把「这个字段管什么」写在旁边，是让用户自己就能发现
     * 敲错的那道防线。importRoot 还要在标签上就写清尚未生效，
     * 免得用户填完等不到结果。
     */
    function Field({ field, value, disabled, t, onChange, onCommit }) {
      const copy = `config.${field.copy}`
      return h(
        'div',
        { className: 'roam-field' },
        h('label', { className: 'roam-field-label', htmlFor: `roam-${field.key}` }, t(`${copy}.label`)),
        h(Input, {
          id: `roam-${field.key}`,
          className: 'roam-field-input',
          value,
          disabled,
          spellCheck: false,
          autoComplete: 'off',
          onChange: event => onChange(field.key, event.target.value),
          // blur 时把输入框里当下的值直接交出去，而不是回头去读状态里的草稿：
          // 失焦与「最后一个键入事件」之间没有任何顺序保证，读状态偶尔会慢一拍。
          onBlur: event => onCommit(field.key, event?.target?.value),
          onKeyDown: event => {
            if (event.key === 'Enter') event.currentTarget.blur()
          },
        }),
        h('p', { className: 'roam-field-hint' }, t(`${copy}.hint`)),
      )
    }

    /**
     * 可移植配置的编辑卡（第四阶段）。
     *
     * 为什么按字段列出来而不是给一个 YAML 文本框：用户改的绝大多数是某个值。
     * 为了改一个值去动整段 YAML，多出来的全是语法出错的机会；按字段改的话，
     * 出错的那个字段当场就能说清是哪一项。
     *
     * 只列「本来就有」的字段，不在这里加新字段——加一个供应商要同时想清楚
     * apiKeyEnv 指向哪个变量、模型列表写什么，那件事命令行做更合适。
     */
    function EditCard({ entry, t, onEdit }) {
      const [drafts, setDrafts] = React.useState({})
      if (!entry || !Array.isArray(entry.fields) || entry.fields.length === 0) return null

      const dirty = Object.keys(drafts).length > 0
      const shown = field => (drafts[field.path] !== undefined
        ? drafts[field.path]
        : formatFieldValue(field.value))

      return h(
        'div',
        { className: 'roam-card roam-edit' },
        h('p', { className: 'roam-card-title' }, t('edit.title')),
        h('p', { className: 'roam-field-hint' }, t('edit.intro', { name: entry.name ?? entry.id })),
        h(
          'div',
          { className: 'roam-edit-fields' },
          entry.fields.map(field => h(
            'div',
            { className: 'roam-field', key: field.path },
            h('p', { className: 'roam-edit-path roam-mono' }, field.path),
            h(Input, {
              id: `roam-edit-${field.path}`,
              className: 'roam-field-input',
              value: shown(field),
              spellCheck: false,
              autoComplete: 'off',
              onChange: event => setDrafts(current => ({ ...current, [field.path]: event.target.value })),
              onKeyDown: event => { if (event.key === 'Enter') event.currentTarget.blur() },
            }),
          )),
        ),
        h(
          'div',
          { className: 'roam-actions' },
          h(
            Button,
            {
              variant: 'primary',
              size: 'md',
              disabled: !dirty,
              onClick: () => onEdit?.(entry.id, drafts),
            },
            t('edit.save'),
          ),
        ),
      )
    }

    /**
     * 配置卡。
     *
     * 界面决策里「设置页面要有基础的配置选项」就落在这里。表单值走
     * ctx.configForms：它认的是**宿主插件条目 id**，写入会落到该条目的
     * cordis.patch.yml 配置上，改完宿主重跑 apply，所以是「改完即生效」。
     *
     * 条目 id 不写死：认的是「哪个命名空间声明了本插件那四个字段」。
     * 写死 'dsh-settings-roam' 也能用，但用户换一个条目名就会静默失配，
     * 而失配的表现是「配置项不见了」，很难查。
     */
    /**
     * 写入失败时给用户看的那句话。
     * 宿主自己能给理由就带上（更准），给不了就用通用说明——
     * 而通用说明必须点出最常见的原因，否则用户看到的是一句无解的「保存失败」。
     * configForms 只回一个布尔，宿主的原始理由本来到不了前端。
     */
    function failureNote(detail, t) {
      const suffix = detail === undefined || detail === null || detail === '' ? '' : `（${detail}）`
      return { tone: 'bad', text: `${t('config.failed')}${suffix}` }
    }

    /** 一行状态提示该显示什么；抽出来是为了能被直接断言。 */
    function describeNote(note, snapshot, t) {
      if (note !== null) {
        if (note.tone === 'ok') return t('config.saved')
        if (note.tone === 'saving') return t('config.saving')
        return note.text
      }
      return snapshot?.status === 'ready' ? null : t('config.loading')
    }

    function ConfigCard({ form, t, onSaved }) {
      const snapshot = useFormSnapshot(form)
      const [drafts, setDrafts] = React.useState({})
      const [note, setNote] = React.useState(null)

      const values = snapshot?.value ?? {}

      /** 草稿优先，其次才是已保存的值。 */
      const shown = key => (drafts[key] !== undefined ? drafts[key] : (values[key] ?? ''))

      /**
       * 落盘一个字段。
       *
       * 空字符串按「清除」处理：那会让字段退回默认层，等价于「留空」，
       * 而不是把一个空串写进配置里——后者在界面上看起来一样，
       * 实际却是「有值且值为空」，后面比较会一直不相等。
       */
      const commit = React.useCallback(async (key, raw) => {
        // blur 会把输入框里当下的值直接交给我们；只有拿不到时才回头读草稿。
        const next = raw !== undefined ? raw : (drafts[key] ?? '')
        setDrafts(current => {
          if (!(key in current)) return current
          const copy = { ...current }
          delete copy[key]
          return copy
        })
        const previous = values[key] ?? ''
        if (next === previous) return 'unchanged'
        setNote({ tone: 'saving' })
        try {
          const accepted = next === '' ? await form.unset(key) : await form.set(key, next)
          if (accepted === false) {
            setNote(failureNote('', t))
            return 'refused'
          }
          setNote({ tone: 'ok' })
          // 保存成功要回头问一次宿主状态：仓库地址填上之前，
          // 「拉取」「推送」是禁用的；不重新取一次，用户就会看到
          // 「已保存」和两个点不动的按钮并存，像是保存没生效。
          onSaved?.()
          return 'ok'
        } catch (error) {
          setNote(failureNote(error?.message ?? (error === undefined || error === null ? '' : String(error)), t))
          return 'failed'
        }
      }, [drafts, values, form, t, onSaved])

      if (snapshot?.status === 'unavailable') {
        return h(
          'div',
          { className: 'roam-card roam-config' },
          h('p', { className: 'roam-card-title' }, t('config.title')),
          h('p', { className: 'roam-field-hint' }, t('config.unavailable')),
        )
      }

      const noteText = describeNote(note, snapshot, t)

      return h(
        'div',
        { className: 'roam-card roam-config' },
        h('p', { className: 'roam-card-title' }, t('config.title')),
        FIELDS.map(field => h(Field, {
          key: field.key,
          field,
          value: shown(field.key),
          disabled: snapshot?.writable === false,
          t,
          onChange: (key, value) => setDrafts(current => ({ ...current, [key]: value })),
          onCommit: commit,
        })),
        noteText
          ? h(
            'p',
            {
              className: 'roam-note',
              'data-tone': note === null ? undefined : note.tone === 'ok' ? 'ok' : note.tone === 'bad' ? 'bad' : undefined,
            },
            noteText,
          )
          : null,
      )
    }

    /**
     * 订阅一个配置表单的快照。
     * 不用 useSyncExternalStore：这个 bundle 里对 React 的版本没有约束声明，
     * 而手写订阅在 React 17/18/19 上行为一致。
     * @param {object} form
     * @returns {object}
     */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      React.useEffect(() => {
        setSnapshot(form.getSnapshot())
        return form.subscribe(() => setSnapshot(form.getSnapshot()))
      }, [form])
      return snapshot
    }

    /**
     * 一条跳过项。
     * 说明文字来自宿主侧 report.js 的 explainSkip()，那里为每类原因
     * 各写了一句可据以行动的说明——这是 §3.4 的要求，不能退化成失败计数。
     */
    function SkipRow({ item }) {
      return h(
        'div',
        { className: 'roam-skip' },
        h('span', { className: 'roam-skip-name' }, item.name),
        h('span', { className: 'roam-skip-reason' }, item.explanation),
      )
    }

    /** 一个数字加它的名字。概述区里每类内容各占一个。 */
    function Stat({ item }) {
      return h(
        'div',
        { className: 'roam-stat' },
        h('span', { className: 'roam-stat-value' }, String(item.value)),
        h('span', { className: 'roam-stat-label' }, item.label),
      )
    }

    /**
     * 概述区：同步了什么、多少项、落盘在哪。
     *
     * 刻意只给概述，不逐项铺开——要看细节应当去打开导出的文件，
     * 在那里可以逐字核对。界面铺开长清单既挤占空间，也不如文件好用。
     * 所以这里的每个数字都配一条「在哪能看」的路径。
     */
    function Overview({ state, actions, t = makeT('zh') }) {
      const o = state?.overview
      if (!o) return null
      return h(
        'div',
        { className: 'roam-overview' },
        h('p', { className: 'roam-card-title' }, o.title ?? t('overview.title')),
        h('div', { className: 'roam-stats' }, (o.stats ?? []).map(s => h(Stat, { key: s.label, item: s }))),
        // 时间与来源：判断「这份是不是我刚才那次」的依据
        o.meta?.length
          ? h('div', { className: 'roam-meta' }, o.meta.map(m => h('div', { key: m }, m)))
          : null,
        // 落盘路径：用户据此去打开核对。
        o.location
          ? h(
            'div',
            { className: 'roam-loc' },
            h('span', null, o.location),
            actions?.onCopyPath
              ? h(
                Button,
                { variant: 'outline', size: 'sm', icon: IconOpen, onClick: () => actions.onCopyPath(o.location) },
                actions.copied ? t('action.copied') : t('action.copy'),
              )
              : null,
          )
          : null,
      )
    }

    /**
     * 待确认区。
     *
     * 界面决策 U1：推送（以及拉取）必须先给差异预览、等用户确认，不能一键直发。
     * 这段就是那个「确认点」——它在界面上存在，才说明确认真的发生过。
     * 确认时把 token 一起带上，宿主据此判断「确认的就是看过的那一份」。
     */
    function Pending({ state, actions, t = makeT('zh') }) {
      const p = state?.pending
      if (!p) return null
      const notable = compatNotable(p.compat)
      const blocked = p.compat?.blocked === true
      return h(
        'div',
        { className: 'roam-card roam-pending' },
        h('p', { className: 'roam-pending-text' }, p.text),
        // 更新与其它动作不同：它换的是「这个插件从哪来」。
        // 只给一句「确认吗」，用户没法判断这跟自己装的那一版差了多少。
        p.update
          ? h(
            'p',
            { className: 'roam-update-line roam-mono' },
            p.update.from === null || p.update.from === undefined
              ? t('update.availableUnknown', { to: p.update.to })
              : t('update.available', { from: p.update.from, to: p.update.to }),
          )
          : null,
        notable.length > 0
          ? h(
            'ul',
            { className: 'roam-compat' },
            notable.map(entry => h(
              'li',
              {
                key: `${entry.level}:${entry.name}:${entry.code}`,
                className: `roam-compat-item roam-compat-${entry.level}`,
              },
              h('p', { className: 'roam-compat-message' }, entry.message),
              h('p', { className: 'roam-compat-action' }, entry.action),
            )),
          )
          : null,
        // 有拦下的项时不给可点的确认：这类项的特征正是「点下去不报错、也不生效」，
        // 让用户先处理掉，比让他事后从「配置看着有、行为不对」倒查要省得多。
        blocked ? h('p', { className: 'roam-compat-action' }, t('compat.blocked')) : null,
        Array.isArray(p.changed) && p.changed.length > 0
          ? h(
            'ul',
            { className: 'roam-changed' },
            p.changed.map(item => h(
              'li',
              { key: item.path },
              h('span', { className: 'roam-changed-path roam-mono' }, item.path),
              ' ',
              // 改之前的值也要给：只显示新值，用户没法判断这次改动是不是他想要的那次。
              item.action === 'remove'
                ? t('edit.removed')
                : `${formatChange(item.from)} → ${formatChange(item.to)}`,
            )),
          )
          : null,
        h(
          'div',
          { className: 'roam-pending-actions' },
          h(
            Button,
            { variant: 'primary', disabled: blocked, onClick: () => actions?.onConfirm?.() },
            p.confirmLabel ?? t('action.confirm'),
          ),
          h(Button, { variant: 'ghost', onClick: () => actions?.onCancel?.() }, t('action.cancel')),
        ),
      )
    }

    /**
     * 「预览」块：这次会带走什么、不带走什么、落在哪。
     *
     * 它排在「操作」块前面，是刻意的：用户点完按钮之后视线还在按钮附近，
     * 而内容出现在上方一格——先把位置定在按钮的正上方，才不用回头去找。
     * 这也正是「点了导出像是没返回结果」的成因。
     */
    /**
     * 多 profile 时的选择器。
     *
     * 原先这种情况只会抛一句「请显式指定 profile 名」——用户既不知道名字该怎么拼，
     * 也不知道去哪儿填。而候选名单本来就在手上（数据根目录下就是那几个目录），
     * 摆出来让人点一下就行。
     */
    function ProfilePicker({ profile, form, t = makeT('zh'), onSaved }) {
      const names = Array.isArray(profile?.profiles) ? profile.profiles : []
      const [note, setNote] = React.useState(null)
      if (names.length === 0) return null
      const current = profile?.name ?? ''
      const pick = async (name) => {
        setNote({ tone: 'saving' })
        try {
          const accepted = form ? await form.set('profileName', name) : false
          if (accepted === false) {
            setNote({ tone: 'bad', text: t('config.failed') })
            return
          }
          setNote({ tone: 'ok', text: t('preview.pickSaved', { name }) })
          onSaved?.()
        } catch (error) {
          setNote({ tone: 'bad', text: failureNote(error?.message ?? '', t) })
        }
      }
      const noteText = note?.text ?? (note?.tone === 'saving' ? t('config.saving') : null)
      return h(
        'div',
        { className: 'roam-pick' },
        h('p', { className: 'roam-pick-title' }, t('preview.pickTitle')),
        h('p', { className: 'roam-field-hint' }, t('preview.pickHint', { names: names.join('\u3001') })),
        h(
          'div',
          { className: 'roam-pick-options' },
          names.map(name => h(
            Button,
            {
              key: name,
              size: 'sm',
              variant: current === name ? 'primary' : 'outline',
              onClick: () => { void pick(name) },
            },
            name,
          )),
        ),
        noteText
          ? h(
            'p',
            {
              className: 'roam-note',
              'data-tone': note?.tone === 'ok' ? 'ok' : note?.tone === 'bad' ? 'bad' : undefined,
            },
            noteText,
          )
          : null,
      )
    }

    function PreviewBlock({ state, actions, t = makeT('zh'), form }) {
      const skipped = state?.skipped ?? []
      const hasOverview = Boolean(state?.overview)
      const profile = state?.status?.profile
      // 两种情形都要给选择器：多 profile 还没选（这一节读不出内容），
      // 以及已经选了但机器上还有别的（换一个不用去翻设置）。
      const needsPick = state?.kind === 'needs-profile' || profile?.needsChoice === true
      return h(
        'div',
        { className: 'roam-card roam-preview', id: 'roam-preview' },
        h('p', { className: 'roam-card-title' }, t('preview.title')),
        needsPick ? h(ProfilePicker, { profile, form, t, onSaved: actions?.onSaved }) : null,
        h(Overview, { state, actions, t }),
        // 还没有任何内容时也要有一条说明，否则这一块是一个没有落款的空壳。
        hasOverview || needsPick ? null : h('p', { className: 'roam-empty' }, t('preview.empty')),
        skipped.length > 0
          ? h(
            'div',
            { className: 'roam-skips' },
            h('p', { className: 'roam-card-title' }, t('skips.title')),
            skipped.map(item => h(SkipRow, { key: item.name, item })),
          )
          : null,
      )
    }

    /**
     * 「操作」块：能做哪几件事，以及预览之后在这里确认。
     *
     * 确认区跟着按钮走，而不是自成一张卡：确认的对象就是这些按钮点出来的，
     * 分开摆会让「我在确认哪一件事」变得需要靠记忆。
     */
    function ActionBlock({ state, actions, t = makeT('zh') }) {
      const loading = state?.kind === 'loading'
      const busy = state?.kind === 'busy'
      const disabled = loading || busy
      // 未配置云端仓库时不给可点的「拉取」「推送」：点下去必然失败，
      // 而失败的表现和「按钮没接上线」在用户眼里是同一件事。
      const cloudReady = state?.status?.configured !== false && !disabled
      // 更新插件自己与「同步内容」是两件事，所以单独一行、不挤进上面那排按钮：
      // 上面四个按钮动的是配置，这一个动的是插件本身。
      const note = updateNote(state, t)
      return h(
        'div',
        { className: 'roam-card roam-actions-card' },
        h('p', { className: 'roam-card-title' }, t('actions.title')),
        h(
          'div',
          { className: 'roam-actions' },
          // 「导出」排在第一个：它是唯一不依赖云端仓库的动作，
          // 也是用户第一次打开这一节时最该点的那个——先把要备份的东西取出来看看。
          h(
            Button,
            { variant: 'primary', size: 'md', icon: IconExport, disabled, onClick: () => actions?.onExport?.() },
            t('action.export'),
          ),
          h(
            Button,
            { variant: 'outline', size: 'md', icon: IconImport, disabled, onClick: () => actions?.onImport?.() },
            t('action.import'),
          ),
          h(
            Button,
            { variant: 'outline', size: 'md', icon: IconPull, disabled: !cloudReady, onClick: () => actions?.onPull?.() },
            t('action.pull'),
          ),
          h(
            Button,
            { variant: 'outline', size: 'md', icon: IconPush, disabled: !cloudReady, onClick: () => actions?.onPush?.() },
            t('action.push'),
          ),
        ),
        note === null
          ? null
          : h(
            'div',
            { className: 'roam-update' },
            h('p', { className: 'roam-update-note' }, note),
            h(
              Button,
              { variant: 'ghost', size: 'sm', disabled, onClick: () => actions?.onUpdate?.() },
              t('update.check'),
            ),
          ),
        h(Pending, { state, actions, t }),
      )
    }

    /**
     * 设置分区本体（纯展示，测试直接调它做断言）。
     *
     * 分块的顺序是「先看到什么、再做什么」：
     * 状态一句话 → 预览（这次会带走什么）→ 操作（按钮与确认）→ 设置。
     * 「云端仓库」那五个输入框排在最后，因为它们是设一次就不动的；
     * 顶在前面会把每天要看的预览挤到需要滚动才能看到的位置。
     * @param {object} props
     */
    function Section({ state, actions, t = makeT('zh') }) {
      return h(
        'div',
        { className: 'roam-section roam' },
        h(
          'div',
          { className: 'roam-head' },
          h('h2', { className: 'roam-title' }, t('title')),
          h('p', { className: 'roam-intro' }, t('intro')),
        ),
        h(StatusLine, { state, t }),
        h(PreviewBlock, { state, actions, t, form: state?.form }),
        h(ActionBlock, { state, actions, t }),
        state?.form ? h(ConfigCard, { form: state.form, t, onSaved: actions?.onSaved }) : null,
        h(EditCard, { entry: state?.editable, t, onEdit: actions?.onEdit }),
      )
    }

    /**
     * 发一次请求。
     *
     * 错误一律转成一句能显示的话：界面没有别的途径告诉用户发生了什么，
     * 把异常吞掉只会让按钮看起来「点了没反应」。
     * @param {string} path
     * @param {object} [body] 有体则 POST
     * @returns {Promise<object>}
     */
    async function request(path, body) {
      const response = await fetch(path, body === undefined
        ? { method: 'GET' }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`服务返回了无法解析的内容（HTTP ${response.status}）`)
      }
      if (!payload.ok) throw new Error(payload.error ?? `请求失败（HTTP ${response.status}）`)
      return payload
    }

    /**
     * 把状态查询的结果折算成状态行的形态。
     *
     * 为什么是这几种：设计 §3.4 要求用户能一眼看出「云端有没有东西」、
     * 「我该做什么」。loading/busy/error 是过程态，不属于这几种。
     * @param {object} status
     * @returns {object}
     */
    function stateFrom(status) {
      // 读不到本机现状（最常见的是多 profile 还没选）不是「出错了」，
      // 而是一件要用户做选择的事。当成 error 会让整节内容消失，
      // 连让他去选的地方都没有。
      if (status.inspectError) return { kind: 'needs-profile', status }
      if (!status.configured) return { kind: 'needs-config', status }
      if (status.sharedCount === 0) return { kind: 'empty-cloud', status }
      return { kind: 'clean', status }
    }

    /**
     * 认领本插件的配置表单。
     *
     * ctx.configForms 以「宿主插件条目 id」为键。我们不去猜名字，而是看
     * 哪个命名空间的 schema 声明了本插件那四个字段——只有本插件会声明
     * importRoot，这个判据不会误认。
     *
     * @param {object} configForms - ctx.configForms（可能缺席）
     * @returns {object|null} 表单对象，或 null（还没就绪/不可用）
     */
    function resolveForm(configForms) {
      if (!configForms?.get) return null
      let namespaces
      try {
        namespaces = configForms.describe?.()?.getSnapshot?.()?.view?.namespaces ?? []
      } catch {
        return null
      }
      const mine = namespaces.find(view => declaresOurFields(view?.schema))
      if (mine === undefined) return null
      return configForms.get(mine.ns)
    }

    /**
     * 一个命名空间的 schema 是不是本插件声明的。
     *
     * describe 给出的 schema 是 $ref 风格：根对象在 refs[uid] 上，
     * 它的 dict 把字段名映射到 refs 的下标。直接读 schema.dict 会得到 undefined
     * （实测踩过），所以要先解引用。
     * @param {object} schema
     * @returns {boolean}
     */
    function declaresOurFields(schema) {
      const root = schema?.refs?.[schema?.uid] ?? schema
      const dict = root?.dict
      if (dict === null || typeof dict !== 'object') return false
      return FIELD_KEYS.every(key => Object.hasOwn(dict, key))
    }

    /**
     * 容器组件：把「取数、认表单、发请求」和「怎么画」分开。
     *
     * Section 保持纯展示（loader-shape 测试就是直接调它做断言的），
     * 因此这些逻辑只能放在这一层。用 React 自己的状态管理，
     * 不引入 @deepseek-ai/dsh-client-store：那会让插件多一个宿主包依赖，
     * 而这里只有一份状态，用不着外部 store。
     *
     * @param {object} props
     * @param {Function} props.getForm - 惰性取配置表单（可能还没就绪）
     * @param {Function} props.onFormReady - 表单就绪后的重新渲染钩子
     */
    function SectionContainer({ getForm, subscribeForms }) {
      const [state, setState] = React.useState({ kind: 'loading' })
      const [form, setForm] = React.useState(() => getForm?.() ?? null)
      const lang = useLang(hostContext ?? {})
      const t = React.useMemo(() => makeT(lang), [lang])
      const [copied, setCopied] = React.useState(false)

      // 配置表单是异步就绪的：设置镜像要先把宿主那一侧的命名空间同步过来。
      // 不订阅的话，第一次渲染时它还不存在，界面就永远停在「配置项不见了」。
      React.useEffect(() => {
        setForm(getForm?.() ?? null)
        return subscribeForms?.(() => setForm(getForm?.() ?? null))
      }, [getForm, subscribeForms])

      const load = React.useCallback(async () => {
        try {
          const status = await request(ROUTES.status)
          setState({ ...stateFrom(status), status })
        } catch (error) {
          setState({ kind: 'error', message: error.message })
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      /**
       * 动作完成后把「预览」块拉到视野里。
       *
       * 不这么做的话，用户点完按钮视线还在按钮上，而内容出现在上方一格——
       * 他就只能看到一句状态文字，感觉像「点了没返回结果」。
       * 没有 document 时（单元测试的假渲染）静默跳过。
       */
      const revealPreview = React.useCallback(() => {
        try {
          globalThis.document?.getElementById?.('roam-preview')
            ?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
        } catch {
          // 拉不动视野不是错误，不该影响这一次操作的结果。
        }
      }, [])

      /**
       * 本地导出：一次性、无副作用，不走确认流程。
       *
       * 它只往导出目录写副本，不改本机配置也不碰远端，所以没有需要用户
       * 点头的地方。结果同样给概述与落盘路径——用户据此去打开核对。
       */
      const beginExport = React.useCallback(async () => {
        setState(current => ({ kind: 'busy', text: t('busy.export'), status: current.status }))
        try {
          const done = await request(ROUTES.export, {})
          setState(current => ({
            kind: 'done',
            // 状态行直接说清「导出了几项」。只说一句「操作已完成」，
            // 用户还得自己去下面找导到哪了——那就等于没说。
            text: done.exported ? t('result.exported', { total: done.exported.total }) : t('result.done'),
            status: current.status,
            overview: done.overview ?? null,
          }))
          revealPreview()
        } catch (error) {
          setState(current => ({ kind: 'error', message: error.message, status: current.status }))
          revealPreview()
        }
      }, [t, revealPreview])

      /**
       * 统一处理「预览 → 确认」两段。
       *
       * 三种动作（推送 / 拉取 / 导入）走同一条骨架：算计划、把计划摆给用户看、
       * 等确认再执行。差别只在路由、文案与「要看哪些数字」，所以按 kind 取表，
       * 而不是写三份几乎一样的流程——写三份就会有三处各自慢慢写歪的机会。
       */
      const begin = React.useCallback(async (kind) => {
        const spec = KIND_SPEC[kind]
        setState(current => ({ kind: 'busy', text: t(spec.busyPrepare), status: current.status }))
        try {
          const prepared = await request(spec.route, { step: 'prepare' })
          const summary = prepared.summary ?? {}
          // 刻意不算 delete：本机独有的项我们从不删除（那是「同步配置」与
          // 「复制环境」的分界），把它算进「待拉取 N 项」会让用户以为点下去
          // 会删掉本机的东西。推送侧同理：云端独有的项也不会被清掉。
          const count = (summary.add ?? 0) + (summary.modify ?? 0)
          // 导入没有 diff 摘要（它不比对云端），用「会写几项」当计数。
          const total = kind === 'import'
            ? (prepared.overview?.total ?? 0)
            : count
          setState(current => ({
            // 预览之后停在「待确认」，不能是「已完成」——那一瞬间什么都还没写。
            kind: 'review',
            count: total,
            status: current.status,
            overview: prepared.overview ?? null,
            skipped: normalizeRefused(kind === 'import' ? prepared.refused : prepared.skipped),
            pending: {
              kind,
              token: prepared.token,
              compat: prepared.compat ?? null,
              confirmLabel: t(spec.confirmLabel),
              text: t(spec.pending, {
                n: total,
                files: prepared.files?.length ?? 0,
                remote: prepared.remoteCount ?? 0,
              }),
            },
          }))
        } catch (error) {
          setState(current => ({ kind: 'error', message: error.message, status: current.status }))
        }
      }, [t])

      /**
       * 编辑公共配置：同样先算差异、让用户看一眼，确认后才写。
       *
       * 不并进 begin() 的原因很直白：begin() 是「按一次按钮跑一个固定动作」，
       * 而编辑要带上用户刚敲进去的值。硬塞进去只会让那个函数同时管两件事。
       */
      const beginEdit = React.useCallback(async (id, drafts) => {
        setState(current => ({ kind: 'busy', text: t('busy.editPrepare'), status: current.status }))
        try {
          const prepared = await request(ROUTES.edit, { step: 'prepare', id, set: drafts })
          if (prepared.noop === true) {
            setState(current => ({ kind: 'clean', text: t('edit.noop'), status: current.status }))
            return
          }
          setState(current => ({
            kind: 'review',
            count: prepared.changed?.length ?? 0,
            status: current.status,
            overview: current.overview ?? null,
            skipped: current.skipped ?? [],
            pending: {
              kind: 'edit',
              token: prepared.token,
              compat: null,
              changed: prepared.changed ?? [],
              confirmLabel: t('action.confirmEdit'),
              text: t('pending.edit', { n: prepared.changed?.length ?? 0 }),
            },
          }))
        } catch (error) {
          setState(current => ({ kind: 'error', message: error.message, status: current.status }))
        }
      }, [t])

      /**
       * 更新插件自己。
       *
       * 与其它动作最大的不同：它改的是「这个插件从哪来」，不是配置内容，
       * 而且改完必须重启 DSH 才生效。所以确认文案里把这一点明写出来——
       * 否则用户更新完看到界面一点没变，只会以为更新没成功，然后再点一次。
       *
       * 检查这步要联网（问远端的 HEAD 提交），所以它是单独一次点击，
       * 不在打开设置页时顺手做掉。
       */
      const beginUpdate = React.useCallback(async () => {
        setState(current => ({ kind: 'busy', text: t('busy.updateCheck'), status: current.status }))
        try {
          const checked = await request(ROUTES.update, { step: 'check' })
          if (checked.needsUpdate !== true) {
            // 已经是最新：这也是一次成功的结果，不是「什么都没发生」。
            setState(current => ({
              kind: 'clean',
              text: t('result.upToDate', { from: shortOr(checked.from) }),
              status: current.status,
            }))
            return
          }
          setState(current => ({
            kind: 'review',
            count: 0,
            status: current.status,
            overview: current.overview ?? null,
            skipped: current.skipped ?? [],
            pending: {
              kind: 'update',
              token: checked.token,
              compat: null,
              // from 认不出来时保持 null，交给 Pending 挑句子——
              // 填个 '?' 会被当成正常值，最后渲染出「有新版本：? → ca727d9」。
              update: { from: checked.from ?? null, to: checked.to ?? null },
              confirmLabel: t('action.confirmUpdate'),
              text: t('pending.update', { spec: checked.nextSpec ?? '' }),
            },
          }))
        } catch (error) {
          setState(current => ({ kind: 'error', message: error.message, status: current.status }))
        }
      }, [t])

      const confirm = React.useCallback(async () => {
        const pending = state.pending
        if (!pending) return
        const spec = KIND_SPEC[pending.kind]
        setState(current => ({
          kind: 'busy',
          text: t(spec.busyConfirm),
          status: current.status,
        }))
        try {
          const done = await request(spec.route, { step: 'confirm', token: pending.token })
          if (pending.kind === 'update') {
            // 换的是磁盘上的依赖，内存里跑着的还是旧的那一份。
            // 说清「重启后生效」，不然用户接下来看到的每一处都还是老样子。
            setState(current => ({
              kind: 'done',
              text: t('result.updated', { to: shortOr(done.to) }),
              status: current.status,
            }))
            void load()
            return
          }
          setState(current => ({
            kind: 'done',
            text: t('result.done'),
            status: current.status,
            overview: done.overview ?? state.overview ?? null,
            skipped: normalizeRefused(done.report?.skipped),
          }))
        } catch (error) {
          setState(current => ({ kind: 'error', message: error.message, status: current.status }))
        }
      }, [state.pending, state.overview, t])

      /**
       * 配置保存成功之后重新取一次状态。
       *
       * 写配置会让宿主重新组合插件（config-reload），新的仓库地址要等这一轮
       * 走完才反映到状态里，所以立刻取一次、稍后再取一次——只取一次时
       * 常常还是旧的「未配置」，界面看起来像没保存上。
       * 定时器不影响正确性：取到的若是旧值，那次延迟刷新会覆盖它。
       */
      const onSaved = React.useCallback(() => {
        void load()
        setTimeout(() => { void load() }, 1200)
      }, [load])

      const actions = {
        copied,
        onSaved,
        onExport: beginExport,
        onImport: () => begin('import'),
        onPush: () => begin('push'),
        onPull: () => begin('pull'),
        onConfirm: confirm,
        onEdit: beginEdit,
        onUpdate: beginUpdate,
        onCancel: () => setState(current => ({ ...current, pending: null })),
        onCopyPath: (path) => {
          try {
            void navigator.clipboard?.writeText?.(path)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          } catch {
            // 复制失败没有可行动的地方——路径本身就在界面上，用户可以自己选中。
          }
        },
      }

      return h(Section, { state: form === null ? state : { ...state, form }, actions, t })
    }

    /**
     * 本插件的客户端依赖。
     *
     * 必须是**字符串数组**而不是函数——这是实测纠正过来的一处错：
     * 官方的 `exports.inject` 一律是数组
     * （packages/client/ui-settings-plugins/src/client/index.ts:28
     * `export const inject = ['slots', 'locale']`），
     * 它声明的是「这个插件要用到哪些客户端服务」，由客户端注入器在挂载前解析。
     *
     * slots：注册设置分区要用；locale：语言包要用。
     * configForms 刻意**不**列在这里：它只是让我们多一个可编辑的表单，
     * 缺了照样该把状态、导出、推送画出来。用 ctx.inject 可选捕获，
     * 免得宿主一改这个服务的名字，整节就消失了。
     */
    const inject = ['slots', 'locale']

    /**
     * 挂到设置分区的「设置漫游」一节。
     * @param {object} ctx - 客户端上下文
     */
    function apply(ctx) {
      ensureStyles()
      hostContext = ctx

      // 语言包必须先登记，否则 label() 查的是一个不存在的命名空间，
      // 整节的标题会退化成键名。官方写法同此
      // （packages/client/ui-settings-plugins/src/client/index.ts:36-37）。
      //
      // locale 是 inject 声明过的依赖，正常情况下一定在；这里仍留一条兜底，
      // 因为语言服务缺席的后果（整节不显示）远重于文案退回中文。
      const t = ctx.locale?.bind?.(NS)
      if (t) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh: flatten(LOCALES.zh), en: flatten(LOCALES.en) }),
          'dsh-settings-roam: section dictionaries',
        )
      }

      // 配置表单是可选的：拿得到就画出来，拿不到也照样把这一节挂上去。
      let configForms
      let formListeners = new Set()
      ctx.inject(['configForms'], (scope) => {
        configForms = scope.configForms
        // describe() 的镜像变化 = 我们的命名空间可能刚到，通知界面再看一次
        const off = configForms?.describe?.()?.subscribe?.(() => {
          for (const listener of formListeners) listener()
        })
        return typeof off === 'function' ? off : undefined
      })

      const getForm = () => resolveForm(configForms)
      const subscribeForms = (listener) => {
        formListeners.add(listener)
        return () => formListeners.delete(listener)
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'settings-roam',
        order: 50,
        // 标签走语言包；万一语言服务还没就绪则退回中文字面量，
        // 免得因为一个标题取不到就整节不显示。
        label: () => {
          try {
            return t?.('nav') ?? '设置漫游'
          } catch {
            return '设置漫游'
          }
        },
        locale: NS,
        inject: () => ({ getForm, subscribeForms }),
      }, SectionContainer))
    }

    return {
      apply,
      inject,
      Section,
      StatusLine,
      ConfigCard,
      ProfilePicker,
      failureNote,
      describeNote,
      EditCard,
      Overview,
      Pending,
      SectionContainer,
      compatNotable,
      updateNote,
      shortOr,
      describeStatus,
      formatFieldValue,
      formatChange,
      LOCALES,
      flatten,
      makeT,
      resolveForm,
      declaresOurFields,
      FIELDS,
    }
  },
})
