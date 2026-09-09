import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  AlertCircle,
  Bot,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  AgentDelegationRole,
  AgentRegistrationUpdate,
  PromaPermissionMode,
  RegisteredAgent,
  ThinkingEffortLevel,
} from '@proma/shared'
import {
  agentRegistrationConfigAtom,
  agentRegistrationDirtyAtom,
  agentRegistrationDraftAtom,
  agentRegistrationErrorAtom,
  agentRegistrationLoadingAtom,
  agentRegistrationSavingAtom,
  loadAgentRegistrationAtom,
  saveAgentRegistrationAtom,
} from '@/atoms/agent-registration'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  createAgentRegistrationUpdate,
  createEmptyAgentRegistrationForm,
  MAX_AGENT_PROMPT_UTF8_BYTES,
  MAX_GLOBAL_AGENT_INSTRUCTIONS_UTF8_BYTES,
  MAX_REGISTERED_AGENT_COUNT,
  registeredAgentToForm,
  utf8ByteLength,
  validateAgentRegistration,
  validateGlobalAgentInstructions,
  type AgentRegistrationFormValue,
  type AgentRegistrationValidationResult,
  type AgentToolPolicy,
} from '@/lib/agent-registration'

export interface AgentRegistrationsTabProps {
  search: string
  onCreateAvailabilityChange?: (openEditor: (() => void) | null) => void
}

const ROLE_OPTIONS: Array<{ value: AgentDelegationRole; label: string }> = [
  { value: 'explore', label: '探索' },
  { value: 'research', label: '研究' },
  { value: 'implement', label: '实施' },
  { value: 'review', label: '审查' },
  { value: 'custom', label: '自定义' },
]

const PERMISSION_OPTIONS: Array<{ value: PromaPermissionMode; label: string }> = [
  { value: 'default', label: '请求批准' },
  { value: 'bypassPermissions', label: '完全自动' },
  { value: 'plan', label: '计划模式' },
]

const EFFORT_OPTIONS: Array<{ value: ThinkingEffortLevel; label: string }> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
]

export function AgentRegistrationsTab({
  search,
  onCreateAvailabilityChange,
}: AgentRegistrationsTabProps): React.ReactElement {
  const config = useAtomValue(agentRegistrationConfigAtom)
  const [draft, setDraft] = useAtom(agentRegistrationDraftAtom)
  const loading = useAtomValue(agentRegistrationLoadingAtom)
  const saving = useAtomValue(agentRegistrationSavingAtom)
  const error = useAtomValue(agentRegistrationErrorAtom)
  const dirty = useAtomValue(agentRegistrationDirtyAtom)
  const load = useSetAtom(loadAgentRegistrationAtom)
  const save = useSetAtom(saveAgentRegistrationAtom)

  const [editingAgent, setEditingAgent] = React.useState<RegisteredAgent | null | undefined>(undefined)
  const [pendingDelete, setPendingDelete] = React.useState<RegisteredAgent | null>(null)
  const initialLoadRequestedRef = React.useRef(false)

  const openCreate = React.useCallback(() => setEditingAgent(null), [])
  React.useEffect(() => {
    onCreateAvailabilityChange?.(openCreate)
    return () => onCreateAvailabilityChange?.(null)
  }, [onCreateAvailabilityChange, openCreate])

  React.useEffect(() => {
    if (initialLoadRequestedRef.current) return
    initialLoadRequestedRef.current = true
    if (!config) void load()
  }, [config, load])

  React.useEffect(() => {
    if (!dirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  const filteredAgents = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    const agents = draft?.agents ?? []
    if (!query) return agents
    return agents.filter((agent) =>
      agent.name.toLowerCase().includes(query)
      || agent.id.toLowerCase().includes(query)
      || agent.description.toLowerCase().includes(query)
      || (agent.role ?? '').toLowerCase().includes(query),
    )
  }, [draft?.agents, search])
  const instructionsError = draft
    ? validateGlobalAgentInstructions(draft.globalInstructions)
    : null
  const reachedAgentLimit = (draft?.agents.length ?? 0) >= MAX_REGISTERED_AGENT_COUNT

  const persist = React.useCallback(async (
    update: AgentRegistrationUpdate,
    successMessage: string,
  ): Promise<boolean> => {
    const updateInstructionsError = validateGlobalAgentInstructions(update.globalInstructions)
    if (updateInstructionsError) {
      toast.error(updateInstructionsError)
      return false
    }
    if (update.agents.length > MAX_REGISTERED_AGENT_COUNT) {
      toast.error(`最多只能注册 ${MAX_REGISTERED_AGENT_COUNT} 个 Agent`)
      return false
    }
    try {
      await save(update)
      toast.success(successMessage)
      return true
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : '保存失败，请重试')
      return false
    }
  }, [save])

  const handleToggle = async (agent: RegisteredAgent, enabled: boolean): Promise<void> => {
    if (!draft || saving) return
    const agents = draft.agents.map((item) => item.id === agent.id ? { ...item, enabled } : item)
    await persist(
      createAgentRegistrationUpdate(agents, draft.globalInstructions),
      enabled ? `已启用「${agent.name}」` : `已停用「${agent.name}」`,
    )
  }

  const handleSaveEditor = async (agent: RegisteredAgent): Promise<boolean> => {
    if (!draft) return false
    const exists = draft.agents.some((item) => item.id === agent.id)
    if (!exists && draft.agents.length >= MAX_REGISTERED_AGENT_COUNT) {
      toast.error(`最多只能注册 ${MAX_REGISTERED_AGENT_COUNT} 个 Agent`)
      return false
    }
    const agents = exists
      ? draft.agents.map((item) => item.id === agent.id ? agent : item)
      : [...draft.agents, agent]
    const ok = await persist(
      createAgentRegistrationUpdate(agents, draft.globalInstructions),
      exists ? `已更新「${agent.name}」` : `已注册「${agent.name}」`,
    )
    return ok
  }

  const handleDelete = async (): Promise<void> => {
    if (!draft || !pendingDelete || saving) return
    const target = pendingDelete
    const ok = await persist(
      createAgentRegistrationUpdate(
        draft.agents.filter((agent) => agent.id !== target.id),
        draft.globalInstructions,
      ),
      `已删除「${target.name}」`,
    )
    if (ok) setPendingDelete(null)
  }

  const handleSaveInstructions = async (): Promise<void> => {
    if (!draft || saving) return
    if (instructionsError) {
      toast.error(instructionsError)
      return
    }
    await persist(createAgentRegistrationUpdate(draft.agents, draft.globalInstructions), '全局 AGENTS.md 规则已保存')
  }

  const handleReload = (): void => {
    if (dirty && !window.confirm('当前有未保存的全局规则，重新加载会丢失这些修改。是否继续？')) return
    void load()
  }

  if (loading && !config) {
    return <div className="py-20 text-center text-sm text-muted-foreground">加载子 Agent 注册配置...</div>
  }

  if (!config || !draft) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 pt-20 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-destructive/10">
          <AlertCircle className="size-7 text-destructive/80" />
        </div>
        <div>
          <div className="text-[15px] font-medium">无法加载子 Agent 注册配置</div>
          <div className="mt-1 text-[13px] text-muted-foreground">{error ?? '请稍后重试'}</div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw size={14} />
          重试
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-7">
      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-destructive/8 px-4 py-3 text-[13px] text-destructive">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4 px-1">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold">已注册 Agents</h2>
              <span className="text-xs tabular-nums text-muted-foreground">{draft.agents.length}</span>
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              全局注册，不依赖当前工作区。模型留空时继承父会话，且只能使用父会话渠道支持的模型。
            </p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            disabled={reachedAgentLimit}
            title={reachedAgentLimit ? `最多注册 ${MAX_REGISTERED_AGENT_COUNT} 个 Agent` : undefined}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={14} />
            新增 Agent
          </button>
        </div>

        <PathCard label="角色 Markdown 注册目录" path={config.agentsPath} />
        <div className="px-1 text-[12px] leading-5 text-muted-foreground">
          也可以直接在该目录新增或编辑 <code className="rounded bg-foreground/[0.05] px-1 py-0.5">id.md</code>
          角色文件；受限 YAML frontmatter 保存角色元数据，正文作为系统提示词。保存后从下一轮运行开始读取。
        </div>

        {filteredAgents.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-foreground/[0.025] px-6 py-14 text-center shadow-sm">
            <Bot className="size-8 text-foreground/25" />
            <div>
              <div className="text-[14px] font-medium">
                {draft.agents.length === 0 ? '还没有注册子 Agent' : '没有匹配的 Agent'}
              </div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                {draft.agents.length === 0
                  ? '创建可复用的角色，让父 Agent 按需委派任务。'
                  : '试试更换搜索关键词。'}
              </div>
            </div>
            {draft.agents.length === 0 && (
              <Button size="sm" onClick={openCreate}>
                <Plus size={14} />
                新增 Agent
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filteredAgents.map((agent) => (
              <AgentRegistrationCard
                key={agent.id}
                agent={agent}
                filePath={`${config.agentsPath.replace(/[\\/]$/, '')}/${agent.id}.md`}
                disabled={saving}
                onToggle={(enabled) => void handleToggle(agent, enabled)}
                onEdit={() => setEditingAgent(agent)}
                onDelete={() => setPendingDelete(agent)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4 px-1">
          <div>
            <div className="flex items-center gap-2">
              <FileText size={15} className="text-muted-foreground" />
              <h2 className="text-[14px] font-semibold">全局 AGENTS.md 规则</h2>
              {dirty && (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  未保存
                </span>
              )}
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              保存后从下一轮 Agent 运行开始生效，不会改变正在执行的任务。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" disabled={loading || saving} onClick={handleReload}>
              <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
              重新加载
            </Button>
            <Button size="sm" disabled={!dirty || saving || !!instructionsError} onClick={() => void handleSaveInstructions()}>
              <Save size={14} />
              {saving ? '保存中...' : '保存规则'}
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl bg-content-area shadow-sm ring-1 ring-border/40">
          <div className="border-b border-border/40 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">实际文件路径</div>
            <div className="mt-1 break-all font-mono text-[12px] text-foreground/70">{config.instructionsPath}</div>
          </div>
          <div className="p-4">
            <Textarea
              value={draft.globalInstructions}
              onChange={(event) => setDraft({ ...draft, globalInstructions: event.target.value })}
              placeholder="在这里编写所有 Agent 都应遵守的全局规则..."
              className="min-h-64 resize-y font-mono text-[13px] leading-6"
              aria-label="全局 AGENTS.md 规则"
            />
            <div className={cn(
              'mt-2 flex items-center justify-between text-[11px] text-muted-foreground',
              instructionsError && 'text-destructive',
            )}>
              <span>{instructionsError ?? '支持 Markdown；保存后下一轮运行生效。'}</span>
              <span className="tabular-nums">
                {utf8ByteLength(draft.globalInstructions).toLocaleString()} / {MAX_GLOBAL_AGENT_INSTRUCTIONS_UTF8_BYTES.toLocaleString()} UTF-8 字节
              </span>
            </div>
          </div>
        </div>
      </section>

      <AgentRegistrationDialog
        open={editingAgent !== undefined}
        agent={editingAgent ?? null}
        existingAgents={draft.agents}
        saving={saving}
        onOpenChange={(open) => { if (!open) setEditingAgent(undefined) }}
        onSave={handleSaveEditor}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
        title={`确认删除 Agent「${pendingDelete?.name}」？`}
        description="删除注册后，父 Agent 将不能再通过该稳定 ID 委派新任务。此操作不会停止已经运行的任务。"
        confirmLabel="删除"
        loadingLabel="删除中..."
        loading={saving}
        onConfirm={handleDelete}
      />
    </div>
  )
}

function PathCard({ label, path }: { label: string; path: string }): React.ReactElement {
  return (
    <div className="rounded-xl bg-foreground/[0.025] px-4 py-3 shadow-sm ring-1 ring-border/35">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-all font-mono text-[12px] text-foreground/65">{path}</div>
    </div>
  )
}

interface AgentRegistrationCardProps {
  agent: RegisteredAgent
  filePath: string
  disabled: boolean
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDelete: () => void
}

function AgentRegistrationCard({
  agent,
  filePath,
  disabled,
  onToggle,
  onEdit,
  onDelete,
}: AgentRegistrationCardProps): React.ReactElement {
  const role = ROLE_OPTIONS.find((option) => option.value === agent.role)?.label ?? '未指定'
  return (
    <article className={cn(
      'flex min-h-52 flex-col rounded-2xl bg-content-area p-4 shadow-sm ring-1 ring-border/40 transition-shadow hover:shadow-md',
      !agent.enabled && 'opacity-65',
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Bot size={20} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[14px] font-semibold">{agent.name}</h3>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{agent.id}</div>
          </div>
        </div>
        <Switch
          checked={agent.enabled}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={`${agent.enabled ? '停用' : '启用'} ${agent.name}`}
        />
      </div>

      <p className="mt-3 line-clamp-3 text-[12px] leading-5 text-foreground/60">{agent.description}</p>
      <div className="mt-2 break-all font-mono text-[10px] leading-4 text-muted-foreground/70">
        {filePath}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <MetaTag>{role}</MetaTag>
        <MetaTag>{agent.modelId || '继承模型'}</MetaTag>
        <MetaTag>{agent.maxTurns ? `${agent.maxTurns} 轮` : '继承轮数'}</MetaTag>
        {agent.tools?.length === 0 && <MetaTag tone="warning">禁止工具</MetaTag>}
        {agent.tools && agent.tools.length > 0 && <MetaTag>{agent.tools.length} 个允许工具</MetaTag>}
      </div>

      <div className="mt-auto flex items-center justify-end gap-1 pt-4">
        <Button variant="ghost" size="sm" onClick={onEdit} disabled={disabled}>
          <Pencil size={14} />
          编辑
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          disabled={disabled}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 size={14} />
          删除
        </Button>
      </div>
    </article>
  )
}

function MetaTag({
  children,
  tone = 'default',
}: {
  children: React.ReactNode
  tone?: 'default' | 'warning'
}): React.ReactElement {
  return (
    <span className={cn(
      'max-w-full truncate rounded-md bg-foreground/[0.045] px-2 py-1 text-[10px] text-foreground/55',
      tone === 'warning' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    )}>
      {children}
    </span>
  )
}

interface AgentRegistrationDialogProps {
  open: boolean
  agent: RegisteredAgent | null
  existingAgents: RegisteredAgent[]
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (agent: RegisteredAgent) => Promise<boolean>
}

function AgentRegistrationDialog({
  open,
  agent,
  existingAgents,
  saving,
  onOpenChange,
  onSave,
}: AgentRegistrationDialogProps): React.ReactElement {
  const [value, setValue] = React.useState<AgentRegistrationFormValue>(createEmptyAgentRegistrationForm)
  const [errors, setErrors] = React.useState<AgentRegistrationValidationResult['errors']>({})
  const initialValue = React.useMemo(
    () => agent ? registeredAgentToForm(agent) : createEmptyAgentRegistrationForm(),
    [agent],
  )
  const formDirty = JSON.stringify(value) !== JSON.stringify(initialValue)

  React.useEffect(() => {
    if (!open) return
    setValue(initialValue)
    setErrors({})
  }, [initialValue, open])

  const update = <K extends keyof AgentRegistrationFormValue>(
    key: K,
    next: AgentRegistrationFormValue[K],
  ): void => {
    setValue((previous) => ({ ...previous, [key]: next }))
    setErrors((previous) => ({ ...previous, [key]: undefined }))
  }

  const requestClose = (): void => {
    if (saving) return
    if (formDirty && !window.confirm('当前 Agent 表单有未保存修改，确定关闭吗？')) return
    onOpenChange(false)
  }

  const submit = async (): Promise<void> => {
    const result = validateAgentRegistration(value, existingAgents, agent?.id)
    setErrors(result.errors)
    if (!result.agent) return
    if (await onSave(result.agent)) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose() }}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto" onEscapeKeyDown={(event) => {
        if (formDirty || saving) event.preventDefault()
      }}>
        <DialogHeader>
          <DialogTitle>{agent ? `编辑 ${agent.name}` : '新增注册 Agent'}</DialogTitle>
          <DialogDescription>
            注册配置全局生效。稳定 ID 创建后不可修改，父 Agent 将使用它进行明确委派。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="名称" required error={errors.name}>
              <Input
                value={value.name}
                maxLength={100}
                onChange={(event) => update('name', event.target.value)}
                placeholder="例如：修复实施专家"
              />
            </FormField>
            <FormField
              label="稳定 ID"
              required
              error={errors.id}
              description={agent ? '稳定 ID 创建后不可修改。' : '小写字母开头，可包含数字和连字符。'}
            >
              <Input
                value={value.id}
                disabled={!!agent}
                maxLength={64}
                onChange={(event) => update('id', event.target.value)}
                placeholder="fix-executor"
                className="font-mono"
              />
            </FormField>
          </div>

          <FormField label="说明" error={errors.description} description="可选，用于帮助父 Agent 判断何时委派给此角色，最多 2000 字符。">
            <Textarea
              value={value.description}
              maxLength={2000}
              onChange={(event) => update('description', event.target.value)}
              placeholder="简要说明专长、边界和适用任务..."
              className="min-h-20"
            />
          </FormField>

          <FormField
            label="系统提示词"
            required
            error={errors.prompt}
            description={`定义该子 Agent 的职责、工作边界和交付要求，最大 ${MAX_AGENT_PROMPT_UTF8_BYTES / 1024} KiB（按 UTF-8 字节计算）。`}
          >
            <Textarea
              value={value.prompt}
              maxLength={64 * 1024}
              onChange={(event) => update('prompt', event.target.value)}
              placeholder="你是..."
              className="min-h-36 font-mono text-[13px] leading-5"
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormSelect
              label="角色"
              value={value.role || '__inherit__'}
              onValueChange={(next) => update('role', next === '__inherit__' ? '' : next as AgentDelegationRole)}
              options={[{ value: '__inherit__', label: '未指定' }, ...ROLE_OPTIONS]}
            />
            <FormSelect
              label="权限"
              value={value.permissionMode || '__inherit__'}
              onValueChange={(next) => update('permissionMode', next === '__inherit__' ? '' : next as PromaPermissionMode)}
              options={[{ value: '__inherit__', label: '继承父会话' }, ...PERMISSION_OPTIONS]}
              description="实际权限不会高于父会话。"
            />
            <FormSelect
              label="推理强度"
              value={value.effortLevel || '__inherit__'}
              onValueChange={(next) => update('effortLevel', next === '__inherit__' ? '' : next as ThinkingEffortLevel)}
              options={[{ value: '__inherit__', label: '继承父会话' }, ...EFFORT_OPTIONS]}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="模型 ID（可选）"
              description="留空继承父会话；只能填写父会话渠道支持的 model ID，不代表跨渠道调用。"
            >
              <Input
                value={value.modelId}
                maxLength={256}
                onChange={(event) => update('modelId', event.target.value)}
                placeholder="留空继承"
                className="font-mono"
              />
            </FormField>
            <FormField label="最大轮数（可选）" error={errors.maxTurns} description="必须是 1 到 1000 的整数。">
              <Input
                type="number"
                min={1}
                step={1}
                value={value.maxTurns}
                onChange={(event) => update('maxTurns', event.target.value)}
                placeholder="留空继承"
              />
            </FormField>
          </div>

          <div className="rounded-2xl bg-foreground/[0.025] p-4 ring-1 ring-border/35">
            <div className="flex items-center gap-2">
              <Wrench size={15} className="text-muted-foreground" />
              <h3 className="text-[13px] font-semibold">工具范围</h3>
            </div>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div className="space-y-3">
                <FormSelect
                  label="允许工具"
                  value={value.toolPolicy}
                  onValueChange={(next) => update('toolPolicy', next as AgentToolPolicy)}
                  options={[
                    { value: 'inherit', label: '继承父会话工具' },
                    { value: 'custom', label: '仅允许指定工具' },
                    { value: 'none', label: '不允许任何工具' },
                  ]}
                  description="“不允许任何工具”会保存显式空数组；空白继承则不写入 tools。"
                />
                {value.toolPolicy === 'custom' && (
                  <FormField
                    label="允许列表"
                    error={errors.toolsText}
                    description="名称严格区分大小写。Pi 内置工具使用 read、bash、edit、write、grep、find、ls；MCP 使用发现结果中的完整原名。"
                  >
                    <Textarea
                      value={value.toolsText}
                      onChange={(event) => update('toolsText', event.target.value)}
                      placeholder={'read\ngrep\nproma_mcp_discover'}
                      className="min-h-28 font-mono text-[12px]"
                    />
                  </FormField>
                )}
              </div>
              <FormField
                label="禁用工具列表"
                error={errors.disallowedToolsText}
                description="可选，每行一个严格区分大小写的真实工具名；会在允许范围上继续收紧。"
              >
                <Textarea
                  value={value.disallowedToolsText}
                  onChange={(event) => update('disallowedToolsText', event.target.value)}
                  placeholder={'bash\nwrite'}
                  className="min-h-28 font-mono text-[12px]"
                />
              </FormField>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl bg-foreground/[0.025] px-4 py-3 ring-1 ring-border/35">
            <div className="flex items-center gap-3">
              <ShieldCheck size={17} className="text-muted-foreground" />
              <div>
                <div className="text-[13px] font-medium">启用注册</div>
                <div className="text-[11px] text-muted-foreground">关闭后保留配置，但父 Agent 不再委派新任务。</div>
              </div>
            </div>
            <Switch checked={value.enabled} onCheckedChange={(checked) => update('enabled', checked)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={requestClose}>取消</Button>
          <Button disabled={saving} onClick={() => void submit()}>
            <Save size={14} />
            {saving ? '保存中...' : '保存 Agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FormField({
  label,
  description,
  error,
  required,
  children,
}: {
  label: string
  description?: string
  error?: string
  required?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <label className="space-y-1.5">
      <span className="text-[12px] font-medium text-foreground/80">
        {label}{required && <span className="ml-1 text-destructive">*</span>}
      </span>
      {children}
      {(error || description) && (
        <span className={cn('block text-[11px] leading-4 text-muted-foreground', error && 'text-destructive')}>
          {error ?? description}
        </span>
      )}
    </label>
  )
}

function FormSelect({
  label,
  value,
  onValueChange,
  options,
  description,
}: {
  label: string
  value: string
  onValueChange: (value: string) => void
  options: Array<{ value: string; label: string }>
  description?: string
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <div className="text-[12px] font-medium text-foreground/80">{label}</div>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description && <div className="text-[11px] leading-4 text-muted-foreground">{description}</div>}
    </div>
  )
}
