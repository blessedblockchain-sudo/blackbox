# Hosting the web app

`apps/web` is a **static export** — `output: "export"` in `next.config.ts`, no
Node server, no API routes. Everything it shows it reads from the browser:
Solana devnet for L1, MagicBlock's TEE RPC for the live round. That makes it a
plain folder of files, so any static host will serve it, free.

## What is live now

**https://blackbox-e57ff9.gitlab.io/** — GitLab Pages, published by the `pages`
job in `.gitlab-ci.yml` on every push to `main`. Free, no extra account, no
build minutes bought. This is the URL on the submission.

## Building the folder yourself

```bash
cd apps/web
NEXT_PUBLIC_STATIC=1 NEXT_PUBLIC_CLUSTER=devnet pnpm exec next build
# -> apps/web/out   (~9 MB, index.html + _next/ + the route folders)
```

`out/` is the whole site. `NEXT_PUBLIC_BASE_PATH` sets a sub-path if the host
serves from one; leave it unset for a host that serves from the root.

## Other free hosts, if you ever want a second one

| Host | How | Account needed |
|---|---|---|
| GitLab Pages | already wired; push to `main` | no (already yours) |
| Netlify Drop | drag `out/` onto app.netlify.com/drop | no, for a temporary URL |
| Cloudflare Pages | `wrangler pages deploy out` | free account |
| GitHub Pages | push `out/` to a `gh-pages` branch | free account |
| Surge | `npx surge out` | free account |
| Firebase Hosting | `firebase deploy` | free account |

All of them serve the same folder. Nothing about the app is host-specific —
there is no server to run, no environment secret to hold, and the admin keypair
never leaves this repo's `.mb/` directory.

## Routing note

The export writes a directory per route (`out/arena/index.html`). Hosts that
serve `index.html` from a directory need no config. A host that does not should
be pointed at `out/404.html` as the fallback.
