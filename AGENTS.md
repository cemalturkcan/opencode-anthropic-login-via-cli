# Agent Guide

> Read `.ai/` files for detailed context.

**Project**: OpenCode plugin for Anthropic OAuth (Claude Pro/Max)
**Stack**: TypeScript, Bun, @opencode-ai/plugin SDK
**Platform**: Linux, macOS, Windows

## Commands

```bash
bun run build       # bundle + emit declarations
bun run typecheck   # tsc --noEmit
bun run test        # bun test
bun run lint        # oxlint + oxfmt --check
bun run lint:fix    # auto-fix lint + format
bun run format      # oxfmt --write
```

## Context Files

- Rules: `.ai/RULES.md`
- Architecture: `.ai/ARCHITECTURE.md`

## Critical Rules

1. No decorative comments, section dividers, or ASCII art
2. Comments only when the why is non-obvious
3. No AI patterns in code, comments, commits, or PR descriptions — match the repo's existing commit style
4. All code and comments in English
5. Run `bun run typecheck && bun run build && bun run lint` before completing any task
6. `context-1m-2025-08-07` must never be in default betas — it breaks OAuth
7. Logging goes through `src/logger.ts`, never raw console.log
8. Empty catch blocks are only acceptable when failure is explicitly expected and harmless
