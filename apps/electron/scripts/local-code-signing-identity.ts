import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getConfigDirectoryName } from '@proma/shared/config'

const IDENTITY_NAME = 'Proma Local Development'
const SIGNING_DIRECTORY = join(
  homedir(),
  getConfigDirectoryName(true),
  'local-signing',
)
const KEYCHAIN_PATH = join(
  SIGNING_DIRECTORY,
  'PromaLocalSigning.keychain-db',
)
const KEYCHAIN_PASSWORD_PATH = join(SIGNING_DIRECTORY, 'keychain-password')
const LOGIN_KEYCHAIN_PATH = join(
  homedir(),
  'Library',
  'Keychains',
  'login.keychain-db',
)

export interface LocalCodeSigningIdentity {
  name: string
  fingerprint: string
  keychainPath: string
}

interface CommandResult {
  status: number
  output: string
}

function run(command: string, args: string[], allowFailure = false): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} 执行失败:\n${output}`)
  }
  return {
    status: result.status ?? 1,
    output,
  }
}

export function parseCodeSigningIdentity(
  output: string,
): Pick<LocalCodeSigningIdentity, 'name' | 'fingerprint'> | undefined {
  for (const line of output.split('\n')) {
    const match = line.match(
      /^\s*\d+\)\s+([A-F0-9]{40})\s+"([^"]+)"(?:\s|$)/i,
    )
    if (!match) continue
    return {
      fingerprint: match[1]!.toUpperCase(),
      name: match[2]!,
    }
  }
  return undefined
}

function parseCertificateSha256(output: string): string | undefined {
  return output.match(/SHA-256 hash:\s*([A-F0-9]{64})/i)?.[1]?.toUpperCase()
}

function readOrCreateKeychainPassword(): string {
  mkdirSync(SIGNING_DIRECTORY, { recursive: true, mode: 0o700 })
  if (existsSync(KEYCHAIN_PASSWORD_PATH)) {
    return readFileSync(KEYCHAIN_PASSWORD_PATH, 'utf8').trim()
  }
  const password = randomBytes(32).toString('hex')
  writeFileSync(KEYCHAIN_PASSWORD_PATH, password, {
    encoding: 'utf8',
    mode: 0o600,
  })
  chmodSync(KEYCHAIN_PASSWORD_PATH, 0o600)
  return password
}

function findIdentity(): Pick<LocalCodeSigningIdentity, 'name' | 'fingerprint'> | undefined {
  if (!existsSync(KEYCHAIN_PATH)) return undefined
  const validIdentities = run(
    '/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning', KEYCHAIN_PATH],
    true,
  )
  return parseCodeSigningIdentity(validIdentities.output)
}

function findCertificateFingerprint(): string | undefined {
  if (!existsSync(KEYCHAIN_PATH)) return undefined
  const certificate = run(
    '/usr/bin/security',
    ['find-certificate', '-Z', '-c', IDENTITY_NAME, KEYCHAIN_PATH],
    true,
  )
  return parseCertificateSha256(certificate.output)
}

function createIdentity(keychainPassword: string): void {
  const temporaryDirectory = join(
    SIGNING_DIRECTORY,
    `setup-${Date.now()}`,
  )
  mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 })
  const opensslConfigPath = join(temporaryDirectory, 'openssl.cnf')
  const privateKeyPath = join(temporaryDirectory, 'private-key.pem')
  const certificatePath = join(temporaryDirectory, 'certificate.pem')
  const pkcs12Path = join(temporaryDirectory, 'identity.p12')
  const pkcs12Password = randomBytes(32).toString('hex')

  try {
    writeFileSync(
      opensslConfigPath,
      [
        '[req]',
        'distinguished_name = distinguished_name',
        'x509_extensions = extensions',
        'prompt = no',
        '',
        '[distinguished_name]',
        `CN = ${IDENTITY_NAME}`,
        'O = Proma',
        'OU = Local Development',
        '',
        '[extensions]',
        'basicConstraints = critical, CA:false',
        'keyUsage = critical, digitalSignature',
        'extendedKeyUsage = critical, codeSigning',
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid,issuer',
        '',
      ].join('\n'),
      'utf8',
    )

    run('/usr/bin/openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '3650',
      '-config',
      opensslConfigPath,
      '-keyout',
      privateKeyPath,
      '-out',
      certificatePath,
    ])
    run('/usr/bin/openssl', [
      'pkcs12',
      '-export',
      '-name',
      IDENTITY_NAME,
      '-inkey',
      privateKeyPath,
      '-in',
      certificatePath,
      '-out',
      pkcs12Path,
      '-passout',
      `pass:${pkcs12Password}`,
    ])
    run('/usr/bin/security', [
      'import',
      pkcs12Path,
      '-k',
      KEYCHAIN_PATH,
      '-P',
      pkcs12Password,
      '-T',
      '/usr/bin/codesign',
      '-T',
      '/usr/bin/security',
    ])
    run('/usr/bin/security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      keychainPassword,
      KEYCHAIN_PATH,
    ])
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function trustCertificate(): void {
  const temporaryCertificatePath = join(
    SIGNING_DIRECTORY,
    `certificate-${Date.now()}.pem`,
  )
  try {
    const certificate = run('/usr/bin/security', [
      'find-certificate',
      '-c',
      IDENTITY_NAME,
      '-p',
      KEYCHAIN_PATH,
    ])
    writeFileSync(temporaryCertificatePath, certificate.output, {
      encoding: 'utf8',
      mode: 0o600,
    })
    run('/usr/bin/security', [
      'add-trusted-cert',
      '-r',
      'trustRoot',
      '-p',
      'codeSign',
      '-k',
      LOGIN_KEYCHAIN_PATH,
      temporaryCertificatePath,
    ])
  } finally {
    rmSync(temporaryCertificatePath, { force: true })
  }
}

function prepareKeychain(): string {
  const keychainPassword = readOrCreateKeychainPassword()
  if (!existsSync(KEYCHAIN_PATH)) {
    run('/usr/bin/security', [
      'create-keychain',
      '-p',
      keychainPassword,
      KEYCHAIN_PATH,
    ])
  }
  run('/usr/bin/security', [
    'set-keychain-settings',
    '-lut',
    '315360000',
    KEYCHAIN_PATH,
  ])
  run('/usr/bin/security', [
    'unlock-keychain',
    '-p',
    keychainPassword,
    KEYCHAIN_PATH,
  ])
  return keychainPassword
}

export interface SetupLocalCodeSigningOptions {
  trust: boolean
}

/**
 * 首次创建固定身份，并在调用方明确同意时写入用户级 codeSign 信任。
 *
 * 信任自签名证书属于持久化安全设置，只允许由显式 setup 命令触发；普通打包
 * 和签名流程只复用已经就绪的身份，不会静默扩大证书信任。
 */
export function setupLocalCodeSigningIdentity(
  options: SetupLocalCodeSigningOptions,
): LocalCodeSigningIdentity {
  if (process.platform !== 'darwin') {
    throw new Error('固定本地签名身份仅支持 macOS')
  }
  const keychainPassword = prepareKeychain()
  if (!findCertificateFingerprint()) {
    createIdentity(keychainPassword)
  }
  if (!findIdentity() && options.trust) {
    trustCertificate()
  }
  return ensureLocalCodeSigningIdentity()
}

/**
 * 创建或复用 Proma 固定本地代码签名身份。
 *
 * 与每次变化的 ad-hoc 签名相比，固定证书能让 macOS Keychain 持续识别为同一
 * 应用，避免 safeStorage 凭据在每次安装测试包后重复要求授权或无法解密。
 */
export function ensureLocalCodeSigningIdentity(): LocalCodeSigningIdentity {
  if (process.platform !== 'darwin') {
    throw new Error('固定本地签名身份仅支持 macOS')
  }
  prepareKeychain()
  const identity = findIdentity()
  if (!identity) {
    throw new Error(
      `固定本地签名身份尚未受信任，请先运行 bun run setup:local-mac-signing`,
    )
  }
  return {
    ...identity,
    keychainPath: KEYCHAIN_PATH,
  }
}
