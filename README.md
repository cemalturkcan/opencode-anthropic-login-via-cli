# opencode-anthropic-login-via-cli

Use Anthropic models in [OpenCode](https://github.com/sst/opencode) with your Claude Pro/Max subscription — no API key needed.

## What it does

```
Claude CLI credentials  ──>  Plugin  ──>  OpenCode Anthropic API calls
~/.claude/.credentials.json          x-api-key header injection
```

1. **Startup** — Reads your Claude CLI OAuth token from `~/.claude/.credentials.json`
2. **Auto-refresh** — If the token is expired, runs `claude` CLI in the background to get a fresh one
3. **Header injection** — Injects the valid token as `x-api-key` before every Anthropic API call
4. **Provider auto-config** — Adds `anthropic` provider to OpenCode config automatically, so models appear in the list without any manual setup
5. **Background renewal** — When token is within 30 minutes of expiry, refreshes proactively in the background

No manual token management. Log into Claude CLI once, and Anthropic models just work in OpenCode.

## Prerequisites

- [OpenCode](https://github.com/sst/opencode) installed
- [Claude CLI](https://github.com/anthropics/claude-code) installed and logged in (`claude` command available)
- Active Claude Pro or Max subscription

## Install

```bash
bun add opencode-anthropic-login-via-cli
```

Add to your `opencode.json`:

```json
{
  "plugin": {
    "anthropic-login": {
      "module": "opencode-anthropic-login-via-cli"
    }
  }
}
```

Or install directly from GitHub:

```json
{
  "plugin": {
    "anthropic-login": {
      "module": "github:cemalturkcan/opencode-anthropic-login-via-cli"
    }
  }
}
```

That's it. No `provider.anthropic` config needed — the plugin handles everything.

## How the flow works

```
OpenCode starts
  |
  v
Plugin init
  |-- Claude CLI installed? (which claude)
  |-- Credentials file exists? (~/.claude/.credentials.json)
  |-- If either missing -> plugin silently disables itself
  |
  v
Session created
  |-- Read token from credentials file
  |-- Token expired? -> Run `claude` CLI to refresh
  |-- Cache token in memory
  |-- Write to ~/.local/share/opencode/auth.json
  |
  v
Every Anthropic API call (chat.headers hook)
  |-- Cached token valid? -> Inject x-api-key immediately
  |-- Token expiring soon? -> Background refresh (non-blocking)
  |-- No cached token? -> Read file, sync if needed, then inject
```

## License

MIT
