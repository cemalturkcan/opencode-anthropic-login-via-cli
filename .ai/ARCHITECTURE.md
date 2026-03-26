# Architecture

## Overview

OpenCode plugin that authenticates with Anthropic API using Claude Pro/Max OAuth tokens. Syncs credentials from Claude CLI, macOS Keychain, or browser-based PKCE flow.

## Module Layout

```
src/
├── index.ts          thin plugin definition, auth methods, system transform
├── constants.ts      types, OAuth URLs, static defaults
├── logger.ts         JSONL debug logging, secret redaction (CLAUDE_AUTH_DEBUG)
├── model-config.ts   beta flags, env overrides, per-model beta selection
├── http.ts           fetchWithRetry (429, 529, retry-after)
├── pkce.ts           OAuth PKCE authorization + token exchange
├── introspection.ts  Claude CLI binary scanning for betas/scopes/version
├── credentials.ts    token refresh, keychain, CCS multi-instance, fallback chain
├── transforms.ts     request body transform, SSE stream tool name un-prefixing
└── fetch.ts          createCustomFetch — auth injection, beta headers, error recovery
```

## Data Flow

```
OpenCode request
  → createCustomFetch (fetch.ts)
    → getAuth() to read current OAuth state
    → proactive token refresh if expiring (credentials.ts)
    → hard-fail with 401 if no valid token after refresh
    → transformRequestBody: prefix tool names, sanitize system prompt (transforms.ts)
    → getBetasForModel: model-aware beta selection (model-config.ts)
    → build headers: authorization, anthropic-beta, user-agent, x-app
    → fetch to Anthropic API
    → handleRetryableError: classify 429/529/401, swap credentials if needed
    → createToolNameUnprefixStream: un-prefix tool names in SSE response
  → response back to OpenCode
```

## Key Design Decisions

### context-1m-2025-08-07 is opt-in only

This beta header causes Anthropic to reject OAuth requests with "Extra usage is required for long context requests". Post March 13 GA, it's not needed. Only enabled via `ANTHROPIC_ENABLE_1M_CONTEXT=1`. Binary introspection filters out `context-1m-*` betas to prevent reintroduction.

### Binary introspection as best-effort discovery

The plugin scans the Claude CLI binary for beta headers and OAuth scopes. Static config in model-config.ts serves as source of truth when introspection fails. Env vars (`ANTHROPIC_BETA_FLAGS`, `ANTHROPIC_CLI_VERSION`, `ANTHROPIC_USER_AGENT`) override both.

### Non-retryable 429 detection

Long context and billing 429 errors are terminal — retrying with different credentials won't fix them. The plugin detects these by inspecting response body and returns immediately instead of entering an infinite retry loop.

### SSE event boundary buffering

Tool name un-prefixing (removing `mcp_` prefix) operates on complete SSE events delimited by `\n\n` (with `\r\n` normalized to `\n`), not arbitrary TCP chunks. TextDecoder is flushed on stream end to prevent losing split multibyte characters.

### Credential fallback chain

1. OAuth refresh token → TOKEN_URL
2. Claude CLI credentials (keychain on macOS, .credentials.json on Linux)
3. Claude CLI trigger (`claude --print`) to force fresh credentials
4. Hard-fail with 401 if all paths exhausted (no `Bearer undefined`)

## Environment Variables

| Variable                      | Purpose                               |
| ----------------------------- | ------------------------------------- |
| `CLAUDE_AUTH_DEBUG`           | Enable debug logging (`1` or `true`)  |
| `ANTHROPIC_ENABLE_1M_CONTEXT` | Opt-in to long context betas          |
| `ANTHROPIC_BETA_FLAGS`        | Override beta flags (comma-separated) |
| `ANTHROPIC_CLI_VERSION`       | Override detected CLI version         |
| `ANTHROPIC_USER_AGENT`        | Override User-Agent header            |
