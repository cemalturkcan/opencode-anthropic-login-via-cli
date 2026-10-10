# Conventions

This document owns code, test, tooling and git rules. `AGENTS.md` summarizes the non-negotiable subset.

## 1. Code

- **No comments.** Self-documenting code: precise names, small functions, obvious control flow. `anti-slop/no-comments` rejects every comment except lint directives.
- **Plain logging.** Use `log` from `src/shared/logger.ts`. Messages are lowercase English without emoji or trailing punctuation, for example `log.warn("token refresh failed", { error: String(failure) })`. Never log raw tokens; the logger redacts sensitive keys.
- **Parse at the boundary.** External JSON enters as `JsonValue` from `src/shared/json.ts` and is narrowed with its guards. Do not pass `unknown` or `any` around.
- **Named exports.** The only default export is the plugin entry in `src/index.ts`, because OpenCode loads it.
- **Constants** are camelCase. Lookup tables are `Map` or `Set`.
- **Caught errors** are named `failure`. An empty `catch {}` is allowed only when the failure is expected and the fallback is explicit.
- **Files** are camelCase and named after their domain noun. One reason to change per file; split before a file passes 250 lines.
- **Shared first.** Logic used by both V1 and V2 lives in `src/shared`. `src/v1` and `src/v2` only adapt it to their SDK.

## 2. Tests

- **Test first.** Write the failing test, watch it fail for the expected reason, then write the code.
- **Regression tests.** Every bug fix adds a test that reproduces the original failure.
- **Colocated specs.** `foo.ts` is tested by `foo.spec.ts` next to it. Test names are behavior sentences.
- **Deterministic.** Tests run in random order (`bun test --randomize`) and must pass in any order and on repeat.
- **Real seams, no module mocks.** Use the sandbox fixtures in `src/testing`, `replaceFetch` for HTTP and `createV2Context` for the V2 host. `anti-slop/no-module-mocking` rejects `mock.module`.
- **Sandbox.** `src/testing/preload.ts` points `HOME` at a temporary directory, restricts `PATH` to a stub directory and disables the debug log, so no test can read real credentials or start the real `claude` binary.
- **Coverage.** `bun run test:coverage` fails below 90% lines or functions for any file.

## 3. Tooling

- **Runtime.** Bun, pinned through `packageManager` in `package.json` and in CI.
- **Lint.** `oxlint.config.ts` enables the correctness, suspicious and perf categories plus the vendored anti-slop rules in `tools/oxlint/anti-slop`. Warnings fail the build.
- **Dependencies.** Exact versions only. The OpenCode SDKs are type-only and stay in `devDependencies`; the bundle has no runtime dependencies.
- **CI.** Actions are pinned to commit SHAs, jobs run with least-privilege permissions on `ubuntu-24.04`, workflows pass actionlint, and the job fails if `bun run check` changes tracked files.

## 4. Git

- **Commit messages** follow conventional commits (`fix:`, `feat:`, `refactor:`, `test:`, `chore:`), because semantic-release derives versions from them.
- **Subject** is lowercase, imperative and describes the behavior change.
- **Body** is plain prose: what was wrong, what changes, what stays the same. No emoji, headers or bullet lists.
- **Pull requests** read like a developer wrote them: plain text, one to three sentences.
