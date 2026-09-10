/**
 * ChannelForm - 模型配置编辑表单
 *
 * 支持创建和编辑模型配置，包含：
 * - 基本信息（名称、供应商、Base URL、API Key）
 * - 模型列表：已启用模型置顶 + 可用模型搜索
 * - 连接测试
 *
 * 新增和编辑统一使用显式“保存配置”，避免字段尚未编辑完成时持久化。
 */

import * as React from 'react'
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Plus,
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  Zap,
  Download,
  Search,
  Pencil,
  Save,
} from 'lucide-react'
import { toast } from 'sonner'
import { useSetAtom } from 'jotai'
import { channelFormDirtyAtom } from '@/atoms/settings-tab'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DEFAULT_THINKING_EFFORT_LEVELS,
  normalizeConfiguredThinkingEffortLevels,
  PROVIDER_DEFAULT_URLS,
  PROVIDER_LABELS,
  isAgentCompatibleProvider,
  parseZhipuTeamCredentials,
  parseCodexCredentials,
} from '@proma/shared'
import type {
  AgentRuntimeModelCatalog,
  AgentRuntimeModelInfo,
  Channel,
  ChannelCreateInput,
  ChannelModel,
  ChannelTestResult,
  FetchModelsResult,
  ProviderType,
} from '@proma/shared'
import {
  normalizeBaseUrl,
  resolveAnthropicMessagesUrl,
  resolveOpenAIChatCompletionsUrl,
  resolveOpenAIResponsesUrl,
} from '@proma/core'
import { getProviderLogo } from '@/lib/model-logo'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  SettingsSection,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsToggle,
} from './primitives'
import { findAgentRuntimeModel } from '@/lib/agent-thinking-effort'
import {
  CcbConfiguredModelEditor,
  type CcbConfiguredModelEditorValue,
} from './CcbConfiguredModelEditor'

interface ChannelFormProps {
  /** 编辑模式下传入已有渠道，创建模式传 null */
  channel: Channel | null
  onSaved: (channel?: Channel) => void
  onAgentEligibilityChange?: (channel: Channel, eligible: boolean) => void | Promise<void>
  onCancel: () => void
}

/** 所有可选供应商 */
const PROVIDER_OPTIONS: ProviderType[] = ['anthropic', 'anthropic-compatible', 'openai', 'openai-responses', 'openai-codex', 'deepseek', 'google', 'kimi-api', 'kimi-coding', 'opencode-go-openai', 'zhipu', 'zhipu-coding', 'zhipu-coding-team', 'ark-coding-plan', 'minimax', 'doubao', 'qwen', 'qwen-anthropic', 'qwen-token-plan', 'xiaomi', 'xiaomi-token-plan', 'custom']

/** 需要用 messages 端点测试的供应商预设模型 */
const PROVIDER_TEST_MODEL_PRESETS: Partial<Record<ProviderType, string[]>> = {
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  'kimi-api': ['k3', 'kimi-k2.6'],
  'opencode-go-openai': ['grok-4.5', 'glm-5.2', 'kimi-k3'],
  xiaomi: ['mimo-v2.5-pro', 'mimo-v2-pro', 'mimo-v2.5', 'mimo-v2-omni', 'mimo-v2-flash'],
  'xiaomi-token-plan': ['mimo-v2.5-pro', 'mimo-v2-pro', 'mimo-v2.5', 'mimo-v2-omni', 'mimo-v2-flash'],
  'qwen-token-plan': ['qwen3.8-max-preview', 'qwen3.7-max', 'qwen3.6-flash'],
}

/** 供应商选项（用于 SettingsSelect） */
const PROVIDER_SELECT_OPTIONS = PROVIDER_OPTIONS.map((p) => ({
  value: p,
  label: PROVIDER_LABELS[p],
  icon: getProviderLogo(p),
}))

function resolveDirectTestModelId(provider: ProviderType, models: ChannelModel[]): string | undefined {
  if (!PROVIDER_TEST_MODEL_PRESETS[provider]) return undefined
  const configuredModelId = models.find((model) => model.enabled)?.id ?? models[0]?.id
  if (configuredModelId) return configuredModelId
  return PROVIDER_TEST_MODEL_PRESETS[provider]?.[0]
}

/** 走 Anthropic 协议的供应商集合（共用 /v1/messages 端点） */
const ANTHROPIC_PROTOCOL_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'anthropic',
  'anthropic-compatible',
  'deepseek',
  'kimi-api',
  'kimi-coding',
  'zhipu-coding',
  'zhipu-coding-team',
  'ark-coding-plan',
  'minimax',
  'xiaomi',
  'xiaomi-token-plan',
  'qwen-anthropic',
  'qwen-token-plan',
])

/**
 * 生成 API 端点预览 URL
 *
 * 与运行时 channel-manager / ProviderAdapter 的端点解析逻辑保持一致。
 */
function buildPreviewUrl(baseUrl: string, provider: ProviderType): string {
  if (ANTHROPIC_PROTOCOL_PROVIDERS.has(provider)) {
    return resolveAnthropicMessagesUrl(baseUrl, provider)
  }
  if (provider === 'google') {
    return `${baseUrl.trim().replace(/\/+$/, '')}/v1beta/models/{model}:generateContent`
  }
  if (provider === 'openai-responses') {
    return resolveOpenAIResponsesUrl(baseUrl, provider)
  }
  return resolveOpenAIChatCompletionsUrl(baseUrl, provider)
}

function isThirdPartyBaseUrl(provider: ProviderType, baseUrl: string): boolean {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  return Boolean(normalizedBaseUrl) && normalizedBaseUrl !== normalizeBaseUrl(PROVIDER_DEFAULT_URLS[provider])
}

function getUrlInputLabel(provider: ProviderType): string {
  return provider === 'custom' || provider === 'anthropic-compatible' ? '请求地址' : 'Base URL'
}

function getUrlInputPlaceholder(provider: ProviderType): string {
  if (provider === 'custom') return 'https://api.example.com/v2（Chat 按原样请求）'
  if (provider === 'openai-responses') return 'https://api.example.com/v1/responses'
  if (provider === 'anthropic-compatible') return 'https://api.example.com/v1/messages'
  return 'https://api.example.com'
}

function getApiKeyPlaceholder(provider: ProviderType, isEdit: boolean): string {
  if (isEdit) return '留空则不更新'
  if (provider === 'zhipu-coding-team') {
    return '输入 API Token'
  }
  return '输入 API Key'
}

interface ZhipuTeamSecretForm {
  apiKey: string
  organization: string
  project: string
}

const EMPTY_ZHIPU_TEAM_SECRET: ZhipuTeamSecretForm = {
  apiKey: '',
  organization: '',
  project: '',
}

function parseZhipuTeamSecret(secret: string): Partial<ZhipuTeamSecretForm> {
  const credentials = parseZhipuTeamCredentials(secret)
  if (!credentials) return {}
  return {
    apiKey: credentials.apiKey,
    organization: credentials.organization ?? '',
    project: credentials.project ?? '',
  }
}

function buildZhipuTeamSecret(secret: ZhipuTeamSecretForm): string {
  const payload: Record<string, string> = {}
  if (secret.apiKey.trim()) payload.apiKey = secret.apiKey.trim()
  if (secret.organization.trim()) payload.organization = secret.organization.trim()
  if (secret.project.trim()) payload.project = secret.project.trim()
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : ''
}

function isAgentEligibleChannel(channel: Pick<Channel, 'provider' | 'enabled'>): boolean {
  return channel.enabled && isAgentCompatibleProvider(channel.provider)
}

function createEmptyModelDraft(): CcbConfiguredModelEditorValue {
  return {
    id: '',
    name: '',
    description: '',
    effortLevels: [...DEFAULT_THINKING_EFFORT_LEVELS],
  }
}

function getModelListValidationError(models: ChannelModel[]): string | undefined {
  const ids = new Set<string>()
  for (const model of models) {
    const id = model.id.trim()
    if (!id) return '模型 ID 不能为空'
    if (ids.has(id)) return `模型 ID「${id}」重复`
    ids.add(id)
    if (
      model.contextWindow !== undefined
      && (
        !Number.isInteger(model.contextWindow)
        || model.contextWindow <= 0
      )
    ) {
      return `模型「${id}」的 Context Window 必须是正整数`
    }
    if (
      model.autoCompactRatio !== undefined
      && (
        !Number.isFinite(model.autoCompactRatio)
        || model.autoCompactRatio < 0
        || model.autoCompactRatio > 100
      )
    ) {
      return `模型「${id}」的压缩触发占比必须是 0-100 之间的数字`
    }
  }
  return undefined
}

function toCcbConfiguredModelEditorValue(
  model: ChannelModel,
): CcbConfiguredModelEditorValue {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    contextWindow: model.contextWindow,
    autoCompactRatio: model.autoCompactRatio,
    effortLevels: model.thinkingEffortLevels,
  }
}

export function ChannelForm({
  channel,
  onSaved,
  onAgentEligibilityChange,
  onCancel,
}: ChannelFormProps): React.ReactElement {
  const isEdit = channel !== null

  // 表单状态
  const [name, setName] = React.useState(channel?.name ?? '')
  const [provider, setProvider] = React.useState<ProviderType>(channel?.provider ?? 'anthropic')
  const [baseUrl, setBaseUrl] = React.useState(channel?.baseUrl ?? PROVIDER_DEFAULT_URLS.anthropic)
  const [acknowledgedBaseUrl, setAcknowledgedBaseUrl] = React.useState(() => (
    normalizeBaseUrl(channel?.baseUrl ?? PROVIDER_DEFAULT_URLS[channel?.provider ?? 'anthropic'])
  ))
  const [apiKey, setApiKey] = React.useState('')
  const [zhipuTeamSecret, setZhipuTeamSecret] = React.useState<ZhipuTeamSecretForm>(EMPTY_ZHIPU_TEAM_SECRET)
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [models, setModels] = React.useState<ChannelModel[]>(channel?.models ?? [])
  const [defaultModelId, setDefaultModelId] = React.useState(
    channel?.defaultModelId
      ?? channel?.models.find(model => model.enabled)?.id
      ?? '',
  )
  const [enabled, setEnabled] = React.useState(channel?.enabled ?? true)
  const [autoCompactRatio, setAutoCompactRatio] = React.useState<number | undefined>(
    channel?.autoCompactRatio,
  )
  const initialApiKeyRef = React.useRef('')

  // 模型新增和编辑
  const [newModelDraft, setNewModelDraft] =
    React.useState<CcbConfiguredModelEditorValue>(createEmptyModelDraft)
  const [showNewModelEditor, setShowNewModelEditor] = React.useState(false)
  const [editingModelId, setEditingModelId] = React.useState<string>()

  // 模型搜索过滤
  const [modelFilter, setModelFilter] = React.useState('')

  // UI 状态
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<ChannelTestResult | null>(null)
  const [fetchingModels, setFetchingModels] = React.useState(false)
  const [fetchResult, setFetchResult] = React.useState<FetchModelsResult | null>(null)
  const [runtimeCatalog, setRuntimeCatalog] = React.useState<AgentRuntimeModelCatalog | null>(null)
  const [runtimeCatalogLoading, setRuntimeCatalogLoading] = React.useState(false)
  const [runtimeCatalogError, setRuntimeCatalogError] = React.useState<string | null>(null)
  const [apiKeyLoaded, setApiKeyLoaded] = React.useState(false)
  const [showExitDialog, setShowExitDialog] = React.useState(false)
  const [showBaseUrlRiskDialog, setShowBaseUrlRiskDialog] = React.useState(false)
  const [pendingRiskAction, setPendingRiskAction] =
    React.useState<'save' | 'fetch' | 'test' | null>(null)
  const [codexLoggingIn, setCodexLoggingIn] = React.useState(false)

  const setChannelFormDirty = useSetAtom(channelFormDirtyAtom)
  const lastAgentEligibleRef = React.useRef(channel ? isAgentEligibleChannel(channel) : false)

  React.useEffect(() => {
    lastAgentEligibleRef.current = channel ? isAgentEligibleChannel(channel) : false
  }, [channel])

  /** 编辑模式下加载明文 API Key */
  React.useEffect(() => {
    if (isEdit && channel && !apiKeyLoaded) {
      window.electronAPI.decryptApiKey(channel.id).then((key) => {
        setApiKey(key)
        initialApiKeyRef.current = key
        if (channel.provider === 'zhipu-coding-team') {
          setZhipuTeamSecret({ ...EMPTY_ZHIPU_TEAM_SECRET, ...parseZhipuTeamSecret(key) })
        }
        setApiKeyLoaded(true)
      }).catch((error) => {
        console.error('[模型配置表单] 解密 API Key 失败:', error)
        setApiKeyLoaded(true)
      })
    }
  }, [isEdit, channel, apiKeyLoaded])

  const isZhipuTeamProvider = provider === 'zhipu-coding-team'
  const isCodexProvider = provider === 'openai-codex'
  const effectiveApiKey = isZhipuTeamProvider ? buildZhipuTeamSecret(zhipuTeamSecret) : apiKey
  // ChatGPT (Codex)：apiKey state 存的是登录后拿到的凭据 JSON；能解析出有效凭据即视为已登录。
  const codexCredentials = isCodexProvider ? parseCodexCredentials(apiKey) : null
  const hasRequiredSecret = isZhipuTeamProvider
    ? Boolean(zhipuTeamSecret.apiKey.trim())
    : isCodexProvider
      ? Boolean(codexCredentials)
      : Boolean(apiKey.trim())
  const requiresBaseUrlRiskAcknowledgement = isThirdPartyBaseUrl(provider, baseUrl)
    && normalizeBaseUrl(baseUrl) !== acknowledgedBaseUrl
  const runtimeCatalogRequestIdRef = React.useRef(0)
  const modelListValidationError = React.useMemo(
    () => getModelListValidationError(models),
    [models],
  )

  React.useEffect(() => {
    const requestId = ++runtimeCatalogRequestIdRef.current
    const canResolve =
      models.length > 0
      && !modelListValidationError
      && hasRequiredSecret
      && (isCodexProvider || Boolean(baseUrl.trim()))
      && (!isEdit || apiKeyLoaded)

    if (!canResolve) {
      setRuntimeCatalog(null)
      setRuntimeCatalogLoading(false)
      setRuntimeCatalogError(null)
      return
    }

    setRuntimeCatalogLoading(true)
    setRuntimeCatalogError(null)
    const timer = setTimeout(() => {
      void window.electronAPI.getAgentRuntimeModelCatalogDraft({
        provider,
        baseUrl,
        apiKey: effectiveApiKey,
        models,
        defaultModel: defaultModelId || undefined,
      }).then(catalog => {
        if (runtimeCatalogRequestIdRef.current !== requestId) return
        setRuntimeCatalog(catalog)
        setRuntimeCatalogLoading(false)
      }).catch(error => {
        if (runtimeCatalogRequestIdRef.current !== requestId) return
        console.error('[模型配置表单] Pi 模型能力解析失败:', error)
        setRuntimeCatalog(null)
        setRuntimeCatalogLoading(false)
        setRuntimeCatalogError(
          error instanceof Error ? error.message : 'Pi 模型能力解析失败',
        )
      })
    }, 450)

    return () => clearTimeout(timer)
  }, [
    apiKeyLoaded,
    baseUrl,
    effectiveApiKey,
    hasRequiredSecret,
    isCodexProvider,
    isEdit,
    models,
    defaultModelId,
    modelListValidationError,
    provider,
  ])

  const updateZhipuTeamSecret = React.useCallback((patch: Partial<ZhipuTeamSecretForm>) => {
    setZhipuTeamSecret((prev) => {
      const next = { ...prev, ...patch }
      setApiKey(buildZhipuTeamSecret(next))
      return next
    })
  }, [])

  // 默认模型始终归一化到已启用模型；禁用、删除或改名默认模型时自动回退。
  React.useEffect(() => {
    const enabledModelIds = new Set(
      models.filter(model => model.enabled).map(model => model.id),
    )
    if (defaultModelId && enabledModelIds.has(defaultModelId)) return
    setDefaultModelId(models.find(model => model.enabled)?.id ?? '')
  }, [defaultModelId, models])

  // 切换供应商时自动更新 Base URL 与名称，Anthropic 兼容渠道自动添加预设模型
  const handleProviderChange = (newProvider: string): void => {
    const p = newProvider as ProviderType
    // 若 name 为空或仍是上一个 provider 的默认名称，则用新 provider 的名称覆盖；用户手动改过的 name 不动
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName === PROVIDER_LABELS[provider]) {
      setName(PROVIDER_LABELS[p])
    }
    setProvider(p)
    setBaseUrl(PROVIDER_DEFAULT_URLS[p])
    setAcknowledgedBaseUrl(normalizeBaseUrl(PROVIDER_DEFAULT_URLS[p]))
    setTestResult(null)
    setFetchResult(null)
    if (p === 'zhipu-coding-team') {
      const parsed = parseZhipuTeamSecret(apiKey)
      setZhipuTeamSecret({ ...EMPTY_ZHIPU_TEAM_SECRET, ...parsed })
      setApiKey(buildZhipuTeamSecret({ ...EMPTY_ZHIPU_TEAM_SECRET, ...parsed }))
    } else if (provider === 'zhipu-coding-team') {
      setApiKey(zhipuTeamSecret.apiKey)
      setZhipuTeamSecret(EMPTY_ZHIPU_TEAM_SECRET)
    }
    // 预设模型：首次切换到对应 provider 且无模型时自动填充
    if (models.length === 0) {
      if (p === 'deepseek') {
        setModels([
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
        ])
      } else if (p === 'kimi-api') {
        setModels([
          { id: 'k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-k2.6', name: 'Kimi K2.6', enabled: true },
        ])
      } else if (p === 'kimi-coding') {
        setModels([
          { id: 'k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-for-coding', name: 'Kimi for Coding', enabled: true },
        ])
      } else if (p === 'opencode-go-openai') {
        setModels([
          { id: 'grok-4.5', name: 'Grok 4.5', enabled: true },
          { id: 'glm-5.2', name: 'GLM-5.2', enabled: true },
          { id: 'glm-5.1', name: 'GLM-5.1', enabled: true },
          { id: 'kimi-k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', enabled: true },
          { id: 'kimi-k2.6', name: 'Kimi K2.6', enabled: true },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
          { id: 'mimo-v2.5', name: 'MiMo V2.5', enabled: true },
          { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', enabled: true },
        ])
      } else if (p === 'zhipu' || p === 'zhipu-coding' || p === 'zhipu-coding-team') {
        setModels([
          { id: 'glm-5.2', name: 'GLM-5.2', enabled: true },
          { id: 'glm-5.1', name: 'GLM-5.1', enabled: false },
        ])
      } else if (p === 'ark-coding-plan') {
        setModels([
          { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code', enabled: true },
          { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro', enabled: true },
          { id: 'doubao-seed-2.0-lite', name: 'Doubao Seed 2.0 Lite', enabled: true },
          { id: 'glm-5.2', name: 'GLM-5.2', enabled: true },
          { id: 'k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', enabled: true },
          { id: 'minimax-m3', name: 'MiniMax M3', enabled: true },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
        ])
      } else if (p === 'minimax') {
        setModels([
          { id: 'MiniMax-M3', name: 'MiniMax-M3', enabled: true },
          { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', enabled: true },
        ])
      } else if (p === 'xiaomi' || p === 'xiaomi-token-plan') {
        setModels([
          { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', enabled: true },
          { id: 'mimo-v2-pro', name: 'MiMo V2 Pro', enabled: true },
          { id: 'mimo-v2.5', name: 'MiMo V2.5', enabled: true },
          { id: 'mimo-v2-omni', name: 'MiMo V2 Omni', enabled: true },
          { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', enabled: true },
        ])
      } else if (p === 'qwen-anthropic') {
        setModels([
          { id: 'qwen3.7-max', name: 'Qwen3.7 Max', enabled: true },
          { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', enabled: true },
        ])
      } else if (p === 'qwen-token-plan') {
        setModels([
          { id: 'qwen3.8-max-preview', name: 'Qwen3.8 Max Preview', enabled: true },
          { id: 'qwen3.7-max', name: 'Qwen3.7 Max', enabled: true },
          { id: 'qwen3.6-flash', name: 'Qwen3.6 Flash', enabled: true },
        ])
      }
    }
  }

  /** 添加模型 */
  const handleAddModel = (): void => {
    const id = newModelDraft.id.trim()
    if (!id) return
    if (models.some(model => model.id.trim() === id)) {
      toast.error(`模型 ID「${id}」已经存在`)
      return
    }
    if (
      newModelDraft.contextWindow !== undefined
      && (
        !Number.isInteger(newModelDraft.contextWindow)
        || newModelDraft.contextWindow <= 0
      )
    ) {
      toast.error('Context Window 必须是正整数')
      return
    }
    if (
      newModelDraft.autoCompactRatio !== undefined
      && (
        !Number.isFinite(newModelDraft.autoCompactRatio)
        || newModelDraft.autoCompactRatio < 0
        || newModelDraft.autoCompactRatio > 100
      )
    ) {
      toast.error('压缩触发占比必须是 0-100 之间的数字')
      return
    }

    const model: ChannelModel = {
      id,
      name: newModelDraft.name?.trim() || id,
      ...(newModelDraft.description?.trim()
        ? { description: newModelDraft.description.trim() }
        : {}),
      ...(newModelDraft.contextWindow !== undefined
        ? { contextWindow: newModelDraft.contextWindow }
        : {}),
      ...(newModelDraft.autoCompactRatio !== undefined
        ? { autoCompactRatio: newModelDraft.autoCompactRatio }
        : {}),
      thinkingEffortLevels: normalizeConfiguredThinkingEffortLevels(newModelDraft.effortLevels),
      enabled: true,
      source: 'manual',
    }

    setModels((prev) => [...prev, model])
    setNewModelDraft(createEmptyModelDraft())
    setShowNewModelEditor(false)
  }

  /** 更新模型配置字段。 */
  const handleUpdateModel = (
    target: ChannelModel,
    patch: Partial<CcbConfiguredModelEditorValue>,
  ): void => {
    const previousId = target.id
    setModels(current => current.map(model => {
      if (model !== target) return model
      return {
        ...model,
        ...(patch.id !== undefined ? { id: patch.id } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.contextWindow !== undefined
          ? { contextWindow: patch.contextWindow }
          : patch.contextWindow === undefined && 'contextWindow' in patch
            ? { contextWindow: undefined }
            : {}),
        ...(patch.autoCompactRatio !== undefined
          ? { autoCompactRatio: patch.autoCompactRatio }
          : patch.autoCompactRatio === undefined && 'autoCompactRatio' in patch
            ? { autoCompactRatio: undefined }
            : {}),
        ...(patch.effortLevels !== undefined
          ? { thinkingEffortLevels: [...patch.effortLevels] }
          : 'effortLevels' in patch
            ? { thinkingEffortLevels: undefined }
            : {}),
      }
    }))
    if (patch.id !== undefined) {
      setEditingModelId(patch.id)
      if (defaultModelId === previousId) {
        setDefaultModelId(patch.id)
      }
    }
  }

  /** 删除模型；允许清空已启用模型，会话侧再提示无可用模型。 */
  const handleRemoveModel = (modelId: string): void => {
    setModels((prev) => prev.filter((m) => m.id !== modelId))
  }

  /** 切换模型启用状态（点击可用模型 → 启用，点击已启用模型 → 禁用） */
  const handleToggleModel = (modelId: string): void => {
    setModels((prev) =>
      prev.map((m) => (m.id === modelId ? { ...m, enabled: !m.enabled } : m))
    )
  }

  /** 发起 ChatGPT (Codex) OAuth 登录：打开浏览器授权，成功后把凭据写入 apiKey */
  const handleCodexLogin = async (): Promise<void> => {
    setCodexLoggingIn(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.codexOAuthLogin()
      if (!result.success || !result.credentials) {
        toast.error(result.message ?? 'ChatGPT 登录失败，请重试')
        return
      }
      const credentials = result.credentials
      // 凭据 JSON 已含 accountId，写入 apiKey 后由 codexCredentials 派生展示，无需单独 state。
      setApiKey(credentials)

      // ChatGPT 模型目录由 Pi Runtime 使用的 OAuth 渠道提供；登录后自动拉取并全部启用。
      // 不复用 handleFetchModels：其 gate 读派生自 apiKey state 的 hasRequiredSecret，
      // 而 setApiKey 是异步的，同一 tick 内仍是旧值，这里直接内联拉取。
      let codexModels: ChannelModel[] = []
      try {
        const modelsResult = await window.electronAPI.fetchModels({ provider, baseUrl, apiKey: credentials })
        setFetchResult(modelsResult)
        if (modelsResult.success && modelsResult.models.length > 0) {
          codexModels = modelsResult.models.map((m) => ({ ...m, enabled: true }))
          setModels(codexModels)
        }
      } catch (modelErr) {
        console.error('[模型配置表单] 拉取 ChatGPT 模型失败:', modelErr)
      }

      if (codexModels.length > 0) {
        setDefaultModelId(codexModels[0]!.id)
      }
      toast.success('ChatGPT 登录成功，请保存配置')
    } catch (error) {
      console.error('[模型配置表单] ChatGPT 登录失败:', error)
      toast.error('ChatGPT 登录失败，请重试')
    } finally {
      setCodexLoggingIn(false)
    }
  }

  /** 从供应商 API 拉取可用模型列表。 */
  const fetchAvailableModels = async (): Promise<void> => {
    // ChatGPT 订阅由 Pi Runtime 管理请求地址；其余 Provider 仍要求 Base URL。
    if (!hasRequiredSecret || (!isCodexProvider && !baseUrl.trim())) return

    setFetchingModels(true)
    setFetchResult(null)

    try {
      const result = await window.electronAPI.fetchModels({
        provider,
        baseUrl,
        apiKey: effectiveApiKey,
      })

      setFetchResult(result)

      // 用成功拉取的结果作为权威清单替换：
      // - source==='manual' 的模型一律保留（即便不在新结果里）
      // - 在新结果里也存在的旧模型保留 enabled 状态
      // - 新出现的模型默认未启用
      // - 既不在新结果里、也不是手动添加的旧模型一律丢弃（清除残留）
      // 拉取失败时保留现有列表，避免 auto-save 持久化空模型列表
      if (!result.success) return
      const fetchedModels = result.models
      const fetchedById = new Map(fetchedModels.map((m) => [m.id, m]))
      setModels((prev) => {
        const manualKept = prev.filter((m) => m.source === 'manual' && !fetchedById.has(m.id))
        const merged = fetchedModels.map((m) => {
          const old = prev.find((p) => p.id === m.id)
          const mergedModel: ChannelModel = old
            ? {
                ...m,
                ...old,
                id: m.id,
                source: old.source ?? 'fetched',
              }
            : {
                ...m,
                source: 'fetched',
              }
          // ChatGPT (Codex) 是 SDK 内置的少量精选模型，拉取即全部启用，
          // 与登录自动拉取路径（handleCodexLogin）保持一致，避免新模型（如 gpt-5.6 系列）
          // 默认未启用而沉到「可用模型」折叠区，被误认为"拉不到"。
          if (isCodexProvider) return { ...mergedModel, enabled: true }
          return { ...mergedModel, enabled: old?.enabled ?? false }
        })
        return [...manualKept, ...merged]
      })
    } catch (error) {
      setFetchResult({ success: false, message: '拉取模型请求失败', models: [] })
    } finally {
      setFetchingModels(false)
    }
  }

  const handleFetchModels = (): void => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('fetch')
      return
    }
    void fetchAvailableModels()
  }

  /** 测试连接（直接使用表单当前值，无需先保存）。 */
  const testChannelConnection = async (): Promise<void> => {
    if (!hasRequiredSecret || !baseUrl.trim()) return

    setTesting(true)
    setTestResult(null)

    try {
      const modelId = resolveDirectTestModelId(provider, models)
      const result = await window.electronAPI.testChannelDirect({
        provider,
        baseUrl,
        apiKey: effectiveApiKey,
        ...(modelId ? { modelId } : {}),
      })
      setTestResult(result)
    } catch (error) {
      setTestResult({ success: false, message: '测试请求失败' })
    } finally {
      setTesting(false)
    }
  }

  const handleTest = (): void => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('test')
      return
    }
    void testChannelConnection()
  }

  /** 显式保存新增或编辑配置。 */
  const doSave = React.useCallback(async (): Promise<Channel | null> => {
    if (!name.trim() || !hasRequiredSecret) return null

    setSaving(true)
    try {
      const input: ChannelCreateInput = {
        name: name.trim(),
        provider,
        baseUrl,
        apiKey: effectiveApiKey,
        models: models.map(model => ({
          ...model,
          thinkingEffortLevels: normalizeConfiguredThinkingEffortLevels(model.thinkingEffortLevels),
        })),
        // 显式保留 undefined，让编辑保存能清除旧比例并恢复默认值。
        autoCompactRatio,
        defaultModelId: defaultModelId || undefined,
        enabled,
      }
      const savedChannel = isEdit && channel
        ? await window.electronAPI.updateChannel(channel.id, input)
        : await window.electronAPI.createChannel(input)
      const eligible = isAgentEligibleChannel(savedChannel)
      if (eligible !== lastAgentEligibleRef.current) {
        lastAgentEligibleRef.current = eligible
        await onAgentEligibilityChange?.(savedChannel, eligible)
      }
      toast.success(isEdit ? '模型配置已保存' : '模型配置已创建')
      return savedChannel
    } catch (error) {
      console.error('[模型配置表单] 保存失败:', error)
      toast.error('模型配置保存失败，请检查配置后重试')
      return null
    } finally {
      setSaving(false)
    }
  }, [
    autoCompactRatio,
    baseUrl,
    channel,
    defaultModelId,
    effectiveApiKey,
    enabled,
    hasRequiredSecret,
    isEdit,
    models,
    name,
    onAgentEligibilityChange,
    provider,
  ])

  /** 显示第三方 Base URL 风险确认。 */
  const requestBaseUrlRiskAcknowledgement = (
    action: 'save' | 'fetch' | 'test' | null,
  ): void => {
    setPendingRiskAction(action)
    setShowBaseUrlRiskDialog(true)
  }

  /** 确认风险后，仅放行当前变更的 Base URL。 */
  const handleBaseUrlRiskAcknowledgement = async (): Promise<void> => {
    const action = pendingRiskAction
    setAcknowledgedBaseUrl(normalizeBaseUrl(baseUrl))
    setPendingRiskAction(null)
    setShowBaseUrlRiskDialog(false)

    if (action === 'fetch') {
      await fetchAvailableModels()
      return
    }
    if (action === 'test') {
      await testChannelConnection()
      return
    }

    if (action !== 'save') return
    const savedChannel = await doSave()
    if (!savedChannel) return
    setShowExitDialog(false)
    onSaved(savedChannel)
  }

  /** Base URL 失焦时，要求确认第三方中转站风险。 */
  const handleBaseUrlBlur = (): void => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement(null)
    }
  }

  /** 保存配置。 */
  const handleSave = async (): Promise<void> => {
    if (
      autoCompactRatio !== undefined
      && (
        !Number.isFinite(autoCompactRatio)
        || autoCompactRatio < 0
        || autoCompactRatio > 100
      )
    ) {
      toast.error('供应商压缩触发占比必须是 0-100 之间的数字')
      return
    }
    if (modelListValidationError) {
      toast.error(modelListValidationError)
      return
    }
    if (models.length === 0) {
      toast.warning('尚未配置模型，建议先从供应商获取或手动添加', { id: 'no-models-warn' })
      return
    }
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('save')
      return
    }
    const savedChannel = await doSave()
    if (savedChannel) onSaved(savedChannel)
  }

  /** 检测表单是否有未保存内容 */
  const originalDefaultModelId =
    channel?.defaultModelId
    ?? channel?.models.find(model => model.enabled)?.id
    ?? ''
  const isDirty = isEdit && channel
    ? apiKeyLoaded && (
        name !== channel.name
        || provider !== channel.provider
        || baseUrl !== channel.baseUrl
        || effectiveApiKey !== initialApiKeyRef.current
        || JSON.stringify(models) !== JSON.stringify(channel.models)
        || autoCompactRatio !== channel.autoCompactRatio
        || defaultModelId !== originalDefaultModelId
        || enabled !== channel.enabled
      )
    : (
        name.trim() !== ''
        || effectiveApiKey.trim() !== ''
        || models.length > 0
        || defaultModelId !== ''
      )
  const hasNoModels = models.length === 0

  /** 返回按钮：创建模式下有未保存内容时拦截 */
  const handleBack = (): void => {
    if (isDirty) {
      setShowExitDialog(true)
      return
    }
    onCancel()
  }

  /** 放弃编辑 */
  const handleDiscard = (): void => {
    setShowExitDialog(false)
    onCancel()
  }

  /** 保存并关闭（从弹窗触发） */
  const handleSaveAndClose = async (): Promise<void> => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('save')
      return
    }
    const savedChannel = await doSave()
    if (savedChannel) {
      setShowExitDialog(false)
      onSaved(savedChannel)
    }
  }

  // 同步表单 dirty 状态到全局 atom（供 SettingsPanel 拦截侧边栏导航）
  React.useEffect(() => {
    setChannelFormDirty(isDirty)
    return () => { setChannelFormDirty(false) }
  }, [isDirty, setChannelFormDirty])

  // 拦截窗口关闭（Cmd+W / Alt+F4 / 点击窗口 X）
  React.useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  // ===== 模型分区 =====
  const enabledModels = models.filter((m) => m.enabled)
  const defaultModelOptions = enabledModels.map(model => ({
    value: model.id,
    label: model.name || model.id,
  }))
  const availableModels = React.useMemo(() => {
    const disabled = models.filter((m) => !m.enabled)
    if (!modelFilter.trim()) return disabled
    const keyword = modelFilter.trim().toLowerCase()
    return disabled.filter(
      (m) => m.id.toLowerCase().includes(keyword) || m.name.toLowerCase().includes(keyword)
    )
  }, [models, modelFilter])
  const resolveRuntimeModelInfo = React.useCallback(
    (modelId: string): AgentRuntimeModelInfo | undefined => (
      findAgentRuntimeModel(runtimeCatalog?.models ?? [], modelId)
    ),
    [runtimeCatalog],
  )
  const resolveModelIdError = React.useCallback(
    (target: ChannelModel): string | undefined => {
      const id = target.id.trim()
      if (!id) return '模型 ID 不能为空'
      const duplicate = models.some(
        model => model !== target && model.id.trim() === id,
      )
      return duplicate
        ? `模型 ID「${id}」重复`
        : undefined
    },
    [models],
  )
  const newModelIdError = React.useMemo(() => {
    const id = newModelDraft.id.trim()
    if (!id) return undefined
    return models.some(model => model.id.trim() === id)
      ? `模型 ID「${id}」已经存在`
      : undefined
  }, [models, newModelDraft.id])
  const runtimeCatalogStatus = runtimeCatalogLoading
    ? 'Pi Runtime 正在解析模型能力…'
    : runtimeCatalog
      ? `Pi Runtime 已解析 ${runtimeCatalog.models.length} 个模型${runtimeCatalog.runtimeVersion ? ` · ${runtimeCatalog.runtimeVersion}` : ''}`
      : runtimeCatalogError
        ? 'Pi Runtime 解析失败'
        : undefined

  return (
    <div className="space-y-6">
      {/* 标题栏 */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleBack}
        >
          <ArrowLeft size={18} />
        </Button>
        <h3 className="text-lg font-medium text-foreground flex-1">
          {isEdit ? '编辑模型配置' : '添加模型配置'}
        </h3>
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={
            saving
            || !name.trim()
            || !hasRequiredSecret
            || models.length === 0
            || Boolean(modelListValidationError)
          }
        >
          {saving
            ? <Loader2 size={14} className="animate-spin" />
            : <Save size={14} />}
          <span>保存配置</span>
        </Button>
      </div>

      {/* 基本信息卡片 */}
      <SettingsSection title="基本信息">
        <SettingsCard>
          <SettingsSelect
            label="供应商类型"
            value={provider}
            onValueChange={handleProviderChange}
            options={PROVIDER_SELECT_OPTIONS}
            placeholder="选择供应商"
          />
          {provider === 'custom' && (
            <div className="px-4 pb-3 text-xs text-muted-foreground">
              用于 OpenAI Chat Completions 的自定义请求地址，Chat 会按原样发送请求。Agent 使用 Pi Runtime；若服务提供 Anthropic Messages 端点，请选择「Anthropic 兼容格式」。
            </div>
          )}
          <SettingsInput
            label="供应商名称"
            value={name}
            onChange={setName}
            placeholder="例如: My Anthropic"
            required
          />
          {/* ChatGPT 订阅的请求地址由 Pi Runtime 管理，无需用户填写 */}
          {!isCodexProvider && (
            <SettingsInput
              label={getUrlInputLabel(provider)}
              value={baseUrl}
              onChange={setBaseUrl}
              onBlur={handleBaseUrlBlur}
              placeholder={getUrlInputPlaceholder(provider)}
              description={baseUrl.trim() ? `预览：${buildPreviewUrl(baseUrl, provider)}` : undefined}
            />
          )}
          {/* API Key + 测试连接同行 */}
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">
                {isCodexProvider ? 'ChatGPT 登录' : isZhipuTeamProvider ? '智谱团队版凭证' : 'API Key'}
              </div>
              {/* codex 无 baseUrl/apiKey，测试连接不适用，隐藏测试按钮 */}
              {!isCodexProvider && (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={handleTest}
                  disabled={testing || !hasRequiredSecret || !baseUrl.trim()}
                  className="h-7 text-xs"
                >
                  {testing ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Zap size={12} />
                  )}
                  <span>测试连接</span>
                </Button>
              )}
            </div>
            {isCodexProvider ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={handleCodexLogin}
                  disabled={codexLoggingIn}
                  className="w-full"
                >
                  {codexLoggingIn ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Zap size={14} />
                  )}
                  <span>
                    {codexLoggingIn
                      ? '等待浏览器授权…'
                      : hasRequiredSecret
                        ? '重新登录 ChatGPT'
                        : '用 ChatGPT 登录'}
                  </span>
                </Button>
                {hasRequiredSecret ? (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                    <CheckCircle2 size={12} className="shrink-0" />
                    <span>
                      已登录 ChatGPT 订阅
                      {codexCredentials?.accountId ? `（账号 ${codexCredentials.accountId.slice(0, 8)}…）` : ''}
                    </span>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    使用 ChatGPT Plus/Pro 订阅登录，通过 OAuth 授权，无需 API Key。授权将在系统浏览器中打开。
                  </div>
                )}
              </div>
            ) : isZhipuTeamProvider ? (
              <div className="space-y-2">
                <div className="relative">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    value={zhipuTeamSecret.apiKey}
                    onChange={(e) => updateZhipuTeamSecret({ apiKey: e.target.value })}
                    placeholder="API Token"
                    required={!isEdit}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                    title={showApiKey ? '隐藏凭证' : '显示凭证'}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input
                    value={zhipuTeamSecret.organization}
                    onChange={(e) => updateZhipuTeamSecret({ organization: e.target.value })}
                    placeholder="组织 ID（可选）"
                  />
                  <Input
                    value={zhipuTeamSecret.project}
                    onChange={(e) => updateZhipuTeamSecret({ project: e.target.value })}
                    placeholder="项目 ID（可选）"
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  组织 ID 和项目 ID 可在{' '}
                  <a
                    href="https://bigmodel.cn/usercenter/proj-mgmt/org-mgmt"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    智谱组织与项目管理
                  </a>
                  {' '}查看；不填写时使用 API Token 的默认组织与项目上下文查询。
                </div>
              </div>
            ) : (
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={getApiKeyPlaceholder(provider, isEdit)}
                  required={!isEdit}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            )}
            {testResult && (
              <div className={cn(
                'flex items-start gap-1.5 text-xs',
                testResult.success ? 'text-emerald-600' : 'text-destructive'
              )}>
                {testResult.success
                  ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                  : <XCircle size={12} className="mt-0.5 shrink-0" />}
                <span className="min-w-0 break-all">{testResult.message}</span>
              </div>
            )}
          </div>
          <SettingsInput
            label="上下文压缩触发占比"
            description="整个供应商所有模型的默认压缩占比（0-100，百分比）。未配置的模型使用该值；模型单独配置时以模型为准。留空默认 80%。"
            type="number"
            value={autoCompactRatio === undefined ? '' : String(autoCompactRatio)}
            onChange={(value) => {
              const raw = value.trim()
              setAutoCompactRatio(raw ? Number(raw) : undefined)
            }}
            placeholder="默认 80%"
          />
          <SettingsToggle
            label="启用此配置"
            description="关闭后该配置的模型不会在选择列表中出现"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <SettingsSelect
            label="默认模型"
            description="新建会话和 Pi 默认使用的模型"
            value={defaultModelId}
            onValueChange={setDefaultModelId}
            options={defaultModelOptions}
            placeholder="请先启用模型"
            disabled={defaultModelOptions.length === 0}
          />
        </SettingsCard>
      </SettingsSection>

      {/* 已启用模型 */}
      <SettingsSection
        title="已启用模型"
        description={[
          enabledModels.length > 0 ? `${enabledModels.length} 个模型` : undefined,
          runtimeCatalogStatus,
        ].filter(Boolean).join(' · ') || undefined}
      >
        {runtimeCatalogError && (
          <div className="px-1 text-xs text-destructive">
            模型列表仍可编辑；Pi 能力信息将在配置正确后自动恢复。
          </div>
        )}
        <SettingsCard divided={false}>
          {enabledModels.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              还没有启用任何模型，从下方可用模型中选择
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {enabledModels.map((model) => (
                <div
                  key={model.id}
                  className="group"
                >
                  <div className="flex items-center gap-2 px-4 py-2.5">
                    <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-foreground">
                        {model.name || model.id}
                        {model.name && model.name !== model.id && (
                          <span className="text-muted-foreground ml-1">({model.id})</span>
                        )}
                      </div>
                      {model.description && (
                        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                          {model.description}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditingModelId(
                        editingModelId === model.id ? undefined : model.id,
                      )}
                      className="p-1 text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
                      title="编辑模型配置"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleModel(model.id)}
                      className="p-0.5 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                      title="取消启用"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {editingModelId === model.id && (
                    <div className="border-t border-border/50 bg-muted/15 p-4">
                      <CcbConfiguredModelEditor
                        value={toCcbConfiguredModelEditorValue(model)}
                        runtimeModel={resolveRuntimeModelInfo(model.id)}
                        idError={resolveModelIdError(model)}
                        onChange={patch => handleUpdateModel(model, patch)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* 可用模型 */}
      <SettingsSection
        title="可用模型"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setShowNewModelEditor(current => !current)}
              className="h-7 text-xs"
            >
              <Plus size={12} />
              <span>添加模型</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={handleFetchModels}
              disabled={fetchingModels || !hasRequiredSecret || (!isCodexProvider && !baseUrl.trim())}
              className="h-7 text-xs"
            >
              {fetchingModels ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Download size={12} />
              )}
              <span>从供应商获取</span>
            </Button>
          </div>
        }
      >
        {/* 拉取结果提示 */}
        {fetchResult && (
          <div className={cn(
            'flex items-center gap-1.5 text-xs px-1',
            fetchResult.success ? 'text-emerald-600' : 'text-destructive'
          )}>
            {fetchResult.success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span>{fetchResult.message}</span>
          </div>
        )}

        <SettingsCard divided={false}>
          {/* 模型搜索过滤 */}
          {models.filter((m) => !m.enabled).length > 5 && (
            <div className="px-4 pt-3 pb-1">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder="搜索可用模型..."
                  className="h-8 text-sm pl-8"
                />
              </div>
            </div>
          )}

          {/* 可用模型计数 */}
          {models.filter((m) => !m.enabled).length > 0 && (
            <div className="px-4 pt-2 pb-1 text-xs text-muted-foreground">
              {modelFilter.trim()
                ? `${availableModels.length} / ${models.filter((m) => !m.enabled).length} 个可用模型`
                : `${models.filter((m) => !m.enabled).length} 个可用模型`}
            </div>
          )}

          <ScrollArea className={availableModels.length > 8 ? 'h-[280px]' : undefined}>
            <div className="divide-y divide-border/50">
              {availableModels.map((model) => (
                <div
                  key={model.id}
                  className="group"
                >
                  <div
                    className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() => handleToggleModel(model.id)}
                  >
                    <Plus size={14} className="text-muted-foreground flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-foreground">
                        {model.name || model.id}
                        {model.name && model.name !== model.id && (
                          <span className="text-muted-foreground ml-1">({model.id})</span>
                        )}
                      </div>
                      {model.description && (
                        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                          {model.description}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        setEditingModelId(
                          editingModelId === model.id ? undefined : model.id,
                        )
                      }}
                      className="p-1 text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
                      title="编辑模型配置"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleRemoveModel(model.id) }}
                      className="p-0.5 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                      title="删除"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {editingModelId === model.id && (
                    <div className="border-t border-border/50 bg-muted/15 p-4">
                      <CcbConfiguredModelEditor
                        value={toCcbConfiguredModelEditorValue(model)}
                        runtimeModel={resolveRuntimeModelInfo(model.id)}
                        idError={resolveModelIdError(model)}
                        onChange={patch => handleUpdateModel(model, patch)}
                      />
                    </div>
                  )}
                </div>
              ))}

              {/* 搜索无结果提示 */}
              {modelFilter.trim() && availableModels.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  未找到匹配的模型
                </div>
              )}

              {/* 无可用模型提示 */}
              {!modelFilter.trim() && models.filter((m) => !m.enabled).length === 0 && models.length > 0 && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  所有模型已启用
                </div>
              )}
            </div>
          </ScrollArea>

          {/* 手动添加模型：配置由模型中心统一交给 Pi。 */}
          {showNewModelEditor && (
            <div className="space-y-4 border-t border-border/50 bg-muted/15 p-4">
              <div>
                <p className="text-sm font-medium">添加自定义模型</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  可按模型服务文档设置上下文窗口与思考等级，统一交给 Pi 执行。
                </p>
              </div>
              <CcbConfiguredModelEditor
                value={newModelDraft}
                idError={newModelIdError}
                onChange={patch => setNewModelDraft(current => ({
                  ...current,
                  ...patch,
                }))}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setNewModelDraft(createEmptyModelDraft())
                    setShowNewModelEditor(false)
                  }}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  type="button"
                  onClick={handleAddModel}
                  disabled={!newModelDraft.id.trim() || Boolean(newModelIdError)}
                >
                  <Plus size={14} />
                  添加并启用
                </Button>
              </div>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* 第三方 Base URL 风险确认 */}
      <AlertDialog
        open={showBaseUrlRiskDialog}
        onOpenChange={(open) => {
          setShowBaseUrlRiskDialog(open)
          if (!open) setPendingRiskAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认使用第三方中转站？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>该地址并非当前供应商的官方默认 Base URL。中转站可能存在篡改对话内容和模型响应，存在中间人攻击、凭据泄露与隐私风险。</p>
                <p>其协议适配也可能导致上下文窗口、工具调用、多模态或流式内容显示异常。请仅使用你信赖的服务，并先用非敏感内容测试。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleBaseUrlRiskAcknowledgement}>
              知晓并愿意承担风险
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 退出拦截弹窗 */}
      <AlertDialog open={showExitDialog} onOpenChange={setShowExitDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              {hasNoModels
                ? '当前尚未配置模型，建议先配置模型再保存。'
                : '您填写的内容尚未保存，确定要放弃编辑吗？'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDiscard}>放弃编辑</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSaveAndClose}
              disabled={saving || !name.trim() || !hasRequiredSecret}
            >
              {saving ? <><Loader2 size={14} className="animate-spin" /> 保存中...</> : '保存并关闭'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
