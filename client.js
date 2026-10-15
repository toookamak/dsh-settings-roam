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
 * 界面决策 U2：只往设置分区贡献一节（slot 'settings.section'），不占侧边栏。
 * 界面决策 U3：文案极简，只给一句话。
 *
 * U3 与设计 §3.4 的关系（容易被误读，写在代码里）：
 *   §3.4 要求「跳过时不能只报一句失败」。U3 的极简指不铺垫、不解释设计意图，
 *   不是省掉行动指引。所以状态行极简，但每条跳过项仍带说明文字。
 */
window.__ModuleLoader__.load({
  id: '@toookamak/dsh-settings-roam',
  factory: (require) => {
    const React = require('react')

    const h = React.createElement

    const NS = '@toookamak/dsh-settings-roam'

    /**
     * 路由路径。必须与宿主半侧 src/routes.js 的 ROUTES 保持一致——
     * 这里不能 import 它（一个是浏览器 bundle、一个是宿主模块），
     * 所以只能各写一份，改动时两边一起改。
     */
    const ROUTES = {
      status: '/api/settings-roam.status',
      export: '/api/settings-roam.export',
      push: '/api/settings-roam.push',
      pull: '/api/settings-roam.pull',
    }

    /** 状态行：极简，只给一句话（U3）。 */
    function StatusLine({ state }) {
      switch (state?.kind) {
        case 'loading':
          return h('div', null, '正在读取本机配置…')
        case 'busy':
          return h('div', null, state.text ?? '正在处理…')
        case 'error':
          return h('div', { className: 'roam-error' }, state.message ?? '操作失败。')
        case 'needs-config':
          return h('div', null, '还没配置云端仓库。在插件设置里填上地址。')
        case 'empty-cloud':
          return h('div', null, '云端还没有内容。先在这台机器上推送一次。')
        case 'has-diff':
          return h('div', null, `云端有 ${state.count} 项变化待拉取。`)
        default:
          return h('div', null, '已与本机一致。')
      }
    }

    /**
     * 一条跳过项。
     * 说明文字来自宿主侧 report.js 的 explainSkip()，那里为每类原因
     * 各写了一句可据以行动的说明——这是 §3.4 的要求，不能退化成失败计数。
     */
    function SkipRow({ item }) {
      return h(
        'div',
        { className: 'roam-skip-row' },
        h('span', { className: 'roam-skip-name' }, item.name),
        h('span', { className: 'roam-skip-reason' }, item.explanation),
      )
    }

    /**
     * 概述区：同步了什么、多少项、落盘在哪。
     *
     * 刻意只给概述，不逐项铺开——要看细节应当去打开导出的文件，
     * 在那里可以逐字核对。界面铺开长清单既挤占空间，也不如文件好用。
     * 所以这里的每个数字都配一条「在哪能看」的路径。
     */
    function Overview({ state, actions }) {
      const o = state?.overview
      if (!o) return null
      return h(
        'div',
        { className: 'roam-overview' },
        h('div', { className: 'roam-overview-title' }, o.title),
        h(
          'div',
          { className: 'roam-overview-stats' },
          o.stats.map(s => h(
            'div',
            { className: 'roam-stat', key: s.label },
            h('span', { className: 'roam-stat-value' }, String(s.value)),
            h('span', { className: 'roam-stat-label' }, s.label),
          )),
        ),
        // 时间与来源：判断「这份是不是我刚才那次」的依据
        o.meta?.length
          ? h(
            'div',
            { className: 'roam-overview-meta' },
            o.meta.map(m => h('div', { className: 'roam-meta-line', key: m }, m)),
          )
          : null,
        // 落盘路径：用户据此去打开核对。可点则给出动作，否则纯文本。
        o.location
          ? h(
            'div',
            { className: 'roam-overview-location' },
            h('span', { className: 'roam-location-label' }, '详情在这些文件里：'),
            h('span', { className: 'roam-location-path' }, o.location),
            actions?.onOpenExport
              ? h('button', {
                type: 'button',
                className: 'roam-open',
                onClick: () => actions.onOpenExport(o.location),
              }, '打开')
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
    function Pending({ state, actions }) {
      const p = state?.pending
      if (!p) return null
      return h(
        'div',
        { className: 'roam-pending' },
        h('div', { className: 'roam-pending-text' }, p.text),
        h(
          'div',
          { className: 'roam-pending-actions' },
          h('button', { type: 'button', onClick: () => actions?.onConfirm?.() }, p.confirmLabel ?? '确认'),
          h('button', { type: 'button', onClick: () => actions?.onCancel?.() }, '取消'),
        ),
      )
    }

    /** 设置分区本体。 */
    function Section({ state, actions }) {
      const skipped = state?.skipped ?? []
      return h(
        'div',
        { className: 'roam-section' },
        h(StatusLine, { state }),
        h(Overview, { state, actions }),
        skipped.length > 0
          ? h(
            'div',
            { className: 'roam-skips' },
            skipped.map(item => h(SkipRow, { key: item.name, item })),
          )
          : null,
        h(
          'div',
          { className: 'roam-actions' },
          // 「导出」排在第一个：它是唯一不依赖云端仓库的动作，
          // 也是用户第一次打开这一节时最该点的那个——先把要备份的东西取出来看看。
          h('button', { type: 'button', onClick: () => actions?.onExport?.() }, '导出到文件'),
          h('button', { type: 'button', onClick: () => actions?.onPull?.() }, '拉取'),
          h('button', { type: 'button', onClick: () => actions?.onPush?.() }, '推送'),
          h(Pending, { state, actions }),
        ),
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
     * 把状态查询的结果折算成状态行的四种形态。
     *
     * 为什么这四种：设计 §3.4 要求用户能一眼看出「云端有没有东西」、
     * 「我该做什么」。loading/busy/error 是过程态，不属于这四种。
     * @param {object} status
     * @returns {object}
     */
    function stateFrom(status) {
      if (!status.configured) return { kind: 'needs-config' }
      if (status.sharedCount === 0) return { kind: 'empty-cloud' }
      return { kind: 'clean' }
    }

    /**
     * 容器组件：把「发请求、存结果」和「怎么画」分开。
     *
     * Section 保持纯展示（同目录下的 loader-shape 测试就是直接调它来做断言的），
     * 因此取数逻辑只能放在这一层。用 React 自己的状态管理，
     * 不再引入 @deepseek-ai/dsh-client-store：那会让插件多一个宿主包依赖，
     * 而这里只有一份状态，用不着外部 store。
     */
    function SectionContainer() {
      const [state, setState] = React.useState({ kind: 'loading' })

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
       * 本地导出：一次性、无副作用，不走确认流程。
       *
       * 它只往导出目录写副本，不改本机配置也不碰远端，所以没有需要用户
       * 点头的地方。结果同样给概述与落盘路径——用户据此去打开核对。
       */
      const beginExport = React.useCallback(async () => {
        setState({ kind: 'busy', text: '正在把要备份的内容导出到文件…' })
        try {
          const done = await request(ROUTES.export, {})
          setState({ kind: 'clean', overview: done.overview ?? null })
        } catch (error) {
          setState({ kind: 'error', message: error.message })
        }
      }, [])

      /** 统一处理「预览 → 确认」两段。 */
      const begin = React.useCallback(async (kind) => {
        const route = kind === 'push' ? ROUTES.push : ROUTES.pull
        setState({ kind: 'busy', text: kind === 'push' ? '正在算要推送什么…' : '正在算云端差异…' })
        try {
          const prepared = await request(route, { step: 'prepare' })
          const summary = prepared.summary ?? {}
          const count = (summary.add ?? 0) + (summary.modify ?? 0) + (summary.delete ?? 0)
          setState({
            kind: kind === 'push' ? 'clean' : 'has-diff',
            count,
            overview: prepared.overview ?? null,
            skipped: prepared.skipped ?? [],
            pending: {
              kind,
              token: prepared.token,
              confirmLabel: kind === 'push' ? '确认推送' : '确认拉取',
              text: kind === 'push'
                ? `将推送 ${prepared.files?.length ?? 0} 个文件，其中 ${count} 项与云端不同。确认后写入云端。`
                : `云端有 ${prepared.remoteCount ?? 0} 条配置，其中 ${count} 项与本机不同。确认后改动本机。`,
            },
          })
        } catch (error) {
          setState({ kind: 'error', message: error.message })
        }
      }, [])

      const confirm = React.useCallback(async () => {
        const pending = state.pending
        if (!pending) return
        setState({ kind: 'busy', text: pending.kind === 'push' ? '正在推送…' : '正在应用…' })
        try {
          const route = pending.kind === 'push' ? ROUTES.push : ROUTES.pull
          const done = await request(route, { step: 'confirm', token: pending.token })
          setState({
            kind: 'clean',
            overview: done.overview ?? state.overview ?? null,
            skipped: done.report?.skipped ?? [],
          })
        } catch (error) {
          setState({ kind: 'error', message: error.message })
        }
      }, [state.pending, state.overview])

      const actions = {
        onExport: beginExport,
        onPush: () => begin('push'),
        onPull: () => begin('pull'),
        onConfirm: confirm,
        onCancel: () => setState(s => ({ ...s, pending: null })),
      }

      return h(Section, { state, actions })
    }

    /** 本插件的客户端依赖：无（只用 React 与 fetch）。 */
    function inject() {
      return []
    }

    /**
     * 挂到设置分区的「设置漫游」一节。
     * @param {object} ctx - 客户端上下文
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'settings-roam',
        order: 50,
        // 标签走宿主语言包；取不到时退回中文字面量，
        // 免得因为语言服务还没就绪而整节不显示。
        label: () => {
          try {
            return ctx.locale?.bind?.(NS)?.('nav') ?? '设置漫游'
          } catch {
            return '设置漫游'
          }
        },
        locale: NS,
        inject: () => ({}),
      }, SectionContainer))
    }

    return { apply, inject, Section, StatusLine, Overview, SectionContainer }
  },
})
