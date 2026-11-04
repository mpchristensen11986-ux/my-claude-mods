# Credits

Some of the mods in this repository are not original work, or build on other people's ideas. Each is credited here.

## Included third-party work

### Ribbon by Jay E | RoboNuggets

`ribbon-wdc/` is a fork of **ribbon** by Jay E of RoboNuggets.

- Upstream: https://github.com/robonuggets/ribbon
- Author site: https://robonuggets.com
- Licence: MIT, Copyright (c) 2026 Jay E | RoboNuggets. The upstream `LICENSE` is included unchanged in `ribbon-wdc/LICENSE`.
- Forked from ribbon 1.0.0, upstream commit `eecb8f9e384e8ae0ebbafb85f5c6490e8d561f72`.
- What changed: theme-following colours, and the plugin renamed `ribbon-wdc` so it cannot clash with the original. Every change is listed in `ribbon-wdc/FORK-NOTES.md`. No logic, price table or cache calculation was changed.
- Embedded font: `ribbon-wdc/hooks/font.ts` embeds the **Outfit** typeface (SIL Open Font License 1.1, https://github.com/Outfitio/Outfit-Fonts). The font keeps its own licence; see the link for the full text.

If you do not need theme-following colours, install the original from the upstream repository.

### Savvy Progress by johnnyvizz

`savvy-progress/` is an **unmodified copy** of the `savvy-progress` plugin by johnnyvizz.

- Upstream: https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress
- Licence: MIT, Copyright (c) 2026 johnnyvizz. The licence is included in `savvy-progress/LICENSE-claude-kit.txt`.
- Version 1.2.1, upstream commit `af8902c493f0a8db6be5e44bb74b567571f7824f`. Provenance is in `savvy-progress/SOURCE.md`.
- It provides the `/agents-info` agents panel, which `subagent-advisor` can open for you.

## Ideas and inspiration

### Long Session Kit and Mark Kashef's Claude Mods Starter Kit

`long-session-kit/` was written from scratch, but its two main ideas, a context meter and an automatic handoff note, come from the **Context Meter** and **Auto Handoff** mods in Mark Kashef's *Claude Mods Starter Kit* (MIT, Copyright (c) 2026 Prompt Advisers). No code was copied. Find his work at https://markkashef.gumroad.com/l/claude-mods-starter-kit.

### Effort Optimizer by Ben AI (not included)

The advisor mods here borrow the "stop, ask, offer an automatic mode" pattern from **Effort Optimizer** by Ben AI. That mod is **not** included in this repository: it was published without a licence, so it is linked rather than copied. Get it from the original publication: https://benai.notion.site/Claude-Effort-Optimizer-3ff1124570fe814292a0c35fedfc8c95 (author site: https://www.benai.co).

## Other mods not included

No other unlicensed third-party mods are included. If one is added in future, it will be credited and linked here rather than copied unless its licence allows redistribution.
