# Architecture

This document owns module boundaries and request flow.

## Layout

```
src/
  index.ts          default export consumed by OpenCode
  plugin.ts         V1 server hook and V2 setup sharing one bootstrap
  shared/
    authCopy.ts     method labels, urls and login instructions
    billingHeader.ts  billing block and version fingerprint
    constants.ts    oauth endpoints, defaults and platform flags
    credentials.ts  claude cli, keychain and ccs credential sources
    http.ts         jittered retry with retry-after for token endpoints
    identity.ts     device id and oauth account profile
    introspection.ts  installed claude cli version and update check
    json.ts         JsonValue type and guards
    logger.ts       redacted jsonl debug log
    modelConfig.ts  beta flags and per-model overrides
    oauthClient.ts  pkce, code exchange and per-token refresh dedupe
    paths.ts        home-relative paths
    proxy.ts        ANTHROPIC_BASE_URL rewrite and beta query parameter
    rateLimit.ts    terminal rate limits, version gate and reset times
    request.ts      claude code headers and beta merging
    transforms.ts   request body rewrite, cache ttl, metadata and tool name restore
    versionGate.ts  reports claude_code_version_too_old responses
  v1/
    auth.ts         V1 auth hook and methods
    fetch.ts        V1 fetch wrapper with refresh and credential recovery
  v2/
    accounts.ts     active account selection, cooldowns and failover
    auth.ts         V2 method registrations, labels and refresh
    http.ts         V2 http.request and http.response hooks
    pricing.ts      subscription pricing transform
  testing/          sandbox preload and test fixtures
```

## Request flow

V1 installs `createCustomFetch` through the auth loader. V2 registers `http.request` and `http.response` session hooks. Both use the same shared steps:

1. Resolve the OAuth credential. V1 refreshes it itself; V2 relies on the host, which calls the registered `refresh`.
2. Rewrite the JSON body: Claude Code identity, sanitized system prompt, billing block, `mcp_` PascalCase tool names including `tool_choice`, one hour cache TTL and `metadata.user_id`.
3. Set the Claude Code header set: `authorization`, merged `anthropic-beta`, `user-agent`, `x-app: cli`, `x-claude-code-session-id`, `anthropic-dangerous-direct-browser-access` and the `x-stainless-*` headers; drop `x-api-key`.
4. Add `?beta=true` to `/v1/messages` and apply `ANTHROPIC_BASE_URL`.
5. Restore tool names in streamed and non-streamed responses.

V1 retries 401, 429 and 529 once with alternate CLI or CCS credentials. V2 replays a 429 once with another logged-in OAuth account and pins the session to it until the first account's reset time. Terminal billing and long-context 429s never switch accounts.

## Decisions

- **`context-1m-2025-08-07` is opt-in.** It makes OAuth requests fail with "Extra usage is required for long context requests". Only `ANTHROPIC_ENABLE_1M_CONTEXT=1` enables it, and introspection filters it out.
- **Claude Code identity is captured, not scanned.** Betas, headers, scopes and the billing block match a request captured from Claude Code 2.1.296. Only the version comes from the installed CLI, and it is never reported lower than 2.1.296 so newer models are not rejected with `claude_code_version_too_old`.
- **The billing block has no `cch`.** Claude Code 2.1.296 sends `cc_version` and `cc_entrypoint` only; the version fingerprint skips `<system-reminder>` blocks.
- **Prompt caching uses the one hour TTL** like Claude Code on subscriptions. `ANTHROPIC_PROMPT_CACHE_TTL=5m` opts out. No keep-alive requests are sent.
- **Refreshes are deduplicated per refresh token,** so concurrent refreshes of different accounts never share a result.
- **V2 pricing follows the active connection** on every request, so switching between OAuth and an API key updates displayed costs.
- **The migrated V1 method id `oauth`** stays registered so credentials imported from V1 keep refreshing.
- **`ANTHROPIC_INSECURE` works only on V1.** V2 performs the fetch itself and exposes no TLS option to plugins.

## Environment variables

| Variable                      | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `CLAUDE_AUTH_DEBUG`           | `0` or `false` disables the debug log                    |
| `ANTHROPIC_ENABLE_1M_CONTEXT` | Opt in to long-context betas                             |
| `ANTHROPIC_BETA_FLAGS`        | Replace the beta flags (comma-separated)                 |
| `ANTHROPIC_CLI_VERSION`       | Override the detected CLI version                        |
| `ANTHROPIC_USER_AGENT`        | Override the user agent                                  |
| `ANTHROPIC_BASE_URL`          | Send requests to another origin, such as a local proxy   |
| `ANTHROPIC_INSECURE`          | Skip TLS verification for `ANTHROPIC_BASE_URL` (V1 only) |
