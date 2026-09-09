/**
 * New API HTTP 客户端
 *
 * 仅封装 New API 管理接口和 OpenAI 兼容模型接口，不负责本地持久化。
 * 保持无 Electron 依赖，便于使用 mock fetch 做 BDD 测试。
 */

import type { UserProfile } from '../../types'
import { NEW_API_SERVER_ADDRESS } from '../../types'
import { randomUUID } from 'node:crypto'

interface JsonObject {
  [key: string]: unknown
}

export interface NewApiRemoteUser {
  id?: number
  username: string
  displayName?: string
  avatar?: string
}

export interface NewApiPasswordSession {
  user: NewApiRemoteUser
  accessToken?: string
  cookie?: string
}

export interface NewApiModel {
  id: string
  name: string
}

export interface NewApiTokenUsage {
  name?: string
}

export interface NewApiCreatedKey {
  apiKey: string
  tokenId?: number
  /** 是否由本次登录新建，只有新建令牌才允许在后续失败时回收。 */
  created: boolean
}

export type NewApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export interface NewApiClientOptions {
  fetch: NewApiFetch
  serverAddress?: string
  timeoutMs?: number
}

export class NewApiRequestError extends Error {
  readonly statusCode?: number

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = 'NewApiRequestError'
    this.statusCode = statusCode
  }
}

function asObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as JsonObject
}

function readString(object: JsonObject | undefined, ...keys: string[]): string | undefined {
  if (!object) return undefined
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function readNumber(object: JsonObject | undefined, ...keys: string[]): number | undefined {
  if (!object) return undefined
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function readBoolean(object: JsonObject | undefined, ...keys: string[]): boolean | undefined {
  if (!object) return undefined
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function normalizeServerAddress(serverAddress: string): string {
  return serverAddress.trim().replace(/\/+$/, '')
}

function getResponseCookies(response: Response): string | undefined {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[]
  }
  const values = headers.getSetCookie?.() ?? []
  const cookies = values.length > 0
    ? values
    : response.headers.get('set-cookie')
      ? [response.headers.get('set-cookie')!]
      : []
  const pairs = cookies
    .map((cookie) => cookie.split(';', 1)[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie))
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

function getApiMessage(payload: JsonObject | undefined, fallback: string): string {
  return readString(payload, 'message', 'error') ?? fallback
}

function normalizeLoginMessage(message: string): string {
  if (/username or password is incorrect|user has been banned/i.test(message)) {
    return '账号或密码错误，或者当前账号已被禁用'
  }
  return message
}

function normalizeApiKey(apiKey: string): string {
  return apiKey.startsWith('sk-') ? apiKey : `sk-${apiKey}`
}

function isReusableToken(token: JsonObject, marker: string, nowSeconds: number): boolean {
  const name = readString(token, 'name')
  if (!name?.toLowerCase().includes(marker.toLowerCase())) return false

  const status = readNumber(token, 'status')
  if (status !== 1) return false

  const expiredTime = readNumber(token, 'expired_time', 'expiredTime')
  if (expiredTime != null && expiredTime !== -1 && expiredTime <= nowSeconds) return false

  const unlimitedQuota = readBoolean(token, 'unlimited_quota', 'unlimitedQuota')
  const remainQuota = readNumber(token, 'remain_quota', 'remainQuota')
  return unlimitedQuota === true || (remainQuota != null && remainQuota > 0)
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = ''
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf-8') > maxBytes) break
    result += character
  }
  return result
}

function createUniqueTokenName(baseName: string): string {
  const suffix = randomUUID().slice(0, 8)
  const separator = ' · '
  const maxBaseBytes = 50 - Buffer.byteLength(`${separator}${suffix}`, 'utf-8')
  const normalizedBaseName = baseName.trim() || 'ccb · Xcode Desktop'
  return `${truncateUtf8(normalizedBaseName, maxBaseBytes)}${separator}${suffix}`
}

function parseRemoteUser(payload: JsonObject): NewApiRemoteUser {
  const username = readString(payload, 'username', 'user_name', 'name')
  if (!username) {
    throw new NewApiRequestError('New API 未返回有效的用户信息')
  }
  return {
    username,
    ...(readNumber(payload, 'id', 'user_id') != null
      ? { id: readNumber(payload, 'id', 'user_id') }
      : {}),
    ...(readString(payload, 'display_name', 'displayName', 'nickname')
      ? { displayName: readString(payload, 'display_name', 'displayName', 'nickname') }
      : {}),
    ...(readString(payload, 'avatar', 'avatar_url', 'profile_picture')
      ? { avatar: readString(payload, 'avatar', 'avatar_url', 'profile_picture') }
      : {}),
  }
}

/**
 * 将远端用户转换为 Proma 用户档案。
 *
 * New API 标准用户结构没有头像字段，因此无头像时使用稳定的首字头像。
 */
export function createProfileFromRemoteUser(user: NewApiRemoteUser): UserProfile {
  const userName = user.displayName || user.username
  return {
    userName,
    avatar: user.avatar || createInitialAvatar(userName),
  }
}

/** 为 API Key 登录生成本地展示档案。New API 的模型 Token 不包含所属用户身份。 */
export function createProfileFromApiKey(tokenName?: string): UserProfile {
  const userName = tokenName?.trim() || 'API Key 用户'
  return {
    userName,
    avatar: createInitialAvatar(userName),
  }
}

/** 生成无需额外网络请求的首字头像。 */
export function createInitialAvatar(name: string): string {
  const label = Array.from(name.trim())[0] || 'P'
  let hash = 0
  for (const character of name) {
    hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0
  }
  const palette = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2']
  const background = palette[Math.abs(hash) % palette.length]!
  const escapedLabel = label
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
    `<rect width="128" height="128" rx="28" fill="${background}"/>`,
    `<text x="64" y="68" text-anchor="middle" dominant-baseline="middle" fill="white" font-family="Arial, sans-serif" font-size="58" font-weight="700">${escapedLabel}</text>`,
    '</svg>',
  ].join('')
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

export class NewApiClient {
  private readonly fetchFn: NewApiFetch
  private readonly serverAddress: string
  private readonly openAiBaseUrl: string
  private readonly timeoutMs: number

  constructor(options: NewApiClientOptions) {
    this.fetchFn = options.fetch
    this.serverAddress = normalizeServerAddress(options.serverAddress ?? NEW_API_SERVER_ADDRESS)
    this.openAiBaseUrl = `${this.serverAddress}/v1`
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchFn(`${this.serverAddress}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new NewApiRequestError('连接 New API 超时，请检查网络后重试')
      }
      throw new NewApiRequestError(
        error instanceof Error ? `无法连接 New API：${error.message}` : '无法连接 New API',
      )
    }
  }

  private async readJson(response: Response): Promise<JsonObject> {
    let rawPayload: unknown
    try {
      rawPayload = await response.json()
    } catch {
      throw new NewApiRequestError(`New API 返回了无法解析的数据（HTTP ${response.status}）`, response.status)
    }
    const payload = asObject(rawPayload)
    if (!payload) {
      throw new NewApiRequestError(`New API 返回了无法解析的数据（HTTP ${response.status}）`, response.status)
    }
    if (!response.ok) {
      throw new NewApiRequestError(getApiMessage(payload, `请求失败（HTTP ${response.status}）`), response.status)
    }
    if (payload.success === false) {
      throw new NewApiRequestError(getApiMessage(payload, 'New API 请求失败'), response.status)
    }
    return payload
  }

  async loginWithPassword(username: string, password: string): Promise<NewApiPasswordSession> {
    const response = await this.request('/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })

    let payload: JsonObject
    try {
      payload = await this.readJson(response)
    } catch (error) {
      if (error instanceof NewApiRequestError) {
        throw new NewApiRequestError(normalizeLoginMessage(error.message), error.statusCode)
      }
      throw error
    }

    const data = asObject(payload.data)
    if (data?.require_2fa === true || data?.need_2fa === true) {
      throw new NewApiRequestError('当前账号已开启两步验证，请改用 API Key 登录')
    }
    const userPayload = asObject(data?.user) ?? data
    if (!userPayload) {
      throw new NewApiRequestError('New API 登录成功，但未返回用户信息')
    }

    const accessToken = readString(data, 'access_token', 'accessToken')
      ?? readString(payload, 'access_token', 'accessToken')
    const cookie = getResponseCookies(response)

    if (!accessToken && !cookie) {
      throw new NewApiRequestError('当前 New API 版本未返回可用于创建 API Key 的登录凭据')
    }

    return {
      user: parseRemoteUser(userPayload),
      ...(accessToken ? { accessToken } : {}),
      ...(cookie ? { cookie } : {}),
    }
  }

  private createManagementHeaders(
    session: NewApiPasswordSession,
    contentType = false,
  ): Record<string, string> {
    const headers: Record<string, string> = {}
    if (contentType) headers['Content-Type'] = 'application/json'
    if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`
    if (session.cookie) headers.Cookie = session.cookie
    if (session.user.id != null) headers['New-Api-User'] = String(session.user.id)
    return headers
  }

  private async readFullApiKey(
    session: NewApiPasswordSession,
    tokenId: number,
  ): Promise<string> {
    const response = await this.request(`/api/token/${tokenId}/key`, {
      method: 'POST',
      headers: this.createManagementHeaders(session),
    })
    const payload = await this.readJson(response)
    const apiKey = readString(asObject(payload.data), 'key', 'api_key', 'apiKey')
    if (!apiKey) {
      throw new NewApiRequestError('New API 无法读取完整 API Key')
    }
    return normalizeApiKey(apiKey)
  }

  private async findReusableApiKey(
    session: NewApiPasswordSession,
    marker: string,
  ): Promise<NewApiCreatedKey | null> {
    const pageSize = 100
    let page = 1
    let total: number | undefined
    const nowSeconds = Math.floor(Date.now() / 1000)

    while (true) {
      const query = new URLSearchParams({
        p: String(page),
        size: String(pageSize),
      })
      const response = await this.request(`/api/token/?${query.toString()}`, {
        method: 'GET',
        headers: this.createManagementHeaders(session),
      })
      const payload = await this.readJson(response)
      const data = asObject(payload.data)
      const items = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(data?.items)
          ? data.items
          : []
      total = readNumber(data, 'total') ?? total

      const matchedTokens = items
        .map(asObject)
        .filter((item): item is JsonObject => Boolean(item))
        .filter((item) => isReusableToken(item, marker, nowSeconds))

      for (const matchedToken of matchedTokens) {
        const tokenId = readNumber(matchedToken, 'id')
        if (tokenId == null) continue

        try {
          const apiKey = await this.readFullApiKey(session, tokenId)
          const models = await this.fetchModels(apiKey)
          if (models.length > 0) {
            return {
              apiKey,
              tokenId,
              created: false,
            }
          }
        } catch (error) {
          if (
            error instanceof NewApiRequestError
            && (error.statusCode === 401
              || error.statusCode === 403
              || error.statusCode === 404)
          ) {
            continue
          }
          throw error
        }
      }

      const reachedLastPage = total != null
        ? page * pageSize >= total
        : items.length < pageSize
      if (reachedLastPage) break
      page += 1
    }
    return null
  }

  /**
   * 优先复用名称中带指定标识的有效令牌，不存在时再创建新令牌。
   */
  async getOrCreateApiKey(
    session: NewApiPasswordSession,
    name: string,
    marker: string,
  ): Promise<NewApiCreatedKey> {
    const reusableKey = await this.findReusableApiKey(session, marker)
    if (reusableKey) return reusableKey

    return this.createApiKey(session, name)
  }

  private async createApiKey(
    session: NewApiPasswordSession,
    baseName: string,
  ): Promise<NewApiCreatedKey> {
    const headers = this.createManagementHeaders(session, true)
    const name = createUniqueTokenName(baseName)

    const response = await this.request('/api/token/', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name,
        expired_time: -1,
        remain_quota: 0,
        unlimited_quota: true,
        model_limits_enabled: false,
        models: '',
        allow_ips: '',
      }),
    })
    const payload = await this.readJson(response)
    const createdData = asObject(payload.data)
    const immediateKey = readString(createdData, 'key', 'api_key', 'apiKey')
    if (immediateKey) {
      const tokenId = readNumber(createdData, 'id')
      return {
        apiKey: normalizeApiKey(immediateKey),
        ...(tokenId != null ? { tokenId } : {}),
        created: true,
      }
    }

    // 新版 New API 创建令牌后不再直接返回完整 Key，需要按名称查回令牌 ID，
    // 再通过专用端点读取一次完整 Key；同时兼容仍直接返回 Key 的旧版本。
    const query = new URLSearchParams({
      keyword: name,
      p: '1',
      size: '20',
    })
    const searchResponse = await this.request(`/api/token/search?${query.toString()}`, {
      method: 'GET',
      headers,
    })
    const searchPayload = await this.readJson(searchResponse)
    const searchData = asObject(searchPayload.data)
    const items = Array.isArray(searchPayload.data)
      ? searchPayload.data
      : Array.isArray(searchData?.items)
        ? searchData.items
        : []
    const matchedToken = items
      .map(asObject)
      .filter((item): item is JsonObject => Boolean(item))
      .find((item) => readString(item, 'name') === name && readNumber(item, 'id') != null)
    const tokenId = readNumber(matchedToken, 'id')
    if (tokenId == null) {
      throw new NewApiRequestError('New API 已创建令牌，但无法定位刚创建的令牌')
    }

    try {
      return {
        apiKey: await this.readFullApiKey(session, tokenId),
        tokenId,
        created: true,
      }
    } catch (error) {
      await this.deleteApiKey(session, tokenId).catch((cleanupError) => {
        console.warn('[New API 登录] 回收无法读取 Key 的新令牌失败:', cleanupError)
      })
      throw error
    }
  }

  async deleteApiKey(session: NewApiPasswordSession, tokenId: number): Promise<void> {
    const response = await this.request(`/api/token/${tokenId}`, {
      method: 'DELETE',
      headers: this.createManagementHeaders(session),
    })
    await this.readJson(response)
  }

  async fetchModels(apiKey: string): Promise<NewApiModel[]> {
    let response: Response
    try {
      response = await this.fetchFn(`${this.openAiBaseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new NewApiRequestError('获取 New API 模型列表超时')
      }
      throw new NewApiRequestError(
        error instanceof Error ? `获取 New API 模型列表失败：${error.message}` : '获取 New API 模型列表失败',
      )
    }

    const payload = await this.readJson(response)
    const items = Array.isArray(payload.data) ? payload.data : []
    const models = items
      .map((item): NewApiModel | undefined => {
        const model = asObject(item)
        const id = readString(model, 'id')
        if (!id) return undefined
        return { id, name: readString(model, 'name', 'display_name') ?? id }
      })
      .filter((model): model is NewApiModel => Boolean(model))

    models.sort((left, right) => left.id.localeCompare(right.id))
    return models
  }

  async getTokenUsage(apiKey: string): Promise<NewApiTokenUsage> {
    const response = await this.request('/api/usage/token/', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const payload = await this.readJson(response)
    const data = asObject(payload.data)
    return {
      ...(readString(data, 'name') ? { name: readString(data, 'name') } : {}),
    }
  }
}
