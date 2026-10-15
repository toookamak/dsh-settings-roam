/**
 * 设置漫游的浏览器半侧。
 *
 * 格式约束（不要改成 ESM import）：
 *   客户端模块系统要求这个文件是 lazy-CJS factory——一段脚本，调用
 *   window.__ModuleLoader__.load({ id, factory })，并由注入的 require 解析依赖
 *   （require('react') 这类裸说明符走 loader 的模块表，不是 import map，也不碰全局）。
 *   官方自己的小 bundle 就是这个形态，所以本文件不需要任何打包器。
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

    /** 状态行：极简，只给一句话（U3）。 */
    function StatusLine({ state }) {
      switch (state?.kind) {
        case 'empty-cloud':
          return h('div', null, '云端还没有内容。先在这台机器上推送一次。')
        case 'has-diff':
          return h('div', null, `云端有 ${state.count} 项变化待拉取。`)
        case 'needs-config':
          return h('div', null, '还没配置云端仓库。在插件设置里填上地址。')
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

    /** 设置分区本体。 */
    function Section({ state, actions }) {
      const skipped = state?.skipped ?? []
      return h(
        'div',
        { className: 'roam-section' },
        h(StatusLine, { state }),
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
          h('button', { type: 'button', onClick: () => actions?.onPull?.() }, '拉取'),
          h('button', { type: 'button', onClick: () => actions?.onPush?.() }, '推送'),
        ),
      )
    }

    return { Section, StatusLine }
  },
})
