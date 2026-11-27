# clankoff-bridge

Plays turns of Clankoff games with the AI CLIs on a person's own machine (Claude Code, Codex, Copilot, Gemini), tools
off, and sends the answers back to the site. People run it with `npx clankoff-bridge` on their own subscriptions, so
`README.md` is a promise to them: it says exactly what is run, with which arguments, and what leaves their machine.

## Where this code lives

It is written in the Clankoff repo (private), in `packages/clankoff-bridge`, and copied from there to the public repo
github.com/jaysencpp/clankoff-bridge. The copy replaces everything in the public repo except `.git`, `.gitignore`
and `.github/`.

- **In the public repo**, change only `.github/` and `.gitignore`. Anything else is overwritten by the next copy:
  make the change in Clankoff, and carry a pull request from outside over by hand.
- **In Clankoff**, this folder is the source. Local mode runs its CLIs through it (`providers/cli/` re-exports it),
  the Worker imports `clankoff-bridge/meta`, and `worker/bridge.js` is the other end of the protocol.

## Commands

```bash
npm test                          # Node's own test runner; nothing to install
node --test test/agents.test.js   # one file
node src/cli.js --help
```

The tests start no real CLI (`sh` stands in for one) and reach no network: the only site they talk to is
`test/fake-site.js` on 127.0.0.1. The ones that kill leftover processes need `/proc`, so they are skipped off Linux.

## Rules

- **No dependencies.** Node's built-ins only (Node 24 or newer). People are told to read `src/` before they run it.
- **Small.** The README says seven files and about 750 lines. Keep it close, and change the number when it moves.
- **Everything here is public.** No secrets, no real tokens in tests or examples, nothing about how the private site
  is built. The copy refuses to commit a file that looks like it holds a key.
- **The README stays true.** A change to how a CLI is started, which variables are withheld, the protocol, or what
  is sent, changes the matching table or list in `README.md` in the same commit.
- **Don't loosen how a CLI is run** unless asked to: tools off, a fresh empty folder, no shell, and an environment
  without the API keys and the bridge token (`WITHHELD_VARS` in `src/agents.js`, which must cover every key variable
  the app knows). Model, effort and prompt come from the server and are checked before they become arguments.
- **A CLI's own error output is never sent.** The site hears the kind of failure; the detail stays in the bridge's
  own output, because it can name folders and accounts.
- **The token** travels in an `Authorization` header only: not in an address, not in a log. The server must be
  `https://` (plain `http://` only for `localhost`).
- **Old versions keep running.** A published bridge stays on people's machines, and a site can be older than the
  bridge. Add to the protocol; don't change or remove what a message already means.
- **`src/meta.js` is plain data** with no imports: the Worker loads it, and Workers have no Node APIs.
- **`exports` in `package.json`** is what the app imports, and CI loads each one. Renaming one breaks Clankoff.

## Releasing

A release starts in the Clankoff repo: the version is raised there, the package is copied here, and the tag
`v<version>` is pushed. The tag starts `.github/workflows/release.yml`, which runs the tests and stages the version on
npm; it goes public when the maintainer approves it with two-factor authentication.

Don't bump, tag, push or publish unless asked to. `release.yml` and its `npm` environment are named in npm's trusted
publishing setup: renaming either breaks releases.
