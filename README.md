# OpenCode Anthropic Auth

[OpenCode](https://opencode.ai) plugin that lets you use Anthropic models with your Claude Pro/Max subscription. No API key required.

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

Opens an OAuth flow through `claude.com` for users without the CLI. Log in, paste the code, done.

### Token Refresh

Handles expired tokens automatically. V1 and V2 fall back to valid Claude CLI credentials if standard refresh fails. V2 preserves the authentication method and supports the legacy `oauth` method ID used by migrated V1 credentials; CCS refresh failures do not switch accounts.

### Request Patching

Patches requests so OpenCode talks to Anthropic's API the same way Claude Code does.

## Compatibility

Supports OpenCode V1 (1.18.29+) and V2 (tested on 2.0.26). V2 supports migrated V1 OAuth credentials and CLI recovery after token-refresh failures, but does not switch accounts after Anthropic request failures.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-anthropic-login-via-cli@latest"]
}
```

Then open OpenCode and go to **Connect Provider > Anthropic**.

### Updating

OpenCode caches plugin packages in `~/.cache/opencode/node_modules/`. If you pin to a specific version and later bump it (or re-install the same version after a patch), OpenCode may keep loading the cached copy. If requests still behave like the old version after an update, clear the cache:

```bash
rm -rf ~/.cache/opencode/node_modules/
```

Then restart OpenCode. It re-downloads the plugin on the next launch.

## Auth Methods

| Method  | Label                    | How it works                                            |
| ------- | ------------------------ | ------------------------------------------------------- |
| Auto    | Claude Code (auto)       | Reads existing CLI credentials from Keychain/filesystem |
| CCS     | CCS (_instance-name_)    | Auto-detects each CCS instance in `~/.ccs/instances/`   |
| Browser | Claude Pro/Max (browser) | OAuth flow via claude.com with PKCE                     |
| API Key | API Key (manual)         | Standard Anthropic API key                              |

On OpenCode V2 the plugin also registers **Claude Pro/Max (migrated from OpenCode V1)**. It exists so OAuth credentials imported from V1 keep refreshing; new logins should use one of the methods above.

## Environment Variables

| Variable                      | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `CLAUDE_AUTH_DEBUG`           | `0` or `false` disables the debug log                    |
| `ANTHROPIC_ENABLE_1M_CONTEXT` | Opt in to long-context betas                             |
| `ANTHROPIC_BETA_FLAGS`        | Replace the beta flags (comma-separated)                 |
| `ANTHROPIC_CLI_VERSION`       | Override the detected CLI version                        |
| `ANTHROPIC_USER_AGENT`        | Override the user agent                                  |
| `ANTHROPIC_BASE_URL`          | Send requests to another origin, such as a local proxy   |
| `ANTHROPIC_INSECURE`          | Skip TLS verification for `ANTHROPIC_BASE_URL` (V1 only) |

The debug log is written to `~/.local/share/opencode/claude-auth-debug.log`.

## License

MIT
