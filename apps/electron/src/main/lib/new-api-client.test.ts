import { describe, expect, test } from 'bun:test'
import {
  createProfileFromApiKey,
  createProfileFromRemoteUser,
  NewApiClient,
  NewApiRequestError,
} from './new-api-client'
import type { NewApiFetch } from './new-api-client'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('NewApiClient 账号密码登录', () => {
  test('Given 已有有效 ccb 令牌 When 账号密码登录 Then 直接复用且不创建新令牌', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new NewApiClient({
      fetch: async (input, init) => {
        const url = String(input)
        requests.push({ url, init })
        if (url.includes('/api/token/?')) {
          return jsonResponse({
            success: true,
            data: {
              total: 2,
              items: [
                {
                  id: 21,
                  name: '其他令牌',
                  status: 1,
                  expired_time: -1,
                },
                {
                  id: 19,
                  name: 'CCB Desktop',
                  status: 1,
                  expired_time: -1,
                  unlimited_quota: true,
                },
              ],
            },
          })
        }
        if (url.endsWith('/api/token/19/key')) {
          return jsonResponse({
            success: true,
            data: { key: 'existing-ccb-key' },
          })
        }
        if (url.endsWith('/v1/models')) {
          return jsonResponse({
            data: [{ id: 'claude-sonnet' }],
          })
        }
        throw new Error(`未预期请求: ${url}`)
      },
    })

    const resolvedKey = await client.getOrCreateApiKey({
      user: { id: 7, username: 'alice' },
      accessToken: 'management-token',
    }, 'ccb · Xcode Desktop', 'ccb')

    expect(resolvedKey).toEqual({
      apiKey: 'sk-existing-ccb-key',
      tokenId: 19,
      created: false,
    })
    expect(requests).toHaveLength(3)
    expect(requests.some(({ url }) => url.endsWith('/api/token/'))).toBe(false)
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer management-token')
  })

  test('Given 没有 ccb 令牌 When 登录并创建令牌 Then 使用 access token 调用令牌接口', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    let createdTokenName = ''
    const fetchMock: NewApiFetch = async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith('/api/user/login')) {
        return jsonResponse({
          success: true,
          data: {
            user: { id: 7, username: 'alice', display_name: 'Alice' },
            access_token: 'management-token',
          },
        })
      }
      if (url.includes('/api/token/?')) {
        return jsonResponse({
          success: true,
          data: {
            total: 0,
            items: [],
          },
        })
      }
      if (url.endsWith('/api/token/')) {
        const body = JSON.parse(String(init?.body)) as { name?: string }
        createdTokenName = body.name ?? ''
        return jsonResponse({
          success: true,
        })
      }
      if (url.includes('/api/token/search?')) {
        return jsonResponse({
          success: true,
          data: {
            items: [
              { id: 19, name: createdTokenName, key: 'prom**********test' },
            ],
          },
        })
      }
      if (url.endsWith('/api/token/19/key')) {
        return jsonResponse({
          success: true,
          data: { key: 'proma' },
        })
      }
      throw new Error(`未预期请求: ${url}`)
    }
    const client = new NewApiClient({
      fetch: fetchMock,
      serverAddress: 'https://new-api.example.com/prefix/',
    })

    const session = await client.loginWithPassword('alice', 'secret')
    const createdKey = await client.getOrCreateApiKey(
      session,
      'ccb · Xcode Desktop',
      'ccb',
    )

    expect(session.user.displayName).toBe('Alice')
    expect(createdKey).toEqual({ apiKey: 'sk-proma', tokenId: 19, created: true })
    expect(createdTokenName).toMatch(/^ccb · Xcode Desktop · [a-f0-9]{8}$/)
    expect(requests[0]?.url).toBe('https://new-api.example.com/prefix/api/user/login')
    expect(requests[1]?.url).toContain('https://new-api.example.com/prefix/api/token/?')
    expect(requests[2]?.url).toBe('https://new-api.example.com/prefix/api/token/')
    expect(new Headers(requests[2]?.init?.headers).get('Authorization')).toBe('Bearer management-token')
    expect(new Headers(requests[2]?.init?.headers).get('New-Api-User')).toBe('7')
    expect(requests[3]?.url).toContain('https://new-api.example.com/prefix/api/token/search?')
    expect(requests[4]?.url).toBe('https://new-api.example.com/prefix/api/token/19/key')
    expect(requests[4]?.init?.method).toBe('POST')
  })

  test('Given 旧版创建接口直接返回 Key When 创建令牌 Then 不再额外查询', async () => {
    let requestCount = 0
    const client = new NewApiClient({
      fetch: async (input) => {
        requestCount += 1
        if (String(input).includes('/api/token/?')) {
          return jsonResponse({
            success: true,
            data: { total: 0, items: [] },
          })
        }
        return jsonResponse({
          success: true,
          data: { key: 'legacy-key' },
        })
      },
    })

    const createdKey = await client.getOrCreateApiKey({
      user: { id: 1, username: 'legacy' },
      accessToken: 'management-token',
    }, 'ccb · Xcode Desktop', 'ccb')

    expect(createdKey).toEqual({ apiKey: 'sk-legacy-key', created: true })
    expect(requestCount).toBe(2)
  })

  test('Given ccb 令牌已禁用或额度耗尽 When 登录 Then 跳过旧令牌并创建新令牌', async () => {
    let createdTokenName = ''
    let createRequestCount = 0
    const client = new NewApiClient({
      fetch: async (input, init) => {
        const url = String(input)
        if (url.includes('/api/token/?')) {
          return jsonResponse({
            success: true,
            data: {
              total: 2,
              items: [
                {
                  id: 9,
                  name: 'ccb disabled',
                  status: 2,
                  expired_time: -1,
                  unlimited_quota: true,
                },
                {
                  id: 8,
                  name: 'ccb exhausted',
                  status: 1,
                  expired_time: -1,
                  unlimited_quota: false,
                  remain_quota: 0,
                },
              ],
            },
          })
        }
        if (url.endsWith('/api/token/')) {
          createRequestCount += 1
          const body = JSON.parse(String(init?.body)) as { name?: string }
          createdTokenName = body.name ?? ''
          return jsonResponse({ success: true })
        }
        if (url.includes('/api/token/search?')) {
          return jsonResponse({
            success: true,
            data: {
              items: [{ id: 22, name: createdTokenName }],
            },
          })
        }
        if (url.endsWith('/api/token/22/key')) {
          return jsonResponse({
            success: true,
            data: { key: 'new-ccb-key' },
          })
        }
        throw new Error(`未预期请求: ${url}`)
      },
    })

    const resolvedKey = await client.getOrCreateApiKey({
      user: { id: 7, username: 'alice' },
      accessToken: 'management-token',
    }, 'ccb · Xcode Desktop', 'ccb')

    expect(resolvedKey).toEqual({
      apiKey: 'sk-new-ccb-key',
      tokenId: 22,
      created: true,
    })
    expect(createRequestCount).toBe(1)
  })

  test('Given ccb 令牌位于第二页 When 登录 Then 扫描分页后复用', async () => {
    let listRequestCount = 0
    let createRequestCount = 0
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: 200 - index,
      name: `普通令牌 ${index}`,
      status: 1,
      expired_time: -1,
      unlimited_quota: true,
    }))
    const client = new NewApiClient({
      fetch: async (input) => {
        const url = String(input)
        if (url.includes('/api/token/?')) {
          listRequestCount += 1
          if (url.includes('p=1')) return jsonResponse({ success: true, data: firstPage })
          return jsonResponse({
            success: true,
            data: [{
              id: 7,
              name: 'ccb second page',
              status: 1,
              expired_time: -1,
              unlimited_quota: true,
            }],
          })
        }
        if (url.endsWith('/api/token/7/key')) {
          return jsonResponse({
            success: true,
            data: { key: 'second-page-key' },
          })
        }
        if (url.endsWith('/v1/models')) {
          return jsonResponse({
            data: [{ id: 'claude-sonnet' }],
          })
        }
        if (url.endsWith('/api/token/')) {
          createRequestCount += 1
        }
        throw new Error(`未预期请求: ${url}`)
      },
    })

    const resolvedKey = await client.getOrCreateApiKey({
      user: { id: 7, username: 'alice' },
      accessToken: 'management-token',
    }, 'ccb · Xcode Desktop', 'ccb')

    expect(resolvedKey).toEqual({
      apiKey: 'sk-second-page-key',
      tokenId: 7,
      created: false,
    })
    expect(listRequestCount).toBe(2)
    expect(createRequestCount).toBe(0)
  })

  test('Given 新令牌无法读取完整 Key When 创建 Then 回收本次新建令牌', async () => {
    let createdTokenName = ''
    let deletedTokenId: number | undefined
    const client = new NewApiClient({
      fetch: async (input, init) => {
        const url = String(input)
        if (url.includes('/api/token/?')) {
          return jsonResponse({
            success: true,
            data: { total: 0, items: [] },
          })
        }
        if (url.endsWith('/api/token/')) {
          const body = JSON.parse(String(init?.body)) as { name?: string }
          createdTokenName = body.name ?? ''
          return jsonResponse({ success: true })
        }
        if (url.includes('/api/token/search?')) {
          return jsonResponse({
            success: true,
            data: {
              items: [{ id: 31, name: createdTokenName }],
            },
          })
        }
        if (url.endsWith('/api/token/31/key')) {
          return jsonResponse(
            { success: false, message: '令牌不存在' },
            { status: 404 },
          )
        }
        if (url.endsWith('/api/token/31') && init?.method === 'DELETE') {
          deletedTokenId = 31
          return jsonResponse({ success: true })
        }
        throw new Error(`未预期请求: ${url}`)
      },
    })

    await expect(client.getOrCreateApiKey({
      user: { id: 7, username: 'alice' },
      accessToken: 'management-token',
    }, 'ccb · Xcode Desktop', 'ccb')).rejects.toThrow('令牌不存在')

    expect(deletedTokenId).toBe(31)
  })

  test('Given 账号开启两步验证 When 密码登录 Then 提示改用 API Key', async () => {
    const client = new NewApiClient({
      fetch: async () => jsonResponse({
        success: true,
        data: {
          require_2fa: true,
          flow_token: 'flow-token',
        },
      }),
    })

    await expect(client.loginWithPassword('alice', 'secret')).rejects.toThrow(
      '当前账号已开启两步验证，请改用 API Key 登录',
    )
  })

  test('Given 无效账号 When 登录 Then 返回中文错误', async () => {
    const client = new NewApiClient({
      fetch: async () => jsonResponse({
        success: false,
        message: 'Username or password is incorrect, or user has been banned',
      }),
    })

    await expect(client.loginWithPassword('alice', 'wrong')).rejects.toThrow(
      '账号或密码错误，或者当前账号已被禁用',
    )
  })
})

describe('NewApiClient API Key 登录', () => {
  test('Given 有效 API Key When 拉取模型 Then 保留路径前缀并按 ID 排序', async () => {
    let requestedUrl = ''
    let authorization = ''
    const client = new NewApiClient({
      serverAddress: 'https://new-api.example.com/team',
      fetch: async (input, init) => {
        requestedUrl = String(input)
        authorization = new Headers(init?.headers).get('Authorization') ?? ''
        return jsonResponse({
          object: 'list',
          data: [
            { id: 'z-model' },
            { id: 'a-model', name: 'A Model' },
          ],
        })
      },
    })

    const models = await client.fetchModels('sk-example')

    expect(requestedUrl).toBe('https://new-api.example.com/team/v1/models')
    expect(authorization).toBe('Bearer sk-example')
    expect(models).toEqual([
      { id: 'a-model', name: 'A Model' },
      { id: 'z-model', name: 'z-model' },
    ])
  })

  test('Given 已失效 API Key When 拉取模型 Then 保留 HTTP 状态码', async () => {
    const client = new NewApiClient({
      fetch: async () => jsonResponse(
        { success: false, message: '无效令牌' },
        { status: 401 },
      ),
    })

    try {
      await client.fetchModels('sk-expired')
      throw new Error('测试应抛出错误')
    } catch (error) {
      expect(error).toBeInstanceOf(NewApiRequestError)
      expect((error as NewApiRequestError).statusCode).toBe(401)
    }
  })
})

describe('New API 用户档案', () => {
  test('Given 账号用户 When 无远端头像 Then 生成首字头像', () => {
    const profile = createProfileFromRemoteUser({
      username: 'alice',
      displayName: '爱丽丝',
    })

    expect(profile.userName).toBe('爱丽丝')
    expect(profile.avatar.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })

  test('Given API Key 令牌名 When 生成档案 Then 使用令牌名展示', () => {
    const profile = createProfileFromApiKey('Proma 专用令牌')
    expect(profile.userName).toBe('Proma 专用令牌')
  })
})
