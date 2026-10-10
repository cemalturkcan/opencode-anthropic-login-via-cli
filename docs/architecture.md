# Architecture

This document owns module boundaries and request flow.

## Layout

```
src/
  index.ts          default export consumed by OpenCode
  plugin.ts         V1 server hook and V2 setup sharing one bootstrap
  shared/
    authCopy.ts     method labels, urls and login instructions
    cch.ts          billing header fingerprint
    constants.ts    oauth endpoints, defaults and platform flags
    credentials.ts  claude cli, keychain and ccs credential sources
    http.ts         retry with retry-after for token endpoints
    introspection.ts  claude cli version, betas and scopes
    json.ts         JsonValue type and guards
    logger.ts       redacted jsonl debug log
    modelConfig.ts  beta flags and per-model overrides
    oauthClient.ts  pkce, code exchange and per-token refresh dedupe
    paths.ts        home-relative paths
    proxy.ts        ANTHROPIC_BASE_URL rewrite and beta query parameter
    request.ts      oauth headers and beta merging
    transforms.ts   request body rewrite and tool name restore
  v1/
    auth.ts         V1 auth hook and methods
    fetch.ts        V1 fetch wrapper with refresh and credential recovery
  v2/
    auth.ts         V2 method registrations and refresh
    connection.ts   active oauth credential lookup
    http.ts         V2 http.request and http.response hooks
    pricing.ts      subscription pricing transform
  testing/          sandbox preload and test fixtures
```

## Request flow

V1 installs `createCustomFetch` through the auth loader. V2 registers `http.request` and `http.response` session hooks. Both use the same shared steps:

1. Resolve the OAuth credential. V1 refreshes it itself; V2 relies on the host, which calls the registered `refresh`.
2. Rewrite the JSON body: Claude Code identity, sanitized system prompt, billing header, `mcp_` PascalCase tool names including `tool_choice`.
3. Set `authorization`, merged `anthropic-beta`, the Claude CLI `user-agent` and `x-app: cli`; drop `x-api-key`.
4. Add `?beta=true` to `/v1/messages` and apply `ANTHROPIC_BASE_URL`.
5. Restore tool names in streamed and non-streamed responses.

V1 additionally retries 401, 429 and 529 once with alternate CLI or CCS credentials, except for terminal billing and long-context 429s. V2 does not switch accounts.

## Decisions

- **`context-1m-2025-08-07` is opt-in.** It makes OAuth requests fail with "Extra usage is required for long context requests". Only `ANTHROPIC_ENABLE_1M_CONTEXT=1` enables it, and introspection filters it out.
- **Introspection is best effort.** The installed CLI provides version, betas and scopes; static defaults apply when it is missing or unreadable.
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
