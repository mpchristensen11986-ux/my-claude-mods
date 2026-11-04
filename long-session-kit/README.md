# long-session-kit

Original work by Matt Christensen. Part of [my-claude-mods](../README.md). The two ideas behind it, a context meter and an automatic handoff note, come from Mark Kashef's Claude Mods Starter Kit; no code was copied. See [CREDITS.md](../CREDITS.md).

**What it does.** A context meter band, plus automatic handoff notes for long sessions. A handoff is written when the context window reaches a threshold (default 50%), when the prompt cache is about to go cold, and after an idle period (default 30 minutes). Each note costs one background model call.

**Where handoffs go.** At the top level of the folder the session is linked to (the session's project root), as `handoff-<date>.md` plus `LATEST.md`. Handoffs may contain confidential information. If that folder is a git repository, add these lines to its `.gitignore` so they are never committed:

```
handoff-*.md
LATEST.md
```

**Choosing another folder.** Type `/lsk folder` to be asked, or `/lsk folder "C:\path\to\folder"` to set it directly. `/lsk folder reset` goes back to the session folder, and `/lsk status` shows where handoffs will go. The choice is remembered per project and applies to future handoffs only.

**Settings.** `threshold`, `enabled`, `idleMinutes`, `cacheWarningMinutesLeft`, `cacheTtlMinutes` (60), `minTurns`, `handoffDir` (blank means the session folder). Commands: `/lsk now`, `/lsk on|off`, `/lsk threshold <n>`, `/lsk folder`, `/lsk resume`, `/lsk status`.

**Idle and cache triggers.** With the defaults, the 30-minute idle trigger fires before the "cache about to go cold" trigger (about 50 minutes idle), so the cache trigger only matters if you change those settings.

**How it connects.** Built around Ribbon. The context meter shows as a row under the Ribbon band, and `cacheTtlMinutes` defaults to 60 to match Ribbon's prompt-cache model. Install `ribbon-wdc` (or Ribbon) alongside it.
