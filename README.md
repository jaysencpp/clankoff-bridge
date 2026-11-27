# clankoff-bridge

Play games on a Clankoff site with the AI command-line tools installed on your own machine (Claude Code, Codex,
Copilot, Gemini), using your own subscriptions. The site sends your machine a game position; your CLI answers; the
bridge sends the answer back. That is all it does.

No dependencies: everything that runs is the seven files in `src/`, about 750 lines. Read them before you run them.

## Use

You need Node.js 24 or newer, and at least one AI CLI installed and logged in (for example, `claude` works in your
terminal).

1. Run it, in any folder:
   ```
   npx clankoff-bridge
   ```
   (For a Clankoff site other than `https://clankoff.com`, add `--server https://that-site`.)
2. It prints a link to the site's Account page, and opens it if this machine has a browser. Sign in there, check that
   the page shows the same code as your terminal, and click **Connect**. Any device you are signed in on will do.
3. The terminal says `ready`. Leave it running; Ctrl-C stops it. On the site, choose **Claude via bridge** (or Codex,
   Copilot, Gemini) as your player. Only you see them, and only while your bridge is running.

You do that once. The bridge remembers the site and its token in `~/.config/clankoff-bridge/config.json`
(`%APPDATA%\clankoff-bridge` on Windows), a file only your user can read, so from then on `npx clankoff-bridge` starts
straight away. If the site later refuses the token (you revoked it), the bridge forgets it and prints a new link.

Options: `--server` is the site (default `https://clankoff.com`, or the one remembered), `--agents claude,codex` offers
only those CLIs, `--max 2` sets how many turns run at once, and `--forget` deletes the remembered site and token.

On a machine with no terminal (a service, a container): on the site, open **Account → Bridge**, make a token by hand,
and set `CLANKOFF_SERVER` and `CLANKOFF_BRIDGE_TOKEN` in the environment, or in a `.env` file in the folder the bridge
runs from. They come first when set, and nothing is saved. A site too old to connect from the browser gets the same
kind of token pasted into the terminal instead (it isn't shown as you paste).

## What it does

0. **Connects to your account**, the first time (`src/pair.js`). It makes a random token on your machine and sends
   the site only the token's SHA-256 (`POST <server>/api/bridge/pair`), getting a short code back. It prints
   `<server>/account#pair=<code>` and opens it with your system's opener (`open`, `xdg-open`; not over ssh).
   When you click Connect there, the site starts accepting that token; the bridge finds out by asking
   `GET <server>/api/bridge/whoami` every few seconds, for at most ten minutes. Only connect a code you see in your
   own terminal: whoever holds the bridge behind a code plays your turns.
1. **Checks the token** with `GET <server>/api/bridge/whoami` and prints whose account it belongs to. The server
   must be an `https://` address (plain `http://` only for `localhost`), so the token never travels unencrypted.
2. **Connects out** to `<server>/api/bridge/connect` over a WebSocket. Nothing listens on your machine. The token
   travels in an `Authorization` header, never in a URL.
3. **Says which CLIs it has:** the ones found on your `PATH`, with the model names each one reports (for example from
   `codex debug models`). Nothing else about your machine is sent.
4. **Runs turns.** For each `turn` message (`agent`, `model`, `effort`, `prompt`) it:
   - refuses an unknown CLI, a model name that isn't a plain name (it can't start with `-` and be read as a flag), an
     effort the CLI doesn't have, or a prompt that starts with `-`;
   - makes a fresh, empty temporary folder and runs the CLI there, once, without a shell, and with its tools off (see
     below);
   - sends back the CLI's final answer text, or the kind of failure ("claude timed out", "codex is not logged in on
     the bridge machine"); then kills anything the CLI left running and deletes the folder. What the CLI itself
     printed about a failure is shown in the bridge's own output and is not sent: it can name folders or accounts.
5. **Stops a turn** when the server sends `cancel` (the game was stopped): the CLI's whole process tree is killed.
6. **Reconnects** after a dropped connection (1 s, 2 s, 4 s, … up to 30 s). It stops for good when the server says the
   token was revoked, or when another bridge connects for the same account.

### How each CLI is run (`src/agents.js`)

| CLI | Command | Tools |
|---|---|---|
| Claude Code | `claude -p --output-format text --tools "" --strict-mcp-config --no-session-persistence [--model …] [--effort …]`, prompt on stdin | none: `--tools ""` for the built-in ones, `--strict-mcp-config` for your MCP servers |
| Codex | `codex exec --skip-git-repo-check --sandbox read-only --ephemeral --disable shell_tool --disable unified_exec -c web_search="disabled" -c mcp_servers={} … -`, prompt on stdin | read-only sandbox, shell and web search off, code execution removed from its model catalog, your MCP servers left out |
| Copilot | `copilot -p <prompt> -s --no-color --disable-builtin-mcps [--model …] [--reasoning-effort …]` | none (in `-p` mode Copilot denies every tool unless one is allowed; its built-in MCP servers are off) |
| Gemini | `gemini -p <prompt> -e none --admin-policy <deny-all.toml> [-m …]` | every tool denied by policy (also loaded through a system settings file), extensions off, MCP off |

The CLI runs with your environment **minus** these variables, so it uses its own login and never sees your API keys
or the bridge token: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `GEMINI_BASE_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `TYPESAFE_API_KEY`,
`TYPESAFE_BASE_URL`, `CLANKOFF_BRIDGE_TOKEN`.

### What leaves your machine

The names of your CLIs and their models, and for each turn the CLI's final answer text, or which kind of failure it
was (never the CLI's own error output). When connecting: the SHA-256 of the bridge's token, then the token itself in a
header, as on every later run. No files, no environment, no keys, not your machine's name.

## Good to know

- **It uses your plans.** Every move is a call to your Claude, Codex, Copilot or Gemini subscription. Start with a
  cheap model and low effort.
- **Unverified.** The site can't tell what produced an answer that comes from your machine (a model, a person, a
  script), so bridged players are marked unverified, don't count for player ratings, and can only join challenges
  that allow bridges.
- **The token is like a password** for playing moves as you on that site, and nothing more. Revoke it on the
  Account page at any time; a bridge using it is disconnected at once.
- **Provider terms** are yours to check: this runs your personal CLI subscriptions for games on someone's website.

## Protocol

JSON over a WebSocket (plus text `ping` / `pong`):

| Direction | Message |
|---|---|
| bridge → server | `{type: "hello", client: "clankoff-bridge@x.y.z", agents: {claude: {models: [...]}, ...}}` |
| server → bridge | `{type: "welcome", name}` |
| server → bridge | `{type: "turn", id, agent, model, effort, prompt, timeoutMs}` |
| bridge → server | `{type: "reply", id, text}` or `{type: "error", id, message, fatal}` |
| server → bridge | `{type: "cancel", id}` |

Close code 4001 means the token was revoked; 4000 means another bridge took over.

Connecting from the browser, before any of that (plain HTTPS):

| Request | Answer |
|---|---|
| `POST /api/bridge/pair` `{tokenHash}` (hex SHA-256 of a token the bridge made) | `{code, expiresIn}` |
| `GET /api/bridge/whoami` with the token, while waiting | `401 {pairing: "pending"}`, then `200 {name}` once connected; a plain `401` if it was declined or ran out |

## Files

```
src/cli.js     the npx command: reads options, finds the token (environment, remembered, or a new one), starts the bridge
src/pair.js    connects to your account with a link and a click in the browser
src/saved.js   the file the site and token are remembered in; pasting a token, for a site that can't do the above
src/client.js  connection, hello, running and cancelling turns, reconnecting
src/agents.js  how each CLI is run (arguments, empty folder, withheld variables, timeouts)
src/reap.js    finds and kills processes a CLI left behind
src/meta.js    each CLI's label, model suggestions and efforts
test/          the tests, and fake-site.js: the stand-in site they talk to
```

## Tests

```bash
npm test    # Node's own test runner; nothing to install
```

They start no real CLI (`sh` stands in for one) and reach no network: the only site they talk to is a stand-in on
127.0.0.1. They check the exact arguments each CLI is started with, that API keys and the token stay out of a CLI's
environment, that a turn is killed on a timeout or a cancel along with anything it left running (Linux only: it needs
`/proc`), what the bridge refuses, and what it does when the connection or the token goes. Every push and pull request
runs them (`.github/workflows/ci.yml`), and a release runs them again before anything is sent to npm.

## License

MIT, see [LICENSE](LICENSE). This covers the bridge only.
