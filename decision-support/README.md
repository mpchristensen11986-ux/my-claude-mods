# decision-support

Original work by Matt Christensen. Part of [my-claude-mods](../README.md).

**What it does.** Watches your prompts and the session's own decision points. When a second opinion would help (security, contracts and commercial risk, design choices, risky actions, long plans, or being stuck after repeated failed tool calls), it asks whether to use the built-in `/advisor`, and suggests a model. Deterministic rules only: no model calls, no network, no prompt text kept. It never submits a prompt for you and never edits settings files.

**Modes.** `ask` holds a qualifying prompt and asks, `auto-suggest` shows a toast with the `/advisor` command, `off` is silent.

**Settings.** `enabled`, `mode`, `sensitivity`, `deepModel`, `standardModel`, `quickModel`, `stuckThreshold`, `cooldownPrompts`. The model defaults are `claude-fable-5-1`, `claude-opus-5-5` and `claude-haiku-5-5`. `/decision-support on|off|mode <x>` overrides them.

**How it connects.** Companion to `side-chat-advisor` and `subagent-advisor`.
