/**
 * Proma Runtime Registry 的 Electron 适配层。
 *
 * RuntimeId 联合类型暂时保留 Hermes/Codex/Claude 作为旧数据读取兼容，
 * 但注册、发现、安装、激活和执行入口只暴露 Pi。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  RuntimeActivation,
  RuntimeCapability,
  RuntimeCapabilitySnapshot,
  RuntimeConfig,
  RuntimeDefinition,
  RuntimeDiscoveryCandidate,
  RuntimeId,
  RuntimeInstallation,
  RuntimePackage,
  RuntimePackageStatus,
  RuntimeRelease,
} from '@proma/shared'
import { getRuntimeConfigPath, getRuntimeHomeDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { EXECUTABLE_RUNTIME_ID, isExecutableRuntimeId } from './pi-runtime-policy'

const ALL_CAPABILITIES: RuntimeCapability[] = [
  'streaming', 'tools', 'approvals', 'steering', 'cancellation', 'sessionResume',
  'customModels', 'managedCredentials', 'contextUsage', 'compaction', 'workTasks',
]

const PI_RUNTIME_NAME = {
  name: 'Pi',
  description: 'Proma 唯一执行内核',
  command: null,
} as const

export const ALL_RUNTIME_IDS: readonly RuntimeId[] = [EXECUTABLE_RUNTIME_ID]

interface RuntimePackageServiceResponse {
  activation?: {
    runtimeId?: string
    activeBuildId?: string
    previousBuildId?: string
    activationRevision?: string
  } | null
  activeBinding?: Record<string, unknown> | null
  packages?: Record<string, unknown>[]
  releases?: {
    verified?: Record<string, unknown>[]
    upstreamLatest?: { version?: string } | string | null
  }
  upstreamLatest?: { version?: string } | string | null
  checkedAt?: string
}

interface RuntimeServiceListResponse {
  runtimes?: Array<{
    id?: string
    runtimeId?: string
    installation?: {
      status?: string
      version?: string
      command?: string
      detail?: string
      checkedAt?: string
    }
    activeBinding?: Record<string, unknown> | null
  }>
}

interface LocalRuntimeManifest {
  runtimeVersion?: string
  runtimeBuildId?: string
  installationState?: string
  verificationState?: string
  installedAt?: string
  verifiedAt?: string
}

interface BundledPackageInfo {
  packageRoot: string
  version: string
}

interface RuntimeHomeEnvironment extends Readonly<Record<string, string | undefined>> {
  PROMA_RUNTIME_HOME?: string
  FRAKIO_WORK_RUNTIME_HOME?: string
}

/** 显式环境变量优先；新用户默认统一落到当前配置目录的 runtime 子目录。 */
export function resolveDefaultRuntimeHome(
  env: Readonly<RuntimeHomeEnvironment>,
  fallback: () => string = getRuntimeHomeDir,
): string {
  return env.PROMA_RUNTIME_HOME
    || env.FRAKIO_WORK_RUNTIME_HOME
    || fallback()
}

function defaultConfig(
  now = Date.now(),
  runtimeHome = resolveDefaultRuntimeHome(process.env),
): RuntimeConfig {
  return {
    runtimeHome,
    runtimeSourceHome: process.env.PROMA_RUNTIME_SOURCE_HOME
      || process.env.FRAKIO_WORK_SOURCE_HOME
      || null,
    runtimeApiBaseUrl: process.env.PROMA_RUNTIME_API_URL
      || process.env.FRAKIO_WORK_API_URL
      || null,
    defaultRuntimeId: EXECUTABLE_RUNTIME_ID,
    defaultHarnessId: EXECUTABLE_RUNTIME_ID,
    enabledRuntimeIds: [EXECUTABLE_RUNTIME_ID],
    routedHarnesses: [],
    updatedAt: now,
  }
}

/** 将旧多内核配置规范化为 Pi-only 配置。 */
export function migrateRuntimeConfig(
  stored: Partial<RuntimeConfig> | null | undefined,
  now = Date.now(),
): RuntimeConfig {
  const storedRuntimeHome = typeof stored?.runtimeHome === 'string'
    ? stored.runtimeHome
    : typeof stored?.frakioHome === 'string' ? stored.frakioHome : null
  const defaults = defaultConfig(
    now,
    storedRuntimeHome ?? resolveDefaultRuntimeHome(process.env),
  )
  return {
    ...defaults,
    runtimeSourceHome: typeof stored?.runtimeSourceHome === 'string'
      ? stored.runtimeSourceHome
      : typeof stored?.frakioSourceHome === 'string' ? stored.frakioSourceHome : defaults.runtimeSourceHome,
    runtimeHome: storedRuntimeHome ?? defaults.runtimeHome,
    runtimeApiBaseUrl: typeof stored?.runtimeApiBaseUrl === 'string'
      ? stored.runtimeApiBaseUrl
      : typeof stored?.frakioApiBaseUrl === 'string' ? stored.frakioApiBaseUrl : defaults.runtimeApiBaseUrl,
    updatedAt: typeof stored?.updatedAt === 'number' ? stored.updatedAt : defaults.updatedAt,
  }
}

function needsPiMigration(stored: Partial<RuntimeConfig>): boolean {
  return stored.defaultRuntimeId !== EXECUTABLE_RUNTIME_ID
    || stored.defaultHarnessId !== EXECUTABLE_RUNTIME_ID
    || stored.enabledRuntimeIds?.length !== 1
    || stored.enabledRuntimeIds[0] !== EXECUTABLE_RUNTIME_ID
    || (stored.routedHarnesses?.length ?? 0) > 0
    || stored.frakioHome !== undefined
    || stored.frakioSourceHome !== undefined
    || stored.frakioApiBaseUrl !== undefined
}

function platformArch(): string {
  return `${process.platform}-${process.arch}`
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** 扫描 Proma Runtime Home 中当前平台的 Pi 托管包。 */
export function scanManagedRuntimePackages(
  runtimeHome: string,
  runtimeId: RuntimeId,
  currentPlatformArch = platformArch(),
): RuntimePackage[] {
  if (!isExecutableRuntimeId(runtimeId)) return []
  const runtimeRoot = join(runtimeHome, 'packages', EXECUTABLE_RUNTIME_ID)
  if (!existsSync(runtimeRoot)) return []
  const packages: RuntimePackage[] = []
  for (const version of readdirSync(runtimeRoot)) {
    const versionRoot = join(runtimeRoot, version, currentPlatformArch)
    if (!existsSync(versionRoot) || !statSync(versionRoot).isDirectory()) continue
    const manifest = readJsonRecord(join(versionRoot, 'runtime-manifest.json')) as LocalRuntimeManifest | null
    const runtimeVersion = String(manifest?.runtimeVersion || version).trim()
    const packagePresent = existsSync(
      join(versionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'),
    )
    if (!runtimeVersion || !packagePresent) continue
    const installed = manifest?.installationState !== 'broken'
      && manifest?.verificationState !== 'failed'
    packages.push({
      runtimeId: EXECUTABLE_RUNTIME_ID,
      runtimeVersion,
      runtimeBuildId: String(
        manifest?.runtimeBuildId || `pi-managed-${runtimeVersion}-${currentPlatformArch}`,
      ),
      source: 'managed',
      installationState: installed ? 'installed' : 'broken',
      availability: installed ? 'ready' : 'broken',
      executablePath: null,
      runtimeDir: versionRoot,
      installedAt: typeof manifest?.installedAt === 'string' ? manifest.installedAt : null,
      verifiedAt: typeof manifest?.verifiedAt === 'string' ? manifest.verifiedAt : null,
      detail: installed
        ? `从 Proma Runtime Home 发现 Pi ${runtimeVersion}。`
        : `Proma Runtime Pi ${runtimeVersion} 校验失败。`,
    })
  }
  return packages.sort((left, right) => left.runtimeVersion.localeCompare(
    right.runtimeVersion,
    undefined,
    { numeric: true },
  ))
}

function runtimeServiceBaseUrl(): string | null {
  return getRuntimeConfig().runtimeApiBaseUrl?.replace(/\/+$/, '') || null
}

function runtimeServiceHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

async function runtimeServiceRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = runtimeServiceBaseUrl()
  if (!baseUrl) throw new Error('尚未配置 Proma Runtime 服务地址。')
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...runtimeServiceHeaders(), ...init?.headers },
  })
  if (!response.ok) {
    throw new Error(`Proma Runtime 服务请求失败：HTTP ${response.status}`)
  }
  return await response.json() as T
}

function mapRuntimePackage(value: Record<string, unknown>): RuntimePackage {
  const source = value.source === 'managed' || value.source === 'native' || value.source === 'system'
    ? value.source
    : 'bundled'
  const installationState = value.installationState === 'checking'
    || value.installationState === 'missing'
    || value.installationState === 'broken'
    ? value.installationState
    : 'installed'
  const availability = value.availability === 'unavailable' || value.availability === 'broken'
    ? value.availability
    : 'ready'
  return {
    runtimeId: EXECUTABLE_RUNTIME_ID,
    runtimeVersion: String(value.runtimeVersion || 'unknown'),
    runtimeBuildId: String(value.runtimeBuildId || `pi-${String(value.runtimeVersion || 'unknown')}`),
    source,
    installationState,
    availability,
    executablePath: typeof value.executablePath === 'string' ? value.executablePath : null,
    runtimeDir: typeof value.runtimeDir === 'string' ? value.runtimeDir : null,
    installedAt: typeof value.installedAt === 'string' ? value.installedAt : null,
    verifiedAt: typeof value.verifiedAt === 'string' ? value.verifiedAt : null,
    detail: typeof value.detail === 'string' ? value.detail : null,
  }
}

function upstreamVersion(value: RuntimePackageServiceResponse['upstreamLatest']): string | null {
  if (typeof value === 'string') return value
  return typeof value?.version === 'string' ? value.version : null
}

function mapRuntimeRelease(value: Record<string, unknown>): RuntimeRelease | null {
  const version = String(value.version || value.packageVersion || '').trim()
  if (!version) return null
  return {
    version,
    packageVersion: typeof value.packageVersion === 'string' ? value.packageVersion : undefined,
    integrity: typeof value.integrity === 'string' ? value.integrity : undefined,
    verifiedAt: typeof value.verifiedAt === 'string' ? value.verifiedAt : undefined,
    node: typeof value.node === 'string' ? value.node : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
  }
}

function mapRuntimePackageStatus(response: RuntimePackageServiceResponse): RuntimePackageStatus {
  const packages = (response.packages || []).map(mapRuntimePackage)
  const activeBinding = response.activeBinding ? mapRuntimePackage(response.activeBinding) : null
  const activationValue = response.activation
  const activation: RuntimeActivation | null = activationValue ? {
    runtimeId: EXECUTABLE_RUNTIME_ID,
    activeBuildId: typeof activationValue.activeBuildId === 'string' ? activationValue.activeBuildId : null,
    previousBuildId: typeof activationValue.previousBuildId === 'string' ? activationValue.previousBuildId : null,
    activationRevision: String(activationValue.activationRevision || ''),
  } : null
  return {
    runtimeId: EXECUTABLE_RUNTIME_ID,
    activation,
    activeBinding,
    packages,
    upstreamLatest: upstreamVersion(response.upstreamLatest ?? response.releases?.upstreamLatest),
    availableVersions: (response.releases?.verified || []).flatMap((item) => {
      const release = mapRuntimeRelease(item)
      return release ? [release] : []
    }),
    checkedAt: response.checkedAt || new Date().toISOString(),
    source: 'remote',
  }
}

export function isPackagedElectronApp(): boolean {
  const resourcesPath = process.resourcesPath
  if (!resourcesPath) return false
  return existsSync(join(resourcesPath, 'app.asar'))
    || existsSync(join(resourcesPath, 'app.asar.unpacked'))
}

function findBundledPackage(packageName: string): BundledPackageInfo | null {
  const roots: string[] = []
  if (process.resourcesPath) {
    roots.push(
      join(process.resourcesPath, 'app.asar.unpacked'),
      join(process.resourcesPath, 'app'),
      process.resourcesPath,
    )
  }
  if (!isPackagedElectronApp()) {
    let current = process.cwd()
    for (let depth = 0; depth < 6; depth += 1) {
      roots.push(current)
      const parent = join(current, '..')
      if (parent === current) break
      current = parent
    }
  }
  for (const root of roots) {
    const packageJsonPath = join(root, 'node_modules', ...packageName.split('/'), 'package.json')
    const packageJson = readJsonRecord(packageJsonPath)
    const version = typeof packageJson?.version === 'string' ? packageJson.version.trim() : ''
    if (version) {
      return {
        packageRoot: join(root, 'node_modules', ...packageName.split('/')),
        version,
      }
    }
  }
  return null
}

function bundledPiInstallation(): RuntimeInstallation | null {
  const sdk = findBundledPackage('@earendil-works/pi-coding-agent')
  if (!sdk) return null
  const runtimeDir = join(sdk.packageRoot, '..', '..', '..')
  return {
    runtimeId: EXECUTABLE_RUNTIME_ID,
    status: 'ready',
    version: sdk.version,
    executablePath: runtimeDir,
    source: 'bundled',
    detail: `Proma 已内置 Pi ${sdk.version}。`,
    checkedAt: Date.now(),
  }
}

function localRuntimePackages(config: RuntimeConfig): RuntimePackage[] {
  return config.runtimeHome
    ? scanManagedRuntimePackages(config.runtimeHome, EXECUTABLE_RUNTIME_ID)
    : []
}

function newestReadyPackage(packages: RuntimePackage[]): RuntimePackage | null {
  return packages
    .filter((item) => item.installationState === 'installed' && item.availability === 'ready')
    .at(-1) || null
}

function installationFor(config: RuntimeConfig): RuntimeInstallation {
  const bundled = bundledPiInstallation()
  if (bundled) return bundled
  if (!isPackagedElectronApp()) {
    const managed = newestReadyPackage(localRuntimePackages(config))
    if (managed) {
      return {
        runtimeId: EXECUTABLE_RUNTIME_ID,
        status: 'ready',
        version: managed.runtimeVersion,
        executablePath: managed.runtimeDir || managed.executablePath,
        source: 'managed',
        detail: managed.detail,
        checkedAt: Date.now(),
      }
    }
  }
  return {
    runtimeId: EXECUTABLE_RUNTIME_ID,
    status: 'missing',
    version: null,
    executablePath: null,
    source: null,
    detail: '未发现内置 Pi Runtime。安装 Proma 时会随应用分发，不依赖本机 PATH。',
    checkedAt: Date.now(),
  }
}

function definition(config: RuntimeConfig): RuntimeDefinition {
  return {
    id: EXECUTABLE_RUNTIME_ID,
    role: 'kernel',
    name: PI_RUNTIME_NAME.name,
    description: PI_RUNTIME_NAME.description,
    command: PI_RUNTIME_NAME.command,
    bundled: true,
    capabilities: [...ALL_CAPABILITIES],
    installation: installationFor(config),
  }
}

export function getRuntimeConfig(): RuntimeConfig {
  const path = getRuntimeConfigPath()
  const stored = readJsonFileSafe<Partial<RuntimeConfig>>(path)
  const migrated = migrateRuntimeConfig(stored)
  if (stored && needsPiMigration(stored)) {
    const persisted = { ...migrated, updatedAt: Date.now() }
    writeJsonFileAtomic(path, persisted)
    return persisted
  }
  return migrated
}

export function updateRuntimeConfig(updates: Partial<RuntimeConfig>): RuntimeConfig {
  const current = getRuntimeConfig()
  const next = migrateRuntimeConfig({
    ...current,
    ...updates,
    updatedAt: Date.now(),
  })
  writeJsonFileAtomic(getRuntimeConfigPath(), next)
  return next
}

export function listRuntimes(): RuntimeDefinition[] {
  return [definition(getRuntimeConfig())]
}

/** 刷新 Runtime Center；远程服务也只读取 Pi 状态。 */
export async function refreshRuntimes(): Promise<RuntimeDefinition[]> {
  const local = listRuntimes()
  if (!runtimeServiceBaseUrl()) return local
  const response = await runtimeServiceRequest<RuntimeServiceListResponse>('/api/runtimes')
  const item = (response.runtimes || []).find(
    (runtime) => String(runtime.id || runtime.runtimeId || '') === EXECUTABLE_RUNTIME_ID,
  )
  if (!item) return local
  const runtime = local[0]!
  if (runtime.installation.source === 'bundled' && runtime.installation.status === 'ready') return local
  const installation = item.installation || {}
  const binding = item.activeBinding || {}
  const status = installation.status === 'ready'
    || installation.status === 'broken'
    || installation.status === 'checking'
    ? installation.status
    : 'missing'
  const source = binding.source === 'managed' || binding.source === 'frakio'
    ? 'managed'
    : binding.source === 'native' || binding.source === 'system'
      ? 'system'
      : runtime.installation.source
  return [{
    ...runtime,
    installation: {
      ...runtime.installation,
      status,
      version: String(installation.version || binding.runtimeVersion || runtime.installation.version || '') || null,
      executablePath: String(installation.command || binding.executablePath || runtime.installation.executablePath || '') || null,
      source,
      detail: String(installation.detail || binding.detail || runtime.installation.detail || ''),
      checkedAt: installation.checkedAt ? Date.parse(installation.checkedAt) || Date.now() : Date.now(),
    },
  }]
}

export function getRuntimeCapabilities(runtimeId: RuntimeId): RuntimeCapabilitySnapshot {
  assertPiRuntime(runtimeId)
  const runtime = listRuntimes()[0]!
  return {
    runtimeId: EXECUTABLE_RUNTIME_ID,
    runtimeVersion: runtime.installation.version || '',
    source: runtime.installation.source || 'unknown',
    capabilities: Object.fromEntries(ALL_CAPABILITIES.map((capability) => [
      capability,
      runtime.installation.status === 'ready' ? 'supported' : 'unknown',
    ])) as RuntimeCapabilitySnapshot['capabilities'],
    checkedAt: Date.now(),
  }
}

function packageSource(source: RuntimeInstallation['source']): RuntimePackage['source'] {
  if (source === 'system') return 'native'
  if (source === 'managed') return 'managed'
  return 'bundled'
}

function packageFor(runtime: RuntimeDefinition): RuntimePackage {
  const installation = runtime.installation
  return {
    runtimeId: EXECUTABLE_RUNTIME_ID,
    runtimeVersion: installation.version || 'unknown',
    runtimeBuildId: `pi-${installation.source || 'bundled'}-${installation.version || 'unknown'}`,
    source: packageSource(installation.source),
    installationState: installation.status === 'ready'
      ? 'installed'
      : installation.status === 'broken' ? 'broken' : 'missing',
    availability: installation.status === 'ready'
      ? 'ready'
      : installation.status === 'broken' ? 'broken' : 'unavailable',
    executablePath: installation.executablePath,
    runtimeDir: installation.executablePath,
    installedAt: null,
    verifiedAt: installation.checkedAt ? new Date(installation.checkedAt).toISOString() : null,
    detail: installation.detail,
  }
}

export function detectRuntime(runtimeId: RuntimeId): RuntimeDefinition | null {
  return isExecutableRuntimeId(runtimeId) ? listRuntimes()[0]! : null
}

export async function discoverRuntime(runtimeId: RuntimeId): Promise<RuntimeDiscoveryCandidate[]> {
  if (!isExecutableRuntimeId(runtimeId)) return []
  if (runtimeServiceBaseUrl()) {
    const response = await runtimeServiceRequest<{ candidates?: Record<string, unknown>[] }>(
      '/api/runtimes/pi/discover',
      { method: 'POST', body: JSON.stringify({}) },
    )
    return (response.candidates || []).flatMap((item): RuntimeDiscoveryCandidate[] => {
      const executablePath = String(item.realPath || item.path || '').trim()
      if (!executablePath) return []
      return [{
        executablePath,
        version: typeof item.version === 'string' ? item.version : null,
        source: item.compatibility === 'compatible' ? 'system' : 'unknown',
        detail: typeof item.detail === 'string' ? item.detail : null,
      }]
    })
  }
  return localRuntimePackages(getRuntimeConfig())
    .map((item): RuntimeDiscoveryCandidate => ({
      executablePath: item.runtimeDir || item.executablePath || '',
      version: item.runtimeVersion,
      source: 'managed',
      detail: item.detail,
    }))
    .filter((item) => Boolean(item.executablePath))
}

export async function getRuntimePackageStatus(runtimeId: RuntimeId): Promise<RuntimePackageStatus> {
  assertPiRuntime(runtimeId)
  const runtime = listRuntimes()[0]!
  const bundled = runtime.installation.source === 'bundled' && runtime.installation.status === 'ready'
    ? packageFor(runtime)
    : null
  const managedPackages = localRuntimePackages(getRuntimeConfig())
  if (bundled) {
    const packages = [
      bundled,
      ...managedPackages.filter((item) => item.runtimeBuildId !== bundled.runtimeBuildId),
    ]
    return {
      runtimeId: EXECUTABLE_RUNTIME_ID,
      activation: {
        runtimeId: EXECUTABLE_RUNTIME_ID,
        activeBuildId: bundled.runtimeBuildId,
        previousBuildId: packages.filter((item) => item.runtimeBuildId !== bundled.runtimeBuildId).at(-1)?.runtimeBuildId || null,
        activationRevision: `local-${bundled.runtimeBuildId}`,
      },
      activeBinding: bundled,
      packages,
      upstreamLatest: null,
      checkedAt: new Date().toISOString(),
      source: 'local',
    }
  }
  if (runtimeServiceBaseUrl()) {
    const response = await runtimeServiceRequest<RuntimePackageServiceResponse>('/api/runtime-packages/pi')
    return mapRuntimePackageStatus(response)
  }
  const active = newestReadyPackage(managedPackages)
    || (runtime.installation.status === 'ready' ? packageFor(runtime) : null)
  return {
    runtimeId: EXECUTABLE_RUNTIME_ID,
    activation: active ? {
      runtimeId: EXECUTABLE_RUNTIME_ID,
      activeBuildId: active.runtimeBuildId,
      previousBuildId: managedPackages
        .filter((item) => item.runtimeBuildId !== active.runtimeBuildId)
        .at(-1)?.runtimeBuildId || null,
      activationRevision: `local-${active.runtimeBuildId}`,
    } : null,
    activeBinding: active,
    packages: managedPackages,
    upstreamLatest: null,
    checkedAt: new Date().toISOString(),
    source: 'local',
  }
}

export async function getActiveRuntimePackage(runtimeId: RuntimeId): Promise<RuntimePackage | null> {
  return (await getRuntimePackageStatus(runtimeId)).activeBinding
}

export async function installRuntimePackage(runtimeId: RuntimeId, version: string): Promise<RuntimePackageStatus> {
  assertPiRuntime(runtimeId)
  if (!runtimeServiceBaseUrl()) {
    throw new Error('当前 Runtime 未配置 Proma Runtime 版本安装服务。')
  }
  const response = await runtimeServiceRequest<RuntimePackageServiceResponse>('/api/runtime-packages/pi/install', {
    method: 'POST',
    body: JSON.stringify({ version }),
  })
  return mapRuntimePackageStatus(response)
}

export async function activateRuntimePackage(
  runtimeId: RuntimeId,
  runtimeBuildId: string,
): Promise<RuntimePackageStatus> {
  assertPiRuntime(runtimeId)
  if (runtimeServiceBaseUrl()) {
    const response = await runtimeServiceRequest<RuntimePackageServiceResponse>('/api/runtime-packages/pi/activate', {
      method: 'POST',
      body: JSON.stringify({ runtimeBuildId }),
    })
    return mapRuntimePackageStatus(response)
  }
  const status = await getRuntimePackageStatus(EXECUTABLE_RUNTIME_ID)
  if (!status.packages.some((pkg) => pkg.runtimeBuildId === runtimeBuildId)) {
    throw new Error('目标 Pi Runtime 版本尚未安装或不是当前平台版本。')
  }
  return status
}

export async function deleteRuntimePackage(runtimeId: RuntimeId, version: string): Promise<RuntimePackageStatus> {
  assertPiRuntime(runtimeId)
  if (runtimeServiceBaseUrl()) {
    const response = await runtimeServiceRequest<RuntimePackageServiceResponse>(
      `/api/runtime-packages/pi/versions/${encodeURIComponent(version)}`,
      { method: 'DELETE' },
    )
    return mapRuntimePackageStatus(response)
  }
  const status = await getRuntimePackageStatus(EXECUTABLE_RUNTIME_ID)
  if (status.packages.some(
    (pkg) => pkg.runtimeVersion === version && pkg.runtimeBuildId === status.activation?.activeBuildId,
  )) {
    throw new Error('当前激活版本不能删除。')
  }
  return status
}

export async function bindNativeRuntime(
  runtimeId: RuntimeId,
  executablePath: string,
): Promise<RuntimePackageStatus> {
  assertPiRuntime(runtimeId)
  if (!executablePath.trim()) throw new Error('系统 Runtime 路径不能为空。')
  if (runtimeServiceBaseUrl()) {
    const response = await runtimeServiceRequest<RuntimePackageServiceResponse>('/api/runtimes/pi/native-bindings', {
      method: 'POST',
      body: JSON.stringify({ executablePath }),
    })
    return mapRuntimePackageStatus(response)
  }
  return getRuntimePackageStatus(EXECUTABLE_RUNTIME_ID)
}

export async function unbindNativeRuntime(runtimeId: RuntimeId, buildId: string): Promise<RuntimePackageStatus> {
  assertPiRuntime(runtimeId)
  if (runtimeServiceBaseUrl()) {
    const response = await runtimeServiceRequest<RuntimePackageServiceResponse>(
      `/api/runtimes/pi/native-bindings/${encodeURIComponent(buildId)}`,
      { method: 'DELETE' },
    )
    return mapRuntimePackageStatus(response)
  }
  return getRuntimePackageStatus(EXECUTABLE_RUNTIME_ID)
}

function assertPiRuntime(runtimeId: RuntimeId): asserts runtimeId is typeof EXECUTABLE_RUNTIME_ID {
  if (!isExecutableRuntimeId(runtimeId)) {
    throw new Error(`Runtime「${runtimeId}」仅作为旧数据兼容标识保留，当前仅 Pi 可执行。`)
  }
}
