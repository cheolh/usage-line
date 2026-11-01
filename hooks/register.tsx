import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Usage } from '../types'

const usage = atom({ plugin: 'usage-line', key: 'usage' } as const, null)

async function measure($: Engine): Promise<Usage> {
  const { context, rateLimits, cost } = await $.session.usage()

  return {
    percent: context.percent ?? null,
    usd: cost?.usd ?? null,
    limits: rateLimits.map(l => ({
      kind: l.kind,
      percentUsed: l.percentUsed,
      resetsAt: l.resetsAt ?? null,
    })),
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
    for (const l of u.limits) meters.push([nameOf(l.kind), l.percentUsed, resetText(l.resetsAt)])

    // Colors live in the SVG's own stylesheet: dark values by default, every color inverted when the viewer prefers light.
    const color = (p: number) => (p >= 85 ? 'hi' : p >= 60 ? 'mid' : 'lo')
    const style =
      '<style>.lbl{fill:#d3d3d3}.pct{fill:#ffffff}.trk{fill:#000000}.lo{fill:#ff1493}.mid{fill:#8a6508}.hi{fill:#e5484d}' +
      '@media (prefers-color-scheme:light){.lbl{fill:#2c2c2c}.pct{fill:#000000}.trk{fill:#ffffff}.lo{fill:#ffb6c1}.mid{fill:#0a5adb}.hi{fill:#1ab7b2}}</style>'
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
    // Vertical center of the bars, and the text baseline (tuned by eye, in px from the top).
    const mid = 11
    const base = 14.3
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
      const shown = p === null ? '' : `${Math.round(p)}<tspan font-size="13">%</tspan>`

      body +=
        engraved(x, base, text, 1, font, label) +
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
