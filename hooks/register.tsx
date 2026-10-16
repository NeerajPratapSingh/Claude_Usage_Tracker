import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Limit, ModelTokens, Snapshot, Tokens } from '../types'

const PANE = 'usage-tracker'
const ALERT_AT = [75, 90, 100]

const EMPTY: Tokens = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

type Lifetime = Tokens & { costUsd: number; sessions: number; since: number }

const snapshot = atom({ plugin: 'usage-tracker', key: 'snapshot' } as const, null)
const session = atom({ plugin: 'usage-tracker', key: 'session' } as const, EMPTY)
const models = atom({ plugin: 'usage-tracker', key: 'models' } as const, [])
const alerted = atom({ plugin: 'usage-tracker', key: 'alerted' } as const, {})
const isBandHidden = atom({ plugin: 'usage-tracker', key: 'isBandHidden' } as const, false)

export const LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

export function label(kind: string): string {
  return LABELS[kind] ?? kind.replace(/_/g, ' ')
}

export function bar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function tone(percent: number): 'success' | 'warning' | 'error' {
  return percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'success'
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function money(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

export function resetsIn(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'resetting'
  const minutes = Math.round(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `resets in ${days}d ${hours}h`
  if (hours > 0) return `resets in ${hours}h ${mins}m`
  return `resets in ${mins}m`
}

export function statusText(snap: Snapshot): string {
  const parts = snap.limits.map(l => `${label(l.kind)} ${Math.round(l.percentUsed)}%`)
  if (snap.contextPercent !== undefined) parts.push(`ctx ${snap.contextPercent}%`)
  if (snap.costUsd !== undefined) parts.push(money(snap.costUsd))
  return parts.join(' · ')
}

function toSnapshot(context: SessionContextUsage, limits: SessionRateLimit[], costUsd?: number): Snapshot {
  return {
    contextTokens: context.tokens,
    contextWindow: context.window,
    contextPercent: context.percent,
    limits: limits.map(({ kind, percentUsed, resetsAt }): Limit => ({ kind, percentUsed, resetsAt })),
    costUsd,
  }
}

function add(a: Tokens, b: Omit<Tokens, 'turns'>): Tokens {
  return {
    turns: a.turns + 1,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

async function lifetime($: EngineInterface): Promise<Lifetime> {
  const stored = (await $.store.get('lifetime')) as Lifetime | undefined
  return stored ?? { ...EMPTY, costUsd: 0, sessions: 0, since: await $.clock.now() }
}

async function record($: EngineInterface, next: Snapshot) {
  const prev = await read($, snapshot)
  await update($, snapshot, () => next)
  $.ui.status(statusText(next) || undefined)

  // Cost into the lifetime ledger, by what grew since the last reading.
  const grew = (next.costUsd ?? 0) - (prev?.costUsd ?? 0)
  if (grew > 0) {
    const life = await lifetime($)
    await $.store.set('lifetime', { ...life, costUsd: life.costUsd + grew })
  }

  // One toast per threshold a window crosses; re-armed when it resets.
  const seen = await read($, alerted)
  const nextSeen: Record<string, number> = {}
  for (const l of next.limits) {
    const crossed = ALERT_AT.filter(t => l.percentUsed >= t).pop() ?? 0
    const before = seen[l.kind] ?? 0
    nextSeen[l.kind] = crossed
    if (crossed > before) {
      const when = resetsIn(l.resetsAt, await $.clock.now())
      $.ui.toast(
        `${label(l.kind)} limit at ${Math.round(l.percentUsed)}%${when ? ` (${when})` : ''}`,
      )
    }
  }
  await update($, alerted, () => nextSeen)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-tracker',
      description: 'Open the usage tracker: limits, context, cost and tokens',
    })
    await $.command.register({
      name: 'usage-tracker-band',
      description: 'Show or hide the usage band above the prompt',
    })
    await $.command.register({
      name: 'usage-tracker-reset',
      description: 'Reset the all-time usage totals',
    })

    const life = await lifetime($)
    await $.store.set('lifetime', { ...life, sessions: life.sessions + 1 })

    try {
      const usage = await $.session.usage()
      await record($, toSnapshot(usage.context, usage.rateLimits, usage.cost?.usd))
    } catch {
      // No readings yet; the first session.measure fills them in.
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await record($, toSnapshot(e.context, e.rateLimits, e.cost?.usd))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = e.usage
    if (!usage) return done

    const counts = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
    }
    await update($, session, s => add(s, counts))
    await update($, models, list => {
      const found = list.find(m => m.model === usage.model)
      const base: ModelTokens = found ?? { ...EMPTY, model: usage.model }
      const merged: ModelTokens = { ...add(base, counts), model: usage.model }
      return found ? list.map(m => (m.model === usage.model ? merged : m)) : [...list, merged]
    })
    const life = await lifetime($)
    await $.store.set('lifetime', { ...life, ...add(life, counts) })

    return done
  })

  on('command.run', { command: 'usage-tracker' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Usage tracker' })
    const snap = await read($, snapshot)
    return { text: snap ? `Usage: ${statusText(snap) || 'no readings yet'}` : 'Usage tracker opened.' }
  })

  on('command.run', { command: 'usage-tracker-band' }, async $ => {
    const hidden = await update($, isBandHidden, v => !v)
    return { text: hidden ? 'Usage band hidden.' : 'Usage band shown.' }
  })

  on('command.run', { command: 'usage-tracker-reset' }, async $ => {
    await $.store.set('lifetime', { ...EMPTY, costUsd: 0, sessions: 1, since: await $.clock.now() })
    return { text: 'All-time usage totals reset.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || !snap || snap.limits.length === 0 || (await read($, isBandHidden))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()

    return (
      <Box flexDirection="row" gap={2}>
        {snap.limits.map(l => (
          <Text key={l.kind}>
            <Text dimColor>{label(l.kind)} </Text>
            <Text color={tone(l.percentUsed)}>{bar(l.percentUsed, 8)}</Text>
            <Text> {Math.round(l.percentUsed)}%</Text>
            <Text dimColor> {resetsIn(l.resetsAt, now)}</Text>
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const tokens = await read($, session)
    const perModel = await read($, models)
    const life = await lifetime($)
    const now = await $.clock.now()
    const width = Math.max(8, Math.min(30, (e.props.bodyColumns ?? 40) - 24))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Plan limits</Text>
          {!snap || snap.limits.length === 0 ? (
            <Text dimColor>No limit readings yet (they arrive with the first reply on a subscription).</Text>
          ) : (
            snap.limits.map(l => (
              <Text key={`limit-${l.kind}`}>
                {label(l.kind).padEnd(6)}
                <Text color={tone(l.percentUsed)}>{bar(l.percentUsed, width)}</Text>
                {` ${l.percentUsed}%  `}
                <Text dimColor>{resetsIn(l.resetsAt, now)}</Text>
              </Text>
            ))
          )}
        </Box>

        <Box flexDirection="column">
          <Text bold>Context window</Text>
          {snap?.contextPercent !== undefined ? (
            <Text key="context">
              <Text color={tone(snap.contextPercent)}>{bar(snap.contextPercent, width)}</Text>
              {` ${snap.contextPercent}%  `}
              <Text dimColor>
                {compact(snap.contextTokens ?? 0)} / {compact(snap.contextWindow)} tokens
              </Text>
            </Text>
          ) : (
            <Text dimColor>Empty until the first reply.</Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Text bold>This session</Text>
          <Text key="cost">Cost      {snap?.costUsd !== undefined ? money(snap.costUsd) : '—'}</Text>
          <Text key="turns">Turns     {tokens.turns}</Text>
          <Text key="io">
            Tokens    {compact(tokens.input)} in · {compact(tokens.output)} out
          </Text>
          <Text key="cache" dimColor>
            Cache     {compact(tokens.cacheRead)} read · {compact(tokens.cacheWrite)} written
          </Text>
          {perModel.map(m => (
            <Text key={`model-${m.model}`} dimColor>
              {'  '}
              {m.model}: {m.turns} turns, {compact(m.output)} out
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>All time</Text>
          <Text key="life-cost">
            Cost      {money(life.costUsd)} over {life.sessions} sessions
          </Text>
          <Text key="life-io">
            Tokens    {compact(life.input + life.cacheRead + life.cacheWrite)} in · {compact(life.output)} out
          </Text>
          <Text key="life-since" dimColor>
            Since {new Date(life.since).toISOString().slice(0, 10)}
          </Text>
        </Box>

        <Box flexDirection="row" gap={2}>
          <Button
            key="toggle-band"
            label="Toggle band"
            onPress={() => update($, isBandHidden, v => !v)}
          />
        </Box>
      </Box>
    )
  })
}
