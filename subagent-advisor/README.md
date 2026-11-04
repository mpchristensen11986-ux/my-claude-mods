# subagent-advisor

Original work by Matt Christensen. Part of [my-claude-mods](../README.md).

**What it does.** Watches the prompt you submit and, when the task looks better delegated to subagents (broad search, independent parts, long research, large diff review, bulk reads), holds the prompt and asks whether to hand it to subagents. It can also nudge after many sequential Read, Grep or Glob calls in one turn. Heuristics only, no model calls.

**Modes.** `ask` holds the prompt and asks, `auto-delegate` always adds a subagent instruction, `auto-continue` shows a toast only, `off` is silent. If the question fails, the prompt goes through unchanged.

**Opening views after you choose subagents.** When subagents are chosen, it queues two slash commands that run when the delegating turn ends: `/agents-info open` (the agents panel from the [`savvy-progress`](../savvy-progress/README.md) mod) and the built-in `/tasks` background tasks view, but only if that command is listed in your session. If `savvy-progress` is not installed, you get one short toast per session suggesting it. A mod cannot run a command while the turn is still running, which is why the views appear at the end of the turn. Switch this off with `/subagent-advisor views off` or the `openViews` setting.

**Settings.** `enabled`, `mode`, `sensitivity`, `toolCallNudge`, `openViews`. Commands: `/subagent-advisor on|off|status`, `/subagent-advisor mode <x>`, `/subagent-advisor views on|off`.

**How it connects.** Companion to `side-chat-advisor` and `decision-support`, and uses `savvy-progress` for the agents panel.
