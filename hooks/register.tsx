import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { FableState, Usage } from '../types'

const usage = atom({ plugin: 'usage-line', key: 'usage' } as const, null)
const fableState = atom({ plugin: 'usage-line', key: 'fable' } as const, null)

type Limit = Usage['limits'][number]

// $.session.usage() carries only the 5-hour, weekly and spend windows; the per-model weekly
// windows (Fable) come from the usage endpoint, read with the session's own credential.
// The endpoint is rate limited (the app reads it too), so it is asked at most every five
// minutes, later when a 429 says so. The last good reading and the time of the next allowed
// read live in the plugin's state, so a plugin reload neither loses one nor re-asks early.
const FABLE_EVERY_MS = 5 * 60_000

async function readFable($: Engine): Promise<FableState> {
  const now = Date.now()
  const s: FableState = (await read($, fableState)) ?? { limit: null, known: false, nextAt: 0 }
  if (now < s.nextAt) return s

  let next: FableState = { ...s, nextAt: now + FABLE_EVERY_MS }
  // Claim the read before it goes out, so a hook firing meanwhile does not send a second one.
  await update($, fableState, () => next)
  try {
    const auth = await $.session.authorize()
    if (auth !== null) {
      const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage?skip_spend=1', {
        auth: auth.handle,
        headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
      })
      if (res.status === 429) {
        const wait = Number(res.headers['retry-after']) * 1000
        if (wait > FABLE_EVERY_MS) next.nextAt = now + wait
      } else if (res.ok) {
        const body = JSON.parse(res.text) as {
          limits?: {
            kind?: string
            percent?: number
            resets_at?: string | null
            scope?: { model?: { display_name?: string } | null } | null
          }[]
        }
        // The same match the engine uses for its "Weekly · Fable" row.
        const row = (body.limits ?? []).find(
          l => l.kind === 'weekly_scoped' && /^fable\b/i.test(String(l.scope?.model?.display_name ?? '')),
        )
        next = {
          ...next,
          known: true,
          limit:
            row && typeof row.percent === 'number'
              ? { kind: 'fable', percentUsed: row.percent, resetsAt: row.resets_at ?? null }
              : null,
        }
      }
    }
  } catch {}

  await update($, fableState, () => next)
  return next
}

async function measure($: Engine): Promise<Usage> {
  const [{ context, rateLimits, cost }, fable] = await Promise.all([$.session.usage(), readFable($)])

  const limits: Limit[] = rateLimits.map(l => ({
    kind: l.kind,
    percentUsed: l.percentUsed,
    resetsAt: l.resetsAt ?? null,
  }))
  // A reading whose window has already reset says nothing about the new one.
  const stale = fable.limit?.resetsAt != null && Date.parse(fable.limit.resetsAt) <= Date.now()
  if (fable.limit !== null && !stale) limits.push(fable.limit)
  // Not read yet (or stale): keep the bar in place, with no number, rather than dropping it.
  else if (!fable.known || stale) limits.push({ kind: 'fable', percentUsed: null, resetsAt: null })

  return {
    percent: context.percent ?? null,
    usd: cost?.usd ?? null,
    limits,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await measure($)
    await update($, usage, () => now)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await measure($)
    await update($, usage, () => now)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const now = await measure($)
    await update($, usage, () => now)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Graphic band: the desktop draws it; the terminal keeps its own prompt.
    if (e.surface !== 'desktop') {
      return next(e)
    }

    const u = await read($, usage)
    const { Box, Svg } = $.ui.resolve(e)

    if (u === null) {
      return next(e)
    }

    const names: Record<string, string> = {
      five_hour: '5H',
      seven_day: '1W',
      fable: 'Fable',
      spend_limit: 'Spend',
    }
    const nameOf = (kind: string) => names[kind] ?? kind.replace(/_/g, ' ')
    const now = await $.clock.now()
    // Time left until a window resets, plus the date once it is a day or more away: "2h 14m", "3d 4h · 10/14".
    const resetText = (resetsAt: string | null) => {
      if (resetsAt === null) return ''
      const at = Date.parse(resetsAt)
      if (Number.isNaN(at)) return ''
      const mins = Math.max(0, Math.round((at - now) / 60000))
      const d = Math.floor(mins / 1440)
      const h = Math.floor((mins % 1440) / 60)
      const m = mins % 60
      if (d > 0) {
        const date = new Date(at)
        return `${d}d ${h}h · ${date.getMonth() + 1}/${date.getDate()}`
      }
      return h > 0 ? `${h}h ${m}m` : `${m}m`
    }
    const meters: [string, number | null, string][] = []

    if (u.percent !== null) meters.push(['Context', u.percent, ''])
    // Fable resets with the weekly window, so its time left would only repeat 1W's.
    for (const l of u.limits) meters.push([nameOf(l.kind), l.percentUsed, l.kind === 'fable' ? '' : resetText(l.resetsAt)])

    // Colors live in the SVG's own stylesheet: dark values by default, every color inverted when the viewer prefers light.
    const color = (p: number) => (p >= 85 ? 'hi' : p >= 60 ? 'mid' : 'lo')
    const style =
      '<style>.lbl{fill:#d3d3d3}.pct{fill:#ffffff}.trk{fill:#000000}.lo{fill:#ff1493}.mid{fill:#8a6508}.hi{fill:#e5484d}' +
      '.l-ctx{fill:#7cc4ff}.l-5h{fill:#7ee0a1}.l-1w{fill:#ffc069}.l-fable{fill:#c9a2ff}.l-5h,.l-1w{font-weight:bold}' +
      '@media (prefers-color-scheme:light){.lbl{fill:#2c2c2c}.pct{fill:#000000}.trk{fill:#ffffff}.lo{fill:#ffb6c1}.mid{fill:#b8d4fa}.hi{fill:#1ab7b2}' +
      '.l-ctx{fill:#1f6fb5}.l-5h{fill:#1e8a4c}.l-1w{fill:#a86400}.l-fable{fill:#7a3fc2}}</style>'
    // Each meter's label has its own color: blue, green, amber, purple; any other label stays plain.
    const labelClass: Record<string, string> = { Context: 'l-ctx', '5H': 'l-5h', '1W': 'l-1w', Fable: 'l-fable' }
    const text = 'lbl'
    const numberColor = 'lbl'


    const font =
      'font-size="12" font-weight="normal" font-family="Iosevka Term Curly,Inter,-apple-system,system-ui,sans-serif"'
    // The numbers (percent and time left) are drawn 50% larger than the labels.
    const numFont =
      'font-size="18" font-weight="normal" font-family="Iosevka Term Curly,Inter,-apple-system,system-ui,sans-serif"'
    // Iosevka Term Curly only draws if it is installed on this machine; Inter and then the system font follow.
    const centerFont =
      'font-size="18" font-weight="normal" font-family="Iosevka Term Curly,Inter,-apple-system,system-ui,sans-serif" text-anchor="middle"'
    const charW = 6
    const space = 8
    const barW = 80
    const H = 20
    // Vertical center of the bars, and the text baseline (in px from the top): at 15.3 the
    // labels' ink centers on the bar's center, as the percent inside the bar does.
    const mid = 11
    const base = 15.3
    // Engraved look: a white copy of each text sits 1px below it, like light catching a recessed edge.
    const engraved = (x: number, y: number, fill: string, opacity: number, f: string, content: string) =>
      `<text x="${x}" y="${y}" class="${fill}" fill-opacity="${opacity}" ${f}>${content}</text>`
    const numBase = 16.3
    const resetGap = 8
    const gap = 16
    let x = 8
    let body = ''

    meters.forEach(([label, p, reset], i) => {
      const barX = x + label.length * charW + space
      const fill = p === null ? 0 : Math.max(0, Math.min(barW, (p / 100) * barW))
      // The % sign is drawn smaller than the number.
      const shown = p === null ? '–' : `${Math.round(p)}<tspan font-size="13">%</tspan>`

      body +=
        engraved(x, base, labelClass[label] ?? text, 1, font, label) +
        `<rect x="${barX}" y="${mid - 8}" width="${barW}" height="16" rx="4" class="trk"/>` +
        // The fill is square-cut on its right edge and clipped to the track's rounded outline on the left.
        `<clipPath id="track${i}"><rect x="${barX}" y="${mid - 8}" width="${barW}" height="16" rx="4"/></clipPath>` +
        `<rect x="${barX}" y="${mid - 8}" width="${fill}" height="16" class="${color(p ?? 0)}" clip-path="url(#track${i})"/>` +
        // Percent inside the bar; the clip split keeps each half in step with the fill edge.
        `<clipPath id="onFill${i}"><rect x="${barX}" y="0" width="${fill}" height="${H}"/></clipPath>` +
        `<clipPath id="onTrack${i}"><rect x="${barX + fill}" y="0" width="${barW - fill}" height="${H}"/></clipPath>` +
        `<text x="${barX + barW / 2}" y="${mid + 6.3}" class="pct" clip-path="url(#onFill${i})" ${centerFont}>${shown}</text>` +
        `<text x="${barX + barW / 2}" y="${mid + 6.3}" class="pct" clip-path="url(#onTrack${i})" ${centerFont}>${shown}</text>` +
        (reset
          ? engraved(barX + barW + resetGap, base, numberColor, 1, font, reset)
          : '')
      x =
        barX + barW + (reset ? resetGap + reset.length * 6.2 : 0) + gap
    })

    const width = Math.ceil(x - gap + 8)
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${style}${body}</svg>`
    const alt = `usage: ${meters.map(([l, p, r]) => `${l} ${p === null ? 'n/a' : `${Math.round(p)}%`}${r ? ` (resets in ${r})` : ''}`).join(', ')}`

    return (
      <Box padding={0} margin={0}>
        <Svg source={source} alt={alt} width={width} height={H} />
      </Box>
    )
  })
}
