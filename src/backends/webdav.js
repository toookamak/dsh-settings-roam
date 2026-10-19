/** WebDAV 文件后端。认证信息仅用于请求，不写入同步包或云端文件。 */
import { assertBackend } from './index.js'

function safeMessage(text, url) {
  return String(text)
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@')
    .replaceAll(url, '[WebDAV 地址]')
}

function normalizeBase(value, folder) {
  let url
  try { url = new URL(value) } catch { throw new Error('WebDAV 地址无效，请填写完整的 https:// 地址。') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('WebDAV 地址须为不含账号密码、查询参数或片段的 HTTPS 地址。')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  const folderName = String(folder ?? 'dsh-settings').trim()
  if (!folderName || folderName === '.' || folderName === '..' || /[\\/\u0000-\u001f]/.test(folderName)) {
    throw new Error('WebDAV 保存目录名无效；请填写单个目录名，不要包含斜杠。')
  }
  return new URL(`${encodeURIComponent(folderName)}/`, url)
}

function encodePath(path) {
  const parts = String(path).split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`WebDAV 路径无效：${path}`)
  }
  return parts.map(encodeURIComponent).join('/')
}

/** @param {{url:string, folder?:string, username?:string, password?:string, fetch?:Function}} config */
export function createWebDavBackend(config) {
  const base = normalizeBase(config.url, config.folder)
  const baseText = base.toString()
  const fetcher = config.fetch ?? globalThis.fetch
  const authorization = config.username || config.password
    ? `Basic ${Buffer.from(`${config.username ?? ''}:${config.password ?? ''}`).toString('base64')}`
    : null

  async function request(method, url, options = {}) {
    const headers = new Headers(options.headers ?? {})
    if (authorization) headers.set('authorization', authorization)
    let response
    try {
      response = await fetcher(url, { ...options, method, headers, redirect: 'manual' })
    } catch (error) {
      throw new Error(`WebDAV 连接失败：${safeMessage(error?.message ?? error, baseText)}`)
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error('WebDAV 服务器要求跳转，请填写最终的 WebDAV 地址。')
    }
    return response
  }

  async function ensureCollection(url) {
    const response = await request('MKCOL', url)
    if ([201, 405].includes(response.status)) return
    if (response.status === 409) throw new Error('WebDAV 目录不存在，请确认服务器已创建目标目录。')
    if (![200, 204].includes(response.status)) {
      throw new Error(`WebDAV 创建目录失败（HTTP ${response.status}）。请检查账号权限和服务器设置。`)
    }
  }

  const backend = {
    async ensureReady() {
      const response = await request('PROPFIND', base, { headers: { depth: '0' } })
      if (response.status === 404) {
        await ensureCollection(base)
        return
      }
      if (![200, 207, 204].includes(response.status)) {
        throw new Error(`WebDAV 连接检查失败（HTTP ${response.status}）。请检查地址、账号和访问权限。`)
      }
    },
    async pull() {},
    async push() { return { committed: true } },
    async readFile(relPath) {
      const url = new URL(encodePath(relPath), base)
      const response = await request('GET', url)
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`WebDAV 读取失败（HTTP ${response.status}）：${relPath}`)
      if (relPath.startsWith('skills/')) return Buffer.from(await response.arrayBuffer())
      return await response.text()
    },
    async writeFile(relPath, content) {
      const path = encodePath(relPath)
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const collection = new URL(`${parts.slice(0, i).join('/')}/`, base)
        await ensureCollection(collection)
      }
      const response = await request('PUT', new URL(path, base), {
        headers: { 'content-type': 'application/octet-stream' },
        body: content,
      })
      if (![200, 201, 204].includes(response.status)) {
        throw new Error(`WebDAV 写入失败（HTTP ${response.status}）：${relPath}`)
      }
    },
    async lastUploadAt() { return null },
    describe() { return `WebDAV ${baseText}` },
  }
  assertBackend(backend)
  return backend
}
