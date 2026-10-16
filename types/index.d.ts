export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  limits: Limit[]
  costUsd?: number
}

export type Tokens = {
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type ModelTokens = Tokens & { model: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-tracker': {
      snapshot: Snapshot | null
      session: Tokens
      models: ModelTokens[]
      alerted: Record<string, number>
      isBandHidden: boolean
    }
  }
}
