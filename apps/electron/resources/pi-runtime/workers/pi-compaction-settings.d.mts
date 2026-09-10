interface PiCompactionInput {
  enabled?: boolean
  threshold?: number
}

export function resolvePiCompactionPolicy(
  contextWindow: number,
  compaction?: PiCompactionInput,
): { enabled: boolean; contextWindow: number; threshold: number }

export function piCompactionSettings(
  contextWindow: number,
  compaction?: PiCompactionInput,
): { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
