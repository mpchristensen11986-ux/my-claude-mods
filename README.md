# my-claude-mods

A set of Claude Code mods (interface and behaviour add-ons) that I built to work together, packaged as one plugin marketplace.

**Third-party work included:** **Ribbon** (by Jay E | RoboNuggets, forked as `ribbon-wdc`) and **Savvy Progress** (by johnnyvizz, unmodified), both MIT-licensed and credited in [CREDITS.md](CREDITS.md). The long-session-kit context meter sits under the Ribbon band and uses Ribbon's 60-minute prompt-cache model, and subagent-advisor can open the Savvy Progress agents panel.

**Related work not included:** [Effort Optimizer by Ben AI](https://benai.notion.site/Claude-Effort-Optimizer-3ff1124570fe814292a0c35fedfc8c95) is a good companion to the advisor mods, but it was published without a licence, so it is linked here and not copied.

## The mods

| Mod | Author | What it does |
|---|---|---|
| [`side-chat-advisor`](side-chat-advisor/README.md) | Matt Christensen | Spots quick tangent or lookup prompts and suggests a Side Chat in Split View instead of cluttering the main thread. |
| [`subagent-advisor`](subagent-advisor/README.md) | Matt Christensen | Spots broad, parallel or research-style prompts and asks whether to delegate to subagents. |
| [`decision-support`](decision-support/README.md) | Matt Christensen | Spots decisions that deserve a second opinion and asks whether to use `/advisor`, with a suggested model. |
| [`long-session-kit`](long-session-kit/README.md) | Matt Christensen | Context meter band plus automatic handoff notes, saved in the session's folder, for long sessions. |
| [`commands-pane`](commands-pane/README.md) | Matt Christensen | `/commands` opens a pane listing slash commands by function, in collapsible groups. |
| [`ribbon-wdc`](ribbon-wdc/README.md) | Jay E \| RoboNuggets (fork by Matt Christensen) | Band showing usage left and whether the prompt cache is warm or cold. Theme-following colours. |
| [`savvy-progress`](savvy-progress/README.md) | johnnyvizz (unmodified copy) | Progress bar and `/agents-info` agents panel showing what subagents are doing. |

## User guide

[`docs/user-guide.html`](docs/user-guide.html) is a single-file illustrated guide with a tab for each mod (what it is, what you get from it, how to use it, with screenshots). It is self-contained: download it and open it in a browser. GitHub shows the file as source, not as a page.

## How they fit together

- **Ribbon and long-session-kit.** Ribbon shows whether the prompt cache is warm. long-session-kit writes a handoff before the cache goes cold, and its `cacheTtlMinutes` setting defaults to 60 to match Ribbon's model. Its context meter shows as a row under the Ribbon band.
- **The advisors.** side-chat-advisor, subagent-advisor and decision-support each look at a prompt before it is sent and may ask a question. They share the same rule for ignoring prompts that did not come from a person, and the same style of on/off/mode commands.
- **Subagent advisor and Savvy Progress.** When you choose subagents, subagent-advisor can open the Savvy Progress agents panel for you.

## Install

You need a Claude Code version that supports mods. Add the marketplace, then install what you want:

```
/plugin marketplace add mpchristensen11986-ux/my-claude-mods
/plugin install ribbon-wdc@my-claude-mods
/plugin install long-session-kit@my-claude-mods
/plugin install side-chat-advisor@my-claude-mods
/plugin install subagent-advisor@my-claude-mods
/plugin install decision-support@my-claude-mods
/plugin install commands-pane@my-claude-mods
/plugin install savvy-progress@my-claude-mods
/reload-plugins
```

Install `ribbon-wdc` or the original `ribbon`, not both.

Mods are not sandboxed and run with the same access as Claude Code. Read the source of any mod before you install it.

## Type-checking

The `tsconfig.json` files extend a file that Claude Code writes into each mod's `.claude-plugin/types/` folder when it loads the mod, so it is not in this repository.

## Licence

Original work: MIT, see [LICENSE](LICENSE). Third-party work keeps its own terms, see [CREDITS.md](CREDITS.md).
