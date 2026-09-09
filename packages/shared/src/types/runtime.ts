/**
 * 运行时相关类型定义
 * 用于 Electron 应用的运行时环境检测和状态管理
 */

import type { PromaRuntimeApiMode } from './runtime-dispatch'

/**
 * 支持的操作系统平台
 */
export type Platform = 'darwin' | 'linux' | 'win32'

/**
 * 支持的 CPU 架构
 */
export type Architecture = 'arm64' | 'x64'

/**
 * 平台-架构组合标识
 * 用于确定下载哪个 Bun 二进制文件
 */
export type PlatformArch =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-x64'

/**
 * Proma 历史上识别过的 Runtime。
 *
 * 该联合类型暂时保留用于读取旧配置、旧会话和旧任务记录；当前可执行内核请使用
 * ExecutableRuntimeId，避免把 legacy 标识重新暴露为可选或可执行项。
 */
export type RuntimeId = 'pi' | 'hermes' | 'codex' | 'claude'

/** Proma 当前唯一允许执行的新 Runtime。 */
export type ExecutableRuntimeId = 'pi'

/** 历史上被策略调度过的外部 Harness，仅用于兼容读取。 */
export type RoutedHarnessId = 'codex' | 'claude'

/** 历史 Runtime 角色分类，仅用于兼容已有注册表数据。 */
export type RuntimeRole = 'kernel' | 'routed-harness'

/** Runtime 的历史 Harness 标识。native 是 Pi 主内核的兼容别名。 */
export type HarnessId = 'native' | RuntimeId

/** Proma 当前唯一允许执行的新 Harness。 */
export type ExecutableHarnessId = 'pi'

/** Runtime 能力键，来源于统一 Runtime Capability 模型。 */
export type RuntimeCapability =
  | 'streaming'
  | 'tools'
  | 'approvals'
  | 'steering'
  | 'cancellation'
  | 'sessionResume'
  | 'customModels'
  | 'managedCredentials'
  | 'contextUsage'
  | 'compaction'
  | 'workTasks'

export type RuntimeCapabilitySupport = 'supported' | 'partial' | 'unsupported' | 'unknown'

export interface RuntimeCapabilitySnapshot {
  runtimeId: RuntimeId
  runtimeVersion: string
  source: 'system' | 'bundled' | 'managed' | 'unknown'
  capabilities: Partial<Record<RuntimeCapability, RuntimeCapabilitySupport>>
  checkedAt: number
}

export interface RuntimeInstallation {
  runtimeId: RuntimeId
  status: 'unknown' | 'checking' | 'ready' | 'missing' | 'broken'
  version: string | null
  executablePath: string | null
  source: 'system' | 'bundled' | 'managed' | null
  detail: string | null
  checkedAt: number | null
}

export interface RuntimeDefinition {
  id: RuntimeId
  role: RuntimeRole
  name: string
  description: string
  command: string | null
  bundled: boolean
  capabilities: RuntimeCapability[]
  installation: RuntimeInstallation
}

export interface RuntimeModelCatalog {
  runtimeId: RuntimeId
  source: 'proma-channels' | 'legacy-compat'
  models: RuntimeModelCatalogEntry[]
  usableModelCount: number
}

/** 统一 Runtime 配置，凭证仍由渠道/safeStorage 管理，不在此保存明文密钥。 */
export interface RuntimeConfig {
  /** Proma Runtime 工作目录。 */
  runtimeHome: string | null
  /** 外部 Runtime 源码目录，用于复用 Pi/Hermes Bridge。 */
  runtimeSourceHome: string | null
  /** 外部 Runtime API 地址；留空时仅使用 Proma 本地适配层。 */
  runtimeApiBaseUrl: string | null
  /**
   * 旧 Frakio 配置字段，仅用于兼容读取。
   *
   * 新配置和设置页面不会再写入这些字段。
   */
  frakioHome?: string | null
  frakioSourceHome?: string | null
  frakioApiBaseUrl?: string | null
  defaultRuntimeId: RuntimeId
  defaultHarnessId: HarnessId
  enabledRuntimeIds: RuntimeId[]
  routedHarnesses: RoutedHarnessId[]
  updatedAt: number
}

export type RuntimePackageSource = 'bundled' | 'managed' | 'native' | 'system'
export type RuntimePackageState = 'checking' | 'missing' | 'installed' | 'broken'

export interface RuntimePackage {
  runtimeId: RuntimeId
  runtimeVersion: string
  runtimeBuildId: string
  source: RuntimePackageSource
  installationState: RuntimePackageState
  availability: 'ready' | 'unavailable' | 'broken'
  executablePath: string | null
  runtimeDir: string | null
  installedAt: string | null
  verifiedAt: string | null
  detail: string | null
}

export interface RuntimeActivation {
  runtimeId: RuntimeId
  activeBuildId: string | null
  previousBuildId: string | null
  activationRevision: string
}

export interface RuntimePackageStatus {
  runtimeId: RuntimeId
  activation: RuntimeActivation | null
  activeBinding: RuntimePackage | null
  packages: RuntimePackage[]
  upstreamLatest: string | null
  /** Runtime Catalog 返回的可安装版本。 */
  availableVersions?: RuntimeRelease[]
  checkedAt: string
  source: 'remote' | 'local'
}

export interface RuntimeRelease {
  version: string
  packageVersion?: string
  integrity?: string
  verifiedAt?: string
  node?: string
  detail?: string
}

export interface RuntimeDiscoveryCandidate {
  executablePath: string
  version: string | null
  source: 'system' | 'managed' | 'unknown'
  detail: string | null
}

export interface RuntimeModelCatalogEntry {
  id: string
  name: string
  provider: string
  defaultModelId: string | null
  models: string[]
  compatible: boolean
}

/** 模型中心返回的公开模型配置，不包含明文凭证。 */
export interface ModelCenterModel {
  id: string
  name: string
  provider: string
  providerKey: string
  model: string
  models: string[]
  baseUrl: string
  apiMode: PromaRuntimeApiMode
  hasApiKey: boolean
  oauthAccountId: string
  runtimeRevision: string
}

/** Proma 模型中心与可选 Runtime API 的连接状态。 */
export interface ModelCenterStatus {
  configured: boolean
  connected: boolean
  baseUrl: string | null
  models: ModelCenterModel[]
  usableModelCount: number
  checkedAt: string
  error: string | null
}

export const RUNTIME_IPC_CHANNELS = {
  LIST: 'runtime-registry:list',
  REFRESH: 'runtime-registry:refresh',
  GET_CONFIG: 'runtime-registry:get-config',
  UPDATE_CONFIG: 'runtime-registry:update-config',
  GET_CAPABILITIES: 'runtime-registry:get-capabilities',
  DETECT: 'runtime-registry:detect',
  DISCOVER: 'runtime-registry:discover',
  GET_PACKAGE_STATUS: 'runtime-registry:get-package-status',
  INSTALL_PACKAGE: 'runtime-registry:install-package',
  ACTIVATE_PACKAGE: 'runtime-registry:activate-package',
  DELETE_PACKAGE: 'runtime-registry:delete-package',
  BIND_NATIVE: 'runtime-registry:bind-native',
  UNBIND_NATIVE: 'runtime-registry:unbind-native',
  GET_MODEL_CENTER_STATUS: 'runtime-registry:get-model-center-status',
} as const

export type RuntimeIpcChannel = (typeof RUNTIME_IPC_CHANNELS)[keyof typeof RUNTIME_IPC_CHANNELS]

/**
 * Bun 二进制下载信息
 */
export interface BunDownloadInfo {
  /** 目标平台架构 */
  platformArch: PlatformArch
  /** 下载 URL */
  url: string
  /** Bun GitHub releases 中的文件名 */
  zipFileName: string
  /** 解压后的二进制文件名 */
  binaryName: string
}

/**
 * Bun 运行时状态
 */
export interface BunRuntimeStatus {
  /** 是否可用 */
  available: boolean
  /** Bun 二进制路径 */
  path: string | null
  /** Bun 版本号 */
  version: string | null
  /** 来源：system（系统 PATH）| bundled（打包内置）| vendor（开发环境 vendor 目录）*/
  source: 'system' | 'bundled' | 'vendor' | null
  /** 错误信息（如果不可用）*/
  error: string | null
}

/**
 * Node.js 运行时状态
 */
export interface NodeRuntimeStatus {
  /** 是否可用 */
  available: boolean
  /** Node.js 版本号 */
  version: string | null
  /** Node.js 可执行路径 */
  path: string | null
  /** 错误信息（如果不可用）*/
  error: string | null
}

/**
 * Git 运行时状态
 */
export interface GitRuntimeStatus {
  /** 是否可用 */
  available: boolean
  /** Git 版本号 */
  version: string | null
  /** Git 可执行路径 */
  path: string | null
  /** 错误信息（如果不可用）*/
  error: string | null
}

/**
 * Git 仓库状态
 */
export interface GitRepoStatus {
  /** 是否为 Git 仓库 */
  isRepo: boolean
  /** 当前分支名称 */
  branch: string | null
  /** 是否有未提交的更改 */
  hasChanges: boolean
  /** 远程仓库 URL */
  remoteUrl: string | null
}

/** 变更文件状态 */
export type ChangedFileStatus = 'modified' | 'deleted' | 'untracked'

/** 文件来源标识 */
export type ChangeSource = 'session' | 'workspace' | 'both' | 'none'

/** 单个变更文件条目 */
export interface ChangedFileEntry {
  /** 文件路径（相对于仓库根） */
  filePath: string
  /** 变更状态 */
  status: ChangedFileStatus
  /** 新增行数 */
  additions: number
  /** 删除行数 */
  deletions: number
  /** 文件来源 */
  source: ChangeSource
  /** 所属 Git 仓库根目录 */
  gitRoot: string
}

/** 单个未追踪文件条目 */
export interface UntrackedFileEntry {
  /** 文件路径（相对于仓库根） */
  filePath: string
  /** 所属 Git 仓库根目录 */
  gitRoot: string
}

/** 未暂存变更结果 */
export interface UnstagedChangesResult {
  /** 是否为 Git 仓库 */
  isGitRepo: boolean
  /** 已追踪文件的变更列表 */
  files: ChangedFileEntry[]
  /** 未追踪文件列表 */
  untrackedFiles: UntrackedFileEntry[]
  /** Git 仓库根目录名数组（多仓库场景用于分组显示） */
  gitRootNames: string[]
}

/** Git Worktree 信息 */
export interface WorktreeInfo {
  /** worktree 绝对路径 */
  path: string
  /** 分支名 */
  branch: string
  /** HEAD commit hash (short) */
  head: string
  /** 是否为主 worktree */
  isMain: boolean
  /** 显示名（路径最后一段） */
  name: string
}

/** 本地分支信息 */
export interface GitBranchInfo {
  /** 分支名 */
  name: string
  /** 是否为当前检出分支 */
  current: boolean
}

/** 列出本地分支结果 */
export interface ListGitBranchesResult {
  /** 是否为 Git 仓库 */
  isRepo: boolean
  /** 当前分支名；detached HEAD 时为 null */
  currentBranch: string | null
  /** 本地分支列表 */
  branches: GitBranchInfo[]
}

/** 列出远程结果 */
export interface ListGitRemotesResult {
  /** 是否为 Git 仓库 */
  isRepo: boolean
  /** 远程名称列表（如 origin） */
  remotes: string[]
  /** 当前分支的上游远程（如有） */
  upstreamRemote: string | null
}

/** 通用 Git 操作结果 */
export interface GitOperationResult {
  ok: boolean
  /** 成功时的简要信息 */
  message?: string
  /** 失败时的错误信息（可直接展示给用户） */
  error?: string
  /** 操作后的当前分支 */
  branch?: string | null
}

/** 检出分支输入 */
export interface CheckoutGitBranchInput {
  dirPath: string
  /** 目标分支名 */
  branch: string
  /** 若分支不存在则创建并检出 */
  create?: boolean
  /** 当前 Agent 会话 ID，用于主进程校验可访问路径 */
  sessionId?: string
}

/** 提交输入 */
export interface GitCommitInput {
  dirPath: string
  /** 提交信息 */
  message: string
  /** 是否先把未暂存/未追踪改动全部 stage（默认 true） */
  includeUnstaged?: boolean
  /** 当前 Agent 会话 ID */
  sessionId?: string
}

/** 推送输入 */
export interface GitPushInput {
  dirPath: string
  /** 远程名；省略时优先 upstream，否则 origin / 唯一远程 */
  remote?: string
  /** 推送的本地分支；省略时为当前分支 */
  branch?: string
  /** 设置 upstream（-u） */
  setUpstream?: boolean
  /** 当前 Agent 会话 ID */
  sessionId?: string
}

/** 提交并可选推送的输入 */
export interface GitCommitAndPushInput {
  dirPath: string
  message: string
  includeUnstaged?: boolean
  /** 是否在提交成功后推送 */
  push?: boolean
  remote?: string
  setUpstream?: boolean
  sessionId?: string
}

/** 生成提交信息输入 */
export interface GenerateGitCommitMessageInput {
  dirPath: string
  channelId: string
  modelId: string
  /** 是否包含未暂存改动的上下文（与提交选项一致） */
  includeUnstaged?: boolean
  sessionId?: string
}

/** 生成提交信息结果 */
export interface GenerateGitCommitMessageResult {
  ok: boolean
  message?: string
  error?: string
}


/** 获取文件 Diff 的输入 */
export interface GetFileDiffInput {
  dirPath: string
  filePath: string
  /** 文件所属 Git 仓库根，多仓库场景下必须传入 */
  gitRoot?: string
  /** 当前 Agent 会话 ID，用于主进程校验可访问路径 */
  sessionId?: string
  /** 基准 ref（如 "origin/main"），用于 worktree vs main 模式 */
  baseRef?: string
}

/** 独立预览窗口输入 */
export interface DetachedPreviewWindowInput {
  /** 当前 Agent 会话 ID，用于主进程校验可访问路径 */
  sessionId: string
  /** 要预览的文件路径 */
  filePath: string
  /** Diff 模式下的工作目录；纯预览模式下作为路径解析候选 */
  dirPath: string
  /** 文件所属 Git 仓库根，多仓库场景下必须传入 */
  gitRoot?: string
  /** true = 纯文件预览，false/undefined = diff 模式 */
  previewOnly?: boolean
  /** true = 预览只读，不允许从预览面板写回临时/源文件 */
  readOnly?: boolean
  /** 候选基础目录（previewOnly 模式下用于路径解析） */
  basePaths?: string[]
  /** 窗口标题 */
  title?: string
}

/** 独立预览窗口数据 */
export interface DetachedPreviewWindowData extends DetachedPreviewWindowInput {
  id: string
}

/** Revert 文件变更的输入 */
export interface RevertFileInput {
  dirPath: string
  filePath: string
  /** 文件所属 Git 仓库根，多仓库场景下必须传入 */
  gitRoot?: string
  /** 当前 Agent 会话 ID，用于主进程校验可访问路径 */
  sessionId?: string
}

/** 文件预览/附加目录 IPC 的访问上下文 */
export interface FileAccessOptions {
  /** 当前 Agent 会话 ID，主进程据此查会话和工作区授权目录 */
  sessionId?: string
  /** 工作区 slug；通常可由 sessionId 推导，少数无 session 调用可显式传入 */
  workspaceSlug?: string
  /** 路径解析候选目录；主进程会先过滤到已授权目录内再使用 */
  candidateBasePaths?: string[]
}

/** 已授权本地文件的 proma-file URL */
export interface ResolvedFileUrl {
  url: string
}

/** Office 文件内联预览类型 */
export type OfficePreviewKind = 'spreadsheet' | 'presentation'

/** Office 文件内联预览结果 */
export interface OfficePreviewResult {
  resolvedPath: string
  kind: OfficePreviewKind
  html: string
  text: string
}

/**
 * Git Bash 运行时状态（Windows 平台）
 */
export interface GitBashStatus {
  /** 是否可用 */
  available: boolean
  /** bash.exe 可执行路径 */
  path: string | null
  /** Bash 版本号 */
  version: string | null
  /** 错误信息（如果不可用）*/
  error: string | null
}

/** 系统编辑器应用信息 */
export interface EditorApp {
  /** 显示名称，如 "Visual Studio Code" */
  name: string
  /** .app 路径，如 "/Applications/Visual Studio Code.app" */
  path: string
}

/** 某个文件路径在本机系统中的默认打开应用信息 */
export interface DefaultAppInfo {
  /** 显示名称，如 "Visual Studio Code"、"Typora"、"Preview" */
  name: string
  /** 应用绝对路径（macOS 为 .app bundle，Windows 为 .exe），用于点击打开/调试 */
  appPath: string
  /** App 图标的 PNG dataURL；通过 Electron app.getFileIcon 抓取 */
  iconDataUrl: string
}

/** Windows Agent Shell 偏好：默认自动选择 Git Bash，用户可显式改用 WSL。 */
export type WindowsShellPreference = 'auto' | 'git-bash' | 'wsl'

/**
 * WSL 运行时状态（Windows 平台）
 */
export interface WslStatus {
  /** 是否可用 */
  available: boolean
  /** WSL 版本（1 或 2）*/
  version: 1 | 2 | null
  /** 默认 WSL 发行版 */
  defaultDistro: string | null
  /** 已安装的发行版列表 */
  distros: string[]
  /** 错误信息（如果不可用）*/
  error: string | null
}

/**
 * Shell 环境状态（Windows 平台特有）
 */
export interface ShellEnvironmentStatus {
  /** Git Bash 状态 */
  gitBash: GitBashStatus
  /** WSL 状态 */
  wsl: WslStatus
  /** 推荐使用的 Shell 环境 */
  recommended: 'git-bash' | 'wsl' | null
}

/**
 * 完整运行时状态
 */
export interface RuntimeStatus {
  /** Node.js 运行时状态 */
  node: NodeRuntimeStatus
  /** Bun 运行时状态 */
  bun: BunRuntimeStatus
  /** Git 运行时状态 */
  git: GitRuntimeStatus
  /** Shell 环境状态（仅 Windows 平台）*/
  shell?: ShellEnvironmentStatus
  /** Shell 环境变量是否已加载（仅 macOS 相关）*/
  envLoaded: boolean
  /** 初始化时间戳 */
  initializedAt: number
}

/**
 * 运行时初始化选项
 */
export interface RuntimeInitOptions {
  /** 是否跳过 Shell 环境加载（用于测试或特殊场景）*/
  skipEnvLoad?: boolean
  /** 是否跳过 Node.js 检测 */
  skipNodeDetection?: boolean
  /** 是否跳过 Bun 检测 */
  skipBunDetection?: boolean
  /** 是否跳过 Git 检测 */
  skipGitDetection?: boolean
  /** 是否跳过 Shell 环境检测（仅 Windows）*/
  skipShellDetection?: boolean
}

/**
 * Shell 环境加载结果
 */
export interface ShellEnvResult {
  /** 是否成功加载 */
  success: boolean
  /** 加载的环境变量数量 */
  loadedCount: number
  /** 错误信息（如果失败）*/
  error: string | null
}

// ===== 集成终端 =====

export type IntegratedTerminalShellKind =
  | 'zsh'
  | 'bash'
  | 'fish'
  | 'powershell'
  | 'cmd'
  | 'wsl'
  | 'unknown'

export interface IntegratedTerminalCreateInput {
  conversationId: string
  conversationTitle?: string
  cwd?: string
  cols?: number
  rows?: number
}

export interface IntegratedTerminalSessionSnapshot {
  id: string
  conversationId: string
  cwd: string
  shellName: string
  shellKind: IntegratedTerminalShellKind
  cols: number
  rows: number
  output: string
  outputSequence: number
  truncated: boolean
  alternateScreen: boolean
}

export type IntegratedTerminalEvent =
  | {
      type: 'data'
      sessionId: string
      data: string
      sequence: number
    }
  | {
      type: 'attached'
      sessionId: string
      cwd: string
      shellName: string
      shellKind: IntegratedTerminalShellKind
    }
  | {
      type: 'exit'
      sessionId: string
      exitCode: number
      signal?: number
    }
  | {
      type: 'error'
      sessionId: string
      message: string
    }

/**
 * IPC 通道名称常量
 */
export const IPC_CHANNELS = {
  /** 获取运行时状态 */
  GET_RUNTIME_STATUS: 'runtime:get-status',
  /** 重新初始化运行时（用户安装完 Git/Node 后触发） */
  REINIT_RUNTIME: 'runtime:reinit',
  /** 获取指定目录的 Git 仓库状态 */
  GET_GIT_REPO_STATUS: 'git:get-repo-status',
  /** 获取未暂存的变更文件列表 */
  GET_UNSTAGED_CHANGES: 'git:get-unstaged-changes',
  /** 获取单个文件的 diff */
  GET_FILE_DIFF: 'git:get-file-diff',
  /** 获取未追踪文件内容 */
  GET_UNTRACKED_CONTENT: 'git:get-untracked-content',
  /** 还原文件变更 */
  REVERT_FILE: 'git:revert-file',
  GET_DIFF_CONTENTS: 'git:get-diff-contents',
  /** 列出 Git Worktree */
  LIST_WORKTREES: 'git:list-worktrees',
  /** 获取 Worktree 相对于基准分支的全量变更 */
  GET_WORKTREE_CHANGES: 'git:get-worktree-changes',
  /** 列出本地分支 */
  LIST_GIT_BRANCHES: 'git:list-branches',
  /** 列出远程 */
  LIST_GIT_REMOTES: 'git:list-remotes',
  /** 检出 / 创建并检出分支 */
  CHECKOUT_GIT_BRANCH: 'git:checkout-branch',
  /** 提交 */
  GIT_COMMIT: 'git:commit',
  /** 推送 */
  GIT_PUSH: 'git:push',
  /** 提交并可选推送 */
  GIT_COMMIT_AND_PUSH: 'git:commit-and-push',
  /** 根据变更生成提交信息 */
  GENERATE_GIT_COMMIT_MESSAGE: 'git:generate-commit-message',

  /** 在系统默认浏览器中打开外部链接 */
  OPEN_EXTERNAL: 'shell:open-external',
  /** 用系统默认应用打开任意文件 */
  SYSTEM_OPEN_FILE: 'shell:system-open-file',
  /** 在系统文件管理器（访达/资源管理器）中显示文件 */
  SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
  /** 扫描系统中可用的编辑器应用 */
  SCAN_EDITORS: 'shell:scan-editors',
  /** 查询某个文件在本机系统中的默认打开应用信息（带图标） */
  GET_DEFAULT_APP_FOR_FILE: 'shell:get-default-app-for-file',
  /** 查询某个文件在本机可用来打开的应用列表（带图标） */
  GET_APPS_FOR_FILE: 'shell:get-apps-for-file',
  /** 打开独立预览窗口 */
  OPEN_DETACHED_PREVIEW: 'preview:open-detached',
  /** 获取独立预览窗口数据 */
  GET_DETACHED_PREVIEW_DATA: 'preview:get-detached-data',
  /** 最小化窗口 */
  WINDOW_MINIMIZE: 'window:minimize',
  /** 最大化/还原窗口 */
  WINDOW_MAXIMIZE: 'window:maximize',
  /** 关闭窗口 */
  WINDOW_CLOSE: 'window:close',
  /** 窗口是否最大化 */
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  /** 截图导出：将 HTML 渲染为 PNG 图片 */
  SCREENSHOT_CAPTURE: 'screenshot:capture',
  /** 创建集成终端会话 */
  TERMINAL_CREATE: 'terminal:create',
  /** 重新挂载并读取集成终端末尾缓存 */
  TERMINAL_ATTACH: 'terminal:attach',
  /** 向集成终端写入键盘数据 */
  TERMINAL_WRITE: 'terminal:write',
  /** 调整集成终端 PTY 尺寸 */
  TERMINAL_RESIZE: 'terminal:resize',
  /** 关闭集成终端会话 */
  TERMINAL_CLOSE: 'terminal:close',
  /** 集成终端增量事件 */
  TERMINAL_EVENT: 'terminal:event',
} as const

/**
 * IPC 通道名称类型
 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/**
 * 截图导出的统一配额。
 *
 * 渲染端做廉价预检（元素数 / 原始 HTML 字节数），失败立即向用户反馈，避免昂贵的
 * inlineComputedStyles + IPC 传输后才被主进程拒绝。主进程兜底拦截（含 inline 样式
 * 后的 HTML 字节数、最终像素预算），构成纵深防御。
 */
export const SCREENSHOT_LIMITS = {
  /** 渲染端预检：编辑器 DOM 元素数上限。超过会导致 inlineComputedStyles 卡顿明显 */
  MAX_ELEMENTS: 3000,
  /** 渲染端预检：原始 outerHTML 字节数上限（不含 inline 样式）。膨胀系数 5-10× 对应主进程 12MB */
  MAX_RAW_HTML_BYTES: 2 * 1024 * 1024,
  /** 主进程兜底：含 inline 样式的 HTML 字节数上限 */
  MAX_HTML_BYTES: 12 * 1024 * 1024,
  /** 主进程兜底：渲染像素预算（width × height × scale²）。4 字节/像素 ≈ 400MB */
  MAX_PIXELS: 100_000_000,
  /** 输出图片宽度下限 */
  MIN_WIDTH: 480,
  /** 输出图片宽度上限。渲染端与主进程统一 */
  MAX_WIDTH: 1600,
} as const
