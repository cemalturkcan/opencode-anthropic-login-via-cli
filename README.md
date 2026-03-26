# OpenCode Anthropic Auth

[OpenCode](https://github.com/sst/opencode) plugin that lets you use Anthropic models with your Claude Pro/Max subscription. No API key required.

## Features

### Binary Introspection

Reads the Claude CLI binary to extract current beta headers, OAuth scopes, and version info. Stays in sync with Anthropic's API automatically instead of relying on hardcoded values.

### Cross-Platform Support

Works on **macOS**, **Linux**, and **Windows**.

### Auto Login

If you have Claude CLI installed and logged in, the plugin picks up your credentials automatically:

- **macOS**: System Keychain
- **Linux / Windows**: `~/.claude/.credentials.json`

### CCS Support

If you use [CCS](https://github.com/kaitranntt/ccs) for multiple Claude Code instances, each instance in `~/.ccs/instances/` is detected and shows up as a separate auth method.

### Browser Login

Opens an OAuth flow through `claude.ai` for users without the CLI. Log in, paste the code, done.

### Token Refresh

Handles expired tokens automatically. Falls back to the CLI if the standard refresh fails.

### Request Patching

Patches requests so OpenCode talks to Anthropic's API the same way Claude Code does.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-anthropic-login-via-cli@latest"]
}
```

Then open OpenCode and go to **Connect Provider > Anthropic**.

## Auth Methods

| Method  | Label                    | How it works                                            |
| ------- | ------------------------ | ------------------------------------------------------- |
| Auto    | Claude Code (auto)       | Reads existing CLI credentials from Keychain/filesystem |
| CCS     | CCS (_instance-name_)    | Auto-detects each CCS instance in `~/.ccs/instances/`   |
| Browser | Claude Pro/Max (browser) | OAuth flow via claude.ai with PKCE                      |
| API Key | API Key (manual)         | Standard Anthropic API key                              |

## License

MIT
