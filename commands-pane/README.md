# commands-pane

Original work by Matt Christensen. Part of [my-claude-mods](../README.md).

**What it does.** `/commands` opens a pane listing the slash commands you can run, grouped by function, with collapsible groups that remember whether they were open or closed. The list is read from the session at run time, so it includes commands from your other mods. `/commands text` prints the same list as plain text.

**Privacy.** No network, no file access, no model calls, and nothing you type is kept.

**How it connects.** Because the list is read live, every command from the other mods in this repository (`/lsk`, `/decision-support`, `/subagent-advisor`, `/sidechat-advisor`, `/effort-optimizer`) appears in it.
