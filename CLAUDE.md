# CLAUDE.md

> Read `.ai/` files for detailed context.

**Project**: OpenCode plugin for Anthropic OAuth (Claude Pro/Max)
**Stack**: TypeScript, Bun, @opencode-ai/plugin SDK
**Platform**: Linux, macOS, Windows

## Commands

```bash
bun run build       # bundle + emit declarations
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint + oxfmt --check
bun run lint:fix    # auto-fix lint + format
bun run format      # oxfmt --write
```

## Context Files

| File                                       | Purpose                                    |
| ------------------------------------------ | ------------------------------------------ |
| [.ai/RULES.md](.ai/RULES.md)               | Code style, constraints, patterns          |
| [.ai/ARCHITECTURE.md](.ai/ARCHITECTURE.md) | Module layout, data flow, design decisions |

## Critical Rules

1. No decorative comments, section dividers, or ASCII art
2. Comments only when the why is non-obvious
3. No AI-sounding language in code, comments, or commit messages
4. All code and comments in English
5. Run `bun run typecheck && bun run build && bun run lint` before completing any task
6. `context-1m-2025-08-07` must never be in default betas — it breaks OAuth
7. Logging goes through `src/logger.ts`, never raw console.log
8. Empty catch blocks are only acceptable when failure is explicitly expected and harmless
