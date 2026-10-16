import { expect, mock, test } from 'claude-code/testing'

import { bar, money, resetsIn, statusText } from '../hooks/register'

const SURFACES = ['terminal', 'desktop'] as const

test('formats bars, money and reset times', async () => {
  expect(bar(50, 10)).toBe('█████░░░░░')
  expect(bar(120, 4)).toBe('████')
  expect(money(0.0123)).toBe('$0.012')
  expect(money(4.5)).toBe('$4.50')
  const now = Date.parse('2026-10-12T10:00:00Z')
  expect(resetsIn('2026-10-12T12:30:00Z', now)).toBe('resets in 2h 30m')
  expect(resetsIn('2026-10-15T11:00:00Z', now)).toBe('resets in 3d 1h')
  expect(
    statusText({
      contextWindow: 200000,
      contextPercent: 34,
      limits: [{ kind: 'five_hour', percentUsed: 42.4 }],
      costUsd: 1.234,
    }),
  ).toBe('5h 42% · ctx 34% · $1.23')
})

test('a measurement fills the band, the status line, the pane and a toast', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-12T10:00:00Z') })
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.measure({
    context: { tokens: 68000, window: 200000, percent: 34 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42 },
      { kind: 'seven_day', percentUsed: 91 },
    ],
    cost: { usd: 1.5 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  expect(statuses.at(-1)).toBe('5h 42% · 7d 91% · ctx 34% · $1.50')
  expect(toasts).toEqual(['7d limit at 91%'])

  for (const surface of SURFACES) {
    const band = await $.ui.mount({
      plugin: 'usage-tracker',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 3,
        bodyColumns: 100,
        scroll: { offset: 0 } as never,
        view: {} as never,
      },
    })
    expect(await band.find({ text: /42%/ })).toBeDefined()
    expect(await band.find({ text: /91%/ })).toBeDefined()

    const pane = await $.ui.mount({
      plugin: 'usage-tracker',
      surface,
      component: 'Pane',
      requestId: 'usage-tracker',
      props: { title: 'Usage tracker', isFocused: true, bodyColumns: 60 } as never,
    })
    expect(await pane.find({ text: /\$1\.50/ })).toBeDefined()
    expect(await pane.find({ text: /68\.0k \/ 200\.0k/ })).toBeDefined()
  }
})
