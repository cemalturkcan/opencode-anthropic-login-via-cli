# OpenCode Anthropic Auth

[OpenCode](https://opencode.ai) plugin that lets you use Anthropic models with your Claude Pro/Max subscription. No API key required. Works with OpenCode V1 and V2 on macOS, Linux and Windows.

## Install

### OpenCode V2

Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["opencode-anthropic-login-via-cli@latest"]
}
```

Then log in, either from the TUI with `/connect` → **Anthropic**, or from the shell:

```bash
opencode auth login anthropic --method claude-cli
```

### OpenCode V1

Add the plugin to `opencode.json`:

```json
{
  "plugin": ["opencode-anthropic-login-via-cli@latest"]
}
```

Then open OpenCode and go to **Connect Provider > Anthropic**.

## Login Methods

| Label                    | How it works                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Claude Code (auto)       | Uses the Claude CLI login: the macOS Keychain, or `~/.claude/.credentials.json` on Linux and Windows |
| CCS (_instance-name_)    | One method per [CCS](https://github.com/kaitranntt/ccs) instance found in `~/.ccs/instances/`        |
| Claude Pro/Max (browser) | OAuth login on claude.com with PKCE; paste the code shown after you authorize                        |
| API Key (manual)         | A regular Anthropic API key, without any of the subscription handling below                          |

When OpenCode V2 has imported an Anthropic login from V1, a **Claude Pro/Max (migrated from OpenCode V1)** method also appears so that login keeps refreshing. It stays hidden otherwise.

## What It Does

**Requests look like Claude Code.** Requests carry the same betas, headers, user agent, billing block, session id and account metadata as Claude Code 2.1.296. The reported version is the installed Claude CLI version, or 2.1.296 if the CLI is missing or older. The login screen warns when the installed CLI is outdated.

**Tokens refresh on their own.** Expired tokens are refreshed automatically. If a refresh fails, the plugin falls back to the Claude CLI login, but only when it belongs to the same account. CCS accounts are never swapped for another account.

**The prompt cache lasts an hour.** Cache breakpoints get the one hour TTL Claude Code uses on subscriptions, so a pause or a long tool run does not throw the cache away after five minutes.

**Rate limits move to another account.** On V2 every login is a separate account labeled with its email. When one account hits a rate limit, the request is retried once with another logged-in account, and requests keep using that account until the first one's limit resets. On V1 the plugin falls back to other Claude CLI or CCS logins the same way. Billing and long-context limits never switch accounts.

**Subscription models cost nothing.** While an OAuth login is active, Anthropic model prices show as zero.

## Environment Variables

| Variable                      | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `ANTHROPIC_PROMPT_CACHE_TTL`  | `5m` keeps OpenCode's five minute cache instead of `1h`  |
| `ANTHROPIC_ENABLE_1M_CONTEXT` | `1` adds the long-context beta for models that need it   |
| `ANTHROPIC_BETA_FLAGS`        | Replace the beta flags (comma-separated)                 |
| `ANTHROPIC_CLI_VERSION`       | Override the reported Claude CLI version                 |
| `ANTHROPIC_USER_AGENT`        | Override the user agent                                  |
| `ANTHROPIC_BASE_URL`          | Send requests to another origin, such as a local proxy   |
| `ANTHROPIC_INSECURE`          | `1` skips TLS verification for `ANTHROPIC_BASE_URL` (V1) |
| `CLAUDE_AUTH_DEBUG`           | `0` turns off the debug log                              |

The debug log lives at `~/.local/share/opencode/claude-auth-debug.log`. Tokens are redacted.

## Troubleshooting

**An update does not take effect.** OpenCode caches plugin packages. Clear the cache and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/node_modules/
```

On V2, also restart the background server with `opencode service restart`.

## Development

```bash
bun install
bun run check   # format, lint, typecheck, build and tests with coverage
```

To try a local build, point OpenCode at `dist`. V1 takes the file (`"plugin": ["file:///path/to/repo/dist/index.js"]`), V2 takes the directory (`"plugins": ["/path/to/repo/dist"]`). Conventions and architecture are in [`AGENTS.md`](AGENTS.md) and [`docs/`](docs).

## License

MIT
