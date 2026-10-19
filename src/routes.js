/**
 * 宿主半侧对浏览器半侧暴露的 HTTP 路由。
 *
 * 为什么必须走 HTTP 而不是把数据直接塞给组件：
 *   浏览器半侧是独立加载的 bundle，拿不到宿主模块，也读不了文件系统。
 *   它唯一能做的事是发请求。所以「本机现在有什么」「推送会写什么」
 *   这些问题只能由宿主算好、经路由送出去。
 *
 * 为什么单个路由带 step 而不是拆成五个路径：
 *   push/pull/import 各是「先预览、再确认」两段，两段共享同一份待确认计划。
 *   拆成五个路径会让「哪两份是同一次操作」变成靠命名约定去猜；
 *   放在一个路由里，step 是显式的，配对的计划也存在同一个闭包里。
 *
 * 界面决策 U1（用户裁定）：推送必须先给差异预览、等用户确认，不能一键直发。
 *   这条决策在这里的落法是 token 机制——确认时必须带上预览时发的 token，
 *   且 token 一次性。这样「确认的」就一定是「看过的」那一份，
 *   而不是确认时重新算出来的另一份。缺了这一步，预览就只是装饰。
 *
 * 这些路由不额外做鉴权：Connection 层已经统一施加了信任与认证策略
 * （packages/client/connection/src/rpc.ts:151 的说明），在这里再来一套
 * 只会多一处可能写错的地方。
 */
import { randomUUID } from 'node:crypto'

/** 路由挂载点，全部位于 `/api` 之下。 */
export const ROUTE_PREFIX = '/api/settings-roam'

/**
 * 三个路由的绝对路径。
 *
 * 形态说明（实测 packages/client/connection/src/rpc-host.ts:143 与 :327）：
 *   register 时 route.path 必须是以 `/api` 开头的完整路径——它被拿去和
 *   请求的 URL.pathname 直接做等值匹配（this.fetchRoutes.get(url.pathname)），
 *   不是「挂在 /api 下的相对名」。写成相对名会静默 404。
 * 浏览器半侧发的也是这个完整路径，所以两边看到的是同一个字符串。
 */
export const ROUTES = {
  status: `${ROUTE_PREFIX}.status`,
  export: `${ROUTE_PREFIX}.export`,
  import: `${ROUTE_PREFIX}.import`,
  push: `${ROUTE_PREFIX}.push`,
  pull: `${ROUTE_PREFIX}.pull`,
  edit: `${ROUTE_PREFIX}.edit`,
  update: `${ROUTE_PREFIX}.update`,
  compare: `${ROUTE_PREFIX}.compare`,
}

/**
 * 待确认的计划只留一个。
 *
 * 界面上一共就两个按钮，不存在并行确认两种操作的场景；
 * 留多个反而要处理「用户先预览了推送、又去预览拉取、回来点确认」这种
 * 分不清确认对象的局面。新的预览直接顶掉旧的，旧的 token 立即失效——
 * 这是对用户最安全的一种理解方式。
 */
const PENDING_TTL_MS = 10 * 60 * 1000

/**
 * 造一个 JSON 响应。
 * @param {object} body
 * @param {number} [status]
 * @returns {Response}
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * 把内部异常转成界面能直接显示的话。
 *
 * 只取 message，不带堆栈：堆栈里有本机绝对路径，而它是给用户看的，
 * 不是给开发者看的。凭据掩码由 git 后端自己负责（src/backends/git.js 的 scrub）。
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.trim() === '' ? '发生了未说明的错误' : text
}

/**
 * 从请求体里读 JSON。空体或坏 JSON 都当作空对象——
 * 这三个路由的参数都是可选的，没有「必须带体」的接口。
 * @param {Request} request
 * @returns {Promise<object>}
 */
async function readBody(request) {
  try {
    const text = await request.text()
    if (text.trim() === '') return {}
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 生成 Overview 所需的「已推送/已拉取」视图。
 * @param {object} deps
 * @param {object} deps.service
 * @param {Function} deps.buildPushOverview
 * @param {Function} deps.buildPullOverview
 */
export function createRouteHandlers(deps) {
  const {
    service,
    buildPushOverview,
    buildPullOverview,
    buildImportOverview,
    // 「本机现在有什么」的概述构建器。缺省为 null：它是 status 的附加信息，
    // 没传也不该让整条只读路径崩掉（单测里就常常只关心字段本身）。
    buildInspectOverview = null,
    now = () => new Date(),
  } = deps

  /** 当前待确认的计划；null 表示没有。 */
  let pending = null

  /**
   * 存一份待确认的计划，返回它的 token。
   * @param {'push'|'pull'|'import'|'edit'|'update'} kind
   * @param {object} plan
   * @returns {string}
   */
  const stash = (kind, plan) => {
    const token = randomUUID()
    pending = { token, kind, plan, at: now().getTime() }
    return token
  }

  /**
   * 取出待确认的计划。
   *
   * 三种不成立的情况分别给不同的话，因为用户要做的下一步并不相同：
   * 从没预览过 → 先点一次；带了别的 token → 那次预览已经作废；
   * 放太久 → 重新预览，免得拿一份十分钟前的差异去覆盖现在的本机。
   *
   * @param {'push'|'pull'|'import'|'edit'|'update'} kind
   * @param {unknown} token
   * @returns {{ok: true, plan: object} | {ok: false, error: string}}
   */
  const take = (kind, token) => {
    if (pending === null) {
      return { ok: false, error: '还没有预览过。请先点一次「预览」，看清楚要改动什么再确认。' }
    }
    if (pending.token !== token) {
      return { ok: false, error: '这次预览已经作废（多半是又预览了一次）。请重新预览后再确认。' }
    }
    if (pending.kind !== kind) {
      return { ok: false, error: '待确认的是另一种操作。请重新预览后再确认。' }
    }
    if (now().getTime() - pending.at > PENDING_TTL_MS) {
      pending = null
      return { ok: false, error: '这次预览已经放了太久。请重新预览一次，以免用旧差异覆盖现在的配置。' }
    }
    const plan = pending.plan
    // 一次性：确认过一次就作废，避免连点两次重复执行。
    pending = null
    return { ok: true, plan }
  }

  /** 本机现状。只读，未配置云端时也能用。 */
  const status = async () => {
    // 读不到本机现状不是「请求失败」，而是一种要展示给对方的状态：
    // 最常见的一种是多 profile 还没选。把它变成 500 会让整节内容消失，
    // 用户连去设置里填 profile 名的地方都看不见了。
    let inspected = null
    let inspectError = null
    try {
      inspected = await service.prepareInspect()
    } catch (error) {
      inspectError = messageOf(error)
    }
    return {
      // ok 是所有响应的统一约定：界面只看这一个字段判断成败，
      // 缺了它界面会把一次成功当成失败（request() 会抛「请求失败」）。
      ok: true,
      configured: service.isConfigured(),
      dshRoot: service.dshRoot,
      exportRoot: service.defaultExportRoot(),
      importRoot: service.defaultImportRoot(),
      // 导入目录里有没有可用的包。绝不抛错，所以「还没导出过」也能照常显示。
      importSource: service.describeImportSource(),
      profile: service.describeProfile(),
      inspectError,
      // 「这台机器上有什么」的概述，与状态取自同一次读取：用户选完 profile
      // 第一件想确认的事就是「这是我要备份的那份吗、配了几家供应商、装了几个
      // 插件」。原先这些数只在点过导出/推送之后才出现，预览区因此一直是空的。
      // 读不到本机现状时给 null，让界面照旧走「还没选 profile」那条路，
      // 而不是渲染一份凭空的清单。
      overview: inspected !== null && typeof buildInspectOverview === 'function'
        ? buildInspectOverview(inspected)
        : null,
      patchExists: inspected?.patchExists ?? null,
      total: inspected?.total ?? 0,
      sharedCount: inspected?.shared?.length ?? 0,
      machineCount: inspected?.machine?.length ?? 0,
      excludedCount: inspected?.excludedIds?.length ?? 0,
      skillCount: inspected?.skills?.length ?? 0,
      skillCheck: inspected?.skillCheck ?? null,
      // 可编辑的公共条目。列表为空时界面不渲染编辑区，
      // 而不是给一个点不动的空壳。读不到（例如还没选 profile）时给空列表：
      // 它只是个可选的便利功能，不该把整节状态一起带崩。
      editableEntries: inspectError === null ? service.listEditableEntries() : [],
      // 「装的是哪一版」随状态一起给，且刻意把 remoteCommit 固定成 null：
      // 真正的「有没有新版」要联网，那次调用放在「检查更新」按钮后面。
      // 放在这里会让打开设置页这个动作在网络不通时卡住十几秒。
      update: await service.describeUpdate({ remoteCommit: null }),
    }
  }

  /**
   * 本地导出：把「要备份的东西」真实落成文件，不碰云端。
   *
   * 为什么单独给一个动作，而不是让用户去点「推送」再看导出目录：
   *   1. 第一阶段的目标是「能获取到需要的配置」。这件事不需要云端仓库，
   *      把它藏在「推送」按钮背后，用户就得先有一个远端仓库才能取到自己的配置——
   *      顺序反了。
   *   2. 推送是两段式（预览→确认），而导出是一次性、无副作用的本地动作
   *      （只往导出目录写，不动本机配置、不动远端）。套上确认流程只会让
   *      「我就想看看要备份什么」这件事多两次点击。
   *
   * 注意它用的是 preparePush 而不是另写一条路径：导出与推送必须给出同一份内容，
   * 否则用户在导出目录里核对过的，和真正推上去的不是一回事。
   *
   * @param {Request} request
   */
  const exportLocal = async (request) => {
    const body = await readBody(request)
    const plan = await service.preparePush({
      generatedBy: body.generatedBy ?? 'dsh-settings-roam',
      exportRoot: body.exportRoot ?? service.defaultExportRoot(),
      bundles: body.bundles,
    })
    return jsonResponse({
      ok: true,
      overview: buildPushOverview(plan),
      exported: plan.exported,
      comparedWithRemote: plan.comparedWithRemote,
      // 只回路径名：内容可能很大，而界面只给概述。
      files: plan.files.map(f => f.path),
    })
  }

  /**
   * 推送：prepare 算差异与导出，confirm 才真正写云端。
   * @param {Request} request
   */
  const push = async (request) => {
    const body = await readBody(request)
    const step = body.step ?? 'prepare'

    if (step === 'prepare') {
      const plan = await service.preparePush({
        generatedBy: body.generatedBy ?? 'dsh-settings-roam',
        exportRoot: service.defaultExportRoot(),
        bundles: body.bundles,
      })
      return jsonResponse({
        ok: true,
        step,
        token: stash('push', plan),
        overview: buildPushOverview(plan),
        summary: plan.summary,
        comparedWithRemote: plan.comparedWithRemote,
        exported: plan.exported,
        // 列出本次会写入远端的文件。清单 snapshot.json 会自动更新，不含本机专属配置。
        transfers: plan.transfers ?? [],
        verifiedRemoteFileCount: plan.verifiedRemoteFileCount ?? 0,
        // 只回文件路径名，不回内容：内容可能很大，而界面只给概述。
        files: plan.files.map(f => f.path),
        skillCheck: plan.skillCheck,
      })
    }

    if (step === 'confirm') {
      const taken = take('push', body.token)
      if (!taken.ok) return jsonResponse({ ok: false, error: taken.error }, 409)
      const result = await service.confirmPush(taken.plan, body.message)
      return jsonResponse({ ok: true, step, pushed: result.pushed })
    }

    return jsonResponse({ ok: false, error: `不认识的 step：${String(step)}` }, 400)
  }

  /**
   * 拉取：prepare 算云端与本机的差异，confirm 才动本机文件。
   * @param {Request} request
   */
  const pull = async (request) => {
    const body = await readBody(request)
    const step = body.step ?? 'prepare'

    if (step === 'prepare') {
      const plan = await service.preparePull()
      return jsonResponse({
        ok: true,
        step,
        token: stash('pull', plan),
        summary: plan.summary,
        skillCheck: plan.skillCheck,
        transfers: plan.transfers ?? [],
        verifiedRemoteFileCount: plan.verifiedRemoteFileCount ?? 0,
        // 兼容性检查：哪些项写下去不会生效、哪些会覆盖掉本机的东西。
        // blocked 为真时界面不该让用户点下确认。
        compat: plan.compat ?? null,
        // 远程条目数：让界面能说清「云端一共有多少条」
        remoteCount: plan.remoteRows.length,
      })
    }

    if (step === 'confirm') {
      const taken = take('pull', body.token)
      if (!taken.ok) return jsonResponse({ ok: false, error: taken.error }, 409)
      const report = await service.applyPull(taken.plan, {
        backupRoot: service.defaultBackupRoot(),
      })
      return jsonResponse({ ok: true, step, overview: buildPullOverview(report), report })
    }

    return jsonResponse({ ok: false, error: `不认识的 step：${String(step)}` }, 400)
  }

  /**
   * 配置编辑：prepare 算出改完的样子，confirm 才写回本机。
   *
   * 与同步走同一条写路径（备份 → 合并 → 写后回读）。这一点是刻意的：
   * 「同步会备份、手改不会」这种不一致，最后一定会以「我改了配置结果回不去了」
   * 的形式找上门来。
   *
   * @param {Request} request
   */
  /**
   * 自更新：先问远端有没有新版，用户确认后再换依赖并重新安装。
   *
   * 为什么确认这一步不能省：它会改 profile 的依赖并重装包，
   * 而重装完成前谁也不知道新提交能不能用。用户要先看见「从哪一版换到哪一版」。
   */
  const update = async (request) => {
    const body = await readBody(request)
    const step = body.step ?? 'check'

    if (step === 'check') {
      // 这一步要联网（git ls-remote HEAD）。失败时 service 层已经把它
      // 变成一句能看懂的话（问不到远端），不是原始的 git 报错。
      const plan = await service.prepareUpdate({})
      return jsonResponse({
        ok: true,
        step,
        token: stash('update', plan),
        installedSpec: plan.installedSpec,
        repoUrl: plan.repoUrl,
        from: plan.from,
        to: plan.to,
        nextSpec: plan.nextSpec,
        needsUpdate: plan.needsUpdate,
        noop: plan.noop,
        reason: plan.reason,
      })
    }

    if (step === 'confirm') {
      const taken = take('update', body.token)
      if (!taken.ok) return jsonResponse({ ok: false, error: taken.error }, 409)
      const result = await service.applyUpdate(taken.plan)
      return jsonResponse({
        ok: true,
        step,
        updated: result.updated,
        reason: result.reason ?? null,
        to: result.to ?? null,
        nextSpec: result.nextSpec ?? null,
        // 换的是磁盘上的依赖，内存里跑着的还是旧的那一份：
        // 不重启的话用户会以为更新没生效。
        needsRestart: result.updated === true,
      })
    }

    return jsonResponse({ ok: false, error: `不认识的步骤：${step}` }, 400)
  }

  const edit = async (request) => {
    const body = await readBody(request)
    const step = body.step ?? 'prepare'

    if (step === 'prepare') {
      const plan = await service.prepareEdit({
        id: body.id,
        set: body.set,
        unset: body.unset,
        edits: body.edits,
        types: body.types,
      })
      return jsonResponse({
        ok: true,
        step,
        token: stash('edit', plan),
        id: plan.id,
        changed: plan.changed,
        fields: plan.fields,
        // 改了但没变化时界面要说「跟原来一样」，而不是假报一次成功。
        noop: plan.changed.length === 0,
      })
    }

    if (step === 'confirm') {
      const taken = take('edit', body.token)
      if (!taken.ok) return jsonResponse({ ok: false, error: taken.error }, 409)
      const result = await service.applyEdit(taken.plan, {
        backupRoot: service.defaultBackupRoot(),
      })
      return jsonResponse({
        ok: true,
        step,
        id: result.id,
        changed: result.changed,
        backupPath: result.backupPath,
      })
    }

    return jsonResponse({ ok: false, error: `不认识的 step：${String(step)}` }, 400)
  }

  /**
   * 导入：prepare 说清会写什么、不写什么，confirm 才动本机文件。
   *
   * 与「拉取」的区别值得说清，因为界面上这两个按钮长得像：
   *   拉取是「从云端拿」——需要先配好仓库地址，还要经过 git；
   *   导入是「从本机的一个目录拿」——不联网、不需要仓库地址。
   * 第二阶段的目标正是「不依赖云端也能把备份回填」，
   * 否则用户在新机器上要先能连上 git 才能恢复配置，顺序是反的。
   *
   * 为什么导入也要两段式：它会改本机配置与技能文件。
   * 凡是会改本机的动作，都必须先让用户看清楚再执行——这条对拉取和导入一视同仁。
   *
   * @param {Request} request
   */
  const importFrom = async (request) => {
    const body = await readBody(request)
    const step = body.step ?? 'prepare'
    const packageDir = body.packageDir ?? service.defaultImportRoot()

    if (step === 'prepare') {
      const plan = await service.prepareImport({ packageDir })
      return jsonResponse({
        ok: true,
        step,
        token: stash('import', plan),
        overview: buildImportOverview(plan),
        // 让界面能说清「这些为什么不写回」，而不是只给一个数字。
        refused: plan.refused,
        // 与拉取同一份检查：同一个包，从云端拉和从本机目录导入，
        // 结论必须一样，否则用户没法信任这个检查。
        compat: plan.compat ?? null,
        empty: plan.empty,
      })
    }

    if (step === 'confirm') {
      const taken = take('import', body.token)
      if (!taken.ok) return jsonResponse({ ok: false, error: taken.error }, 409)
      const report = await service.applyImport(taken.plan, {
        backupRoot: service.defaultBackupRoot(),
      })
      return jsonResponse({
        ok: true,
        step,
        overview: buildPullOverview(report, {
          title: '本次导入结果',
          appliedLabel: '已写入',
          location: taken.plan.packageDir,
        }),
        report,
      })
    }

    return jsonResponse({ ok: false, error: `不认识的 step：${String(step)}` }, 400)
  }

  /**
   * 按路径分派。
   *
   * 单独抽出来是为了能直接喂 Request 做单测，不必起 HTTP 服务。
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  const fetch = async (request) => {
    const path = new URL(request.url).pathname
    try {
      // 必须包成 Response：route.fetch 的契约是 Promise<Response>
      // （packages/client/connection/src/rpc.ts:152）。直接回对象会让
      // Connection 层拿到一个它读不懂的东西。
      if (path === ROUTES.status) return jsonResponse(await status())
      if (path === ROUTES.compare) {
        if (request.method !== 'POST') return jsonResponse({ ok: false, error: '云端对比需要 POST' }, 405)
        const result = await service.compareWithRemote()
        return jsonResponse({ ok: true, ...result })
      }
      if (path === ROUTES.export) {
        if (request.method !== 'POST') return jsonResponse({ ok: false, error: '导出需要 POST' }, 405)
        return await exportLocal(request)
      }
      if (path === ROUTES.import) {
        if (request.method !== 'POST') return jsonResponse({ ok: false, error: '导入需要 POST' }, 405)
        return await importFrom(request)
      }
      if (path === ROUTES.push) {
        if (request.method !== 'POST') return jsonResponse({ ok: false, error: '推送需要 POST' }, 405)
        return await push(request)
      }
      if (path === ROUTES.pull) {
        if (request.method !== 'POST') return jsonResponse({ ok: false, error: '拉取需要 POST' }, 405)
        return await pull(request)
      }
      if (path === ROUTES.edit) {
        if (request.method !== 'POST') return jsonResponse({ ok: false, error: '编辑需要 POST' }, 405)
        return await edit(request)
      }
      if (path === ROUTES.update) {
        if (request.method !== 'POST') return jsonResponse({ ok: false, error: '更新需要 POST' }, 405)
        return await update(request)
      }
      return jsonResponse({ ok: false, error: '没有这个路由' }, 404)
    } catch (error) {
      // 失败也要说清是什么失败：界面把这句话直接显示给用户。
      return jsonResponse({ ok: false, error: messageOf(error) }, 500)
    }
  }

  return { fetch, status, exportLocal, importFrom, push, pull, edit, update }
}

/**
 * 供 index.js 注册用的路由表。
 *
 * @param {object} deps - 同 createRouteHandlers，额外需要 `connection`
 * @returns {{path: string, methods: string[], requestBody: string, fetch: Function}[]}
 */
export function describeRoutes(deps) {
  const handlers = createRouteHandlers(deps)
  return [
    { path: ROUTES.status, methods: ['GET'], requestBody: 'buffered', fetch: handlers.fetch },
    { path: ROUTES.export, methods: ['POST'], requestBody: 'buffered', fetch: handlers.fetch },
    { path: ROUTES.import, methods: ['POST'], requestBody: 'buffered', fetch: handlers.fetch },
    { path: ROUTES.push, methods: ['POST'], requestBody: 'buffered', fetch: handlers.fetch },
    { path: ROUTES.pull, methods: ['POST'], requestBody: 'buffered', fetch: handlers.fetch },
    { path: ROUTES.edit, methods: ['POST'], requestBody: 'buffered', fetch: handlers.fetch },
    { path: ROUTES.update, methods: ['POST'], requestBody: 'buffered', fetch: handlers.fetch },
    { path: ROUTES.compare, methods: ['POST'], requestBody: 'buffered', fetch: handlers.fetch },
  ]
}
