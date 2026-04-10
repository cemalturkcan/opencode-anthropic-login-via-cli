# Rules

## Code Style

- no decorative comments, section dividers (`// ── ... ──`), or ASCII art
- comments only when the why is non-obvious
- no JSDoc that restates the function name or signature
- no AI-sounding language ("Let's...", "Here we...", "Now we...")
- all code and comments in English
- prefer explicit names over short names
- prefer early returns to keep control flow flat
- encode invariants in types, not comments

## File Structure

- one file should have one clear reason to change
- target file size under 250 lines, over 400 requires a strong reason
- `src/index.ts` stays thin — orchestration only
- split by responsibility, not by vague technical category
- keep side effects at the edges, helpers stay pure

## TypeScript

- avoid `any` except for OpenCode SDK boundaries (plugin types change often)
- use `type` for object shapes, `interface` for extensible contracts
- explicit types for function parameters and return values
- type inference for simple variables

## Error Handling

- empty `catch {}` only when failure is explicitly expected and harmless
- every other catch must log via `src/logger.ts`
- retries live in `src/http.ts`, not copied across modules
- distinguish retryable errors (429, 529) from terminal errors (billing, long context)

## Dependencies

- `@opencode-ai/plugin` should be pinned to a semver range, not `"latest"`
- minimize external dependencies — this is a lightweight plugin
- devDependencies: oxlint, oxfmt, typescript, bun-types

## Naming

- filenames use kebab-case
- types and interfaces use PascalCase
- constants use UPPER_SNAKE_CASE
- functions and variables use camelCase
- no generic names like `helpers`, `common`, `utils`, `misc`

## Testing

- test files go in `tests/`
- excluded from tsconfig build via `exclude: ["tests"]`
- focus on: error detection, beta selection, SSE boundary buffering, retry logic

## Git

- follow existing commit style: `type: short lowercase description`
- commit messages describe the technical change directly, nothing else
- no emojis, no bullet lists, no section headers in commit messages
- no AI patterns in commit messages or PR descriptions — no "Summary", "What's covered", "Stats", "Changes outside X" headers
- PR body should read like a developer wrote it: plain text, 1-3 sentences max
- match the tone and format of the repo's existing commit history
- PR descriptions in English only
