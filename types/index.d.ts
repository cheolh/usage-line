export type Usage = {
  percent: number | null
  usd: number | null
  limits: { kind: string; percentUsed: number; resetsAt: string | null }[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-line': { usage: Usage | null }
  }
}
