export type Usage = {
  percent: number | null
  usd: number | null
  limits: { kind: string; percentUsed: number | null; resetsAt: string | null }[]
}

export type FableState = {
  limit: Usage['limits'][number] | null
  // Whether a read has answered at all; until then the bar shows without a number.
  known: boolean
  nextAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-line': { usage: Usage | null; fable: FableState | null }
  }
}
