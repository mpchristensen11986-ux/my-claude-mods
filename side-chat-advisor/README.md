# side-chat-advisor

Original work by Matt Christensen. Part of [my-claude-mods](../README.md).

**What it does.** Reads each prompt before it is sent. If it looks like a quick tangent or lookup that would be better in a Side Chat (Split View), it shows a short, non-blocking suggestion with the reason. It uses deterministic rules only: no model calls, and it never blocks or rewrites your prompt.

**Why it is useful.** Tangents in the main thread eat context and pull the session off course. This nudges you to park them to the side.

**Settings.** `enabled`, `sensitivity` (low, medium, high), `showToast`, `showBand` and `cooldown` (minimum prompts between suggestions). `/sidechat-advisor on|off` overrides `enabled`.

**How it connects.** Sits with `subagent-advisor` and `decision-support`, which make the same kind of "is there a better way to run this?" call.
