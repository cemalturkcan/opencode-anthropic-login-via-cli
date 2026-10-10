# Agent guide

`docs/conventions.md` owns code, test and git rules. `docs/architecture.md` owns module boundaries and request flow. This file is the entry point; when the documents disagree, the owning document wins.

## Project

- OpenCode plugin that serves Anthropic models through a Claude Pro/Max OAuth subscription by sending requests the way Claude Code does.
- One package supports OpenCode V1 (`server` hook, `@opencode-ai/plugin`) and V2 (`setup`, `@opencode/plugin`) from a single default export.
- TypeScript on Bun, bundled with `bun build`, linted with oxlint and the vendored anti-slop plugin, formatted with oxfmt.

## Commands

- `bun run check` is the single quality gate: format check, lint, typecheck, build and tests with coverage. Run it before handoff; it must pass and must not change tracked files.
- `bun run fmt` formats, `bun run lint` lints, `bun run typecheck` typechecks, `bun run test` runs the tests in random order.

## Non-negotiable rules

- Write no comments. The `anti-slop/no-comments` lint rule enforces it; only lint directives are allowed.
- Work test first. Every behavior change and every bug fix starts with a failing test that reproduces it.
- Tests never touch the real home directory, credentials, network or `claude` binary; `src/testing/preload.ts` sandboxes them.
- Log through `src/shared/logger.ts` only. Messages are plain lowercase English without emoji; context goes into structured fields.
- Never add `context-1m-2025-08-07` to the default betas. It breaks OAuth requests.
- Keep every dependency, tool, runtime and CI action pinned to an exact version or commit.
- Keep code, commits and durable artifacts in English.
- Do not commit, branch, push, reset or revert unless the user explicitly asks for that operation.
