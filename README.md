# usage-tracker

A Claude Code mod that tracks your Claude usage live, like a "Claude usage tracker" but built into Claude itself.

- **Band above the prompt**: 5-hour and weekly (7-day) plan limits as colored bars, with time until reset
- **Status line**: `5h 42% · 7d 18% · ctx 34% · $1.23`
- **Toasts** when a limit crosses 75%, 90% and 100%
- **`/usage-tracker` pane**: plan limits, context window fill, session cost, turns, input/output/cache tokens per model, and all-time totals across sessions

## Install

```
/plugin install usage-tracker --marketplace NeerajPratapSingh/Claude_Usage_Tracker
```

Answer `y` to add the marketplace, then pick a scope (user scope = every session).

## Commands

| Command | What it does |
| --- | --- |
| `/usage-tracker` | Open the usage pane |
| `/usage-tracker-band` | Show or hide the band above the prompt |
| `/usage-tracker-reset` | Reset the all-time totals |

Plan limit bars appear on a Claude subscription once the first reply comes back; on an API key you still get context, cost and tokens.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
