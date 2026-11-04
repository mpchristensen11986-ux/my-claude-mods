# ribbon-wdc: fork notes

Fork of robonuggets/ribbon: theme-following colours. Upstream: https://github.com/robonuggets/ribbon (MIT, Copyright (c) 2026 Jay E | RoboNuggets). Copied from the installed plugin ribbon 1.0.0, upstream commit eecb8f9e384e8ae0ebbafb85f5c6490e8d561f72 (gitCommitSha recorded in the Claude Code plugin install record). The LICENSE file is unchanged.

## Changes

1. .claude-plugin/plugin.json: name ribbon-wdc, version 1.0.0-wdc.1, description note added. Author, homepage, repository and licence kept as upstream.
2. .claude-plugin/marketplace.json: plugin entry name changed to ribbon-wdc so it cannot clash with upstream ribbon.
3. hooks/cache-art.ts: removed BG, ORANGE and YELLOW. TEXT, MUTED, EMPTY and LINE are now SVG-only mid-tone greys (EMPTY and LINE semi-transparent) chosen to read on light and dark. Added THEME, a table of theme keys for the text band. HUE and INK kept for SVG art. The solid background rect of the cache card SVG was removed (transparent).
4. hooks/register.tsx: all backgroundColor={BG} removed. Text colours use theme keys. No logic, price table or cache calculation changed.
5. Atom owner ids in hooks/register.tsx ('ribbon' to 'ribbon-wdc') and plugin ids in tests/*.ts and the state key in types/index.d.ts, because the state owner must match the plugin name. No logic change. Tests' assertions untouched.
6. FORK-NOTES.md added; .in_use lock files not copied.

## Colour mapping (text band)

| Was | Now |
|---|---|
| band background #24221c | none (inherits the theme) |
| TEXT | text |
| MUTED | subtle |
| EMPTY (unlit dots) | inactive |
| 7D bar ORANGE | claude |
| 5H bar YELLOW | warning |
| LOW flag | error |
| WARM chip (terminal) | background error, text inverseText |
| COLD chip (terminal) | background permission, text inverseText |
| WARM/COLD summary text | error / permission |

## Not theme-aware

Svg cannot take theme keys (SvgProps is an isolated drawing with no theme hook documented). On desktop, VS Code and mobile these stay fixed colours: the WARM/COLD chip, Robo, and the whole cache card (text, dividers, dots, model prices). They use mid-tone colours on a transparent background; contrast is lower than the text band on very light or very dark themes. Not verified visually on a rendered light theme.
