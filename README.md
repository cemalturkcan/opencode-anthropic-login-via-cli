# OpenCode Anthropic Auth

[OpenCode](https://opencode.ai) plugin that lets you use Anthropic models with your Claude Pro/Max subscription. No API key required.

## Features

### Claude Code Version

Reads the installed Claude CLI version and reports it, or 2.1.296 when the CLI is missing or older. Login instructions warn when the installed CLI is outdated.

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

Handles expired tokens automatically. When a refresh fails, the plugin falls back to valid Claude CLI credentials only when they belong to the same account: always for the Claude Code method, for browser logins whose account matches, and for credentials migrated from V1. CCS accounts are never replaced.

### Request Patching

Patches requests so OpenCode talks to Anthropic's API the same way Claude Code 2.1.296 does: the same betas, headers, user agent, billing block, session id and account metadata. The reported CLI version is the installed one or 2.1.296, whichever is newer.

### Prompt Caching

Upgrades OpenCode's cache breakpoints to the one hour TTL that Claude Code uses on subscriptions, so a pause or a long tool run does not drop the cache after five minutes.

### Multiple Accounts (OpenCode V2)

Every login is a separate V2 account labeled with its email. When an account hits a rate limit, the request is replayed once with another logged-in account and the session stays on it until the first account's limit resets. Billing and long-context limits never switch accounts.

## Compatibility

Supports OpenCode V1 (1.18.29+) and V2 (plugin SDK 2.0.26). On V2, credentials migrated from V1 keep refreshing, and rate-limited requests can move to another logged-in account as described above.

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

### Local Build

Run `bun run build` and point OpenCode at the output. OpenCode V1 takes the file (`"plugin": ["file:///path/to/repo/dist/index.js"]`); OpenCode V2 takes the directory (`"plugins": ["/path/to/repo/dist"]`).

## Auth Methods

| Method  | Label                    | How it works                                            |
| ------- | ------------------------ | ------------------------------------------------------- |
| Auto    | Claude Code (auto)       | Reads existing CLI credentials from Keychain/filesystem |
| CCS     | CCS (_instance-name_)    | Auto-detects each CCS instance in `~/.ccs/instances/`   |
| Browser | Claude Pro/Max (browser) | OAuth flow via claude.com with PKCE                     |
| API Key | API Key (manual)         | Standard Anthropic API key                              |

When OpenCode V2 has imported an Anthropic login from V1, the plugin also registers **Claude Pro/Max (migrated from OpenCode V1)** so that login keeps refreshing. It is hidden when there is no such login; new logins should use one of the methods above.

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
| `ANTHROPIC_PROMPT_CACHE_TTL`  | `5m` keeps OpenCode's 5 minute cache; default is `1h`    |

The debug log is written to `~/.local/share/opencode/claude-auth-debug.log`.

## License

MIT
