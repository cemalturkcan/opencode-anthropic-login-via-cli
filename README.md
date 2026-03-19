# opencode-anthropic-login-via-cli

Use Anthropic models in [OpenCode](https://github.com/sst/opencode) with your **Claude Pro/Max subscription** — no API key needed.

Just log into Claude CLI once, and Anthropic models work in OpenCode automatically.

## How it works

```
Claude CLI (OAuth token)  -->  Plugin  -->  OpenCode
     macOS Keychain                     x-api-key header
     or ~/.claude/.credentials.json     + auth.json sync
```

- Reads your Claude CLI OAuth token on startup
- On **macOS**: reads from the system Keychain (`Claude Code-credentials`)
- On **Linux**: reads from `~/.claude/.credentials.json`
- Injects the token into every Anthropic API call
- Auto-refreshes when the token is about to expire
- Syncs credentials to `~/.local/share/opencode/auth.json`

## Prerequisites

- [OpenCode](https://github.com/sst/opencode)
- [Claude CLI](https://github.com/anthropics/claude-code) logged in (`claude auth status`)
- Claude Pro or Max subscription

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-anthropic-login-via-cli"]
}
```

OpenCode installs npm plugins automatically on startup. No `bun add` or `npm install` needed.

That's it. No API key, no provider config needed.

## License

MIT
