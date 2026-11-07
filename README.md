# pi-durable

`* * *`

Bolt a serverless [Pi Durable](https://github.com/earendil-works/pi-durable)
agent (`@earendil-works/pi-durable` + `@mariozechner/pi-agent-core` on
Cloudflare Workers & Durable Objects) directly alongside your
[EmDash CMS](https://github.com/emdash-cms/emdash) site or
[DinkusKit](https://github.com/dinkuskit) store and connect your Pi-supported
model subscription. Planned package: `@dinkuskit/pi-durable` (plugin slug
`dinkus-pi-durable`).

## Architecture

1. **Sandboxed EmDash Registry Plugin (`src/` → `dinkus-pi-durable`):**
   - Declarative Block Kit admin page (`/_emdash/admin/pi-durable`) where site
     owners connect their companion Worker URL, pick a Pi subscription model,
     send prompts/steers, and review `WAITING_FOR_HUMAN` approval cards.
   - Uses capability-gated host APIs (`schema:read`, `content:read`,
     `admin.editor-draft:read`, `admin.editor-draft:patch`, `network:request`)
     and fits comfortably within the `128 KiB` Registry `backend.js` bundle cap.
2. **Companion Cloudflare Worker + Durable Object (`worker/`):**
   - Runs `@earendil-works/pi-durable` backed by Durable Object SQLite
     (`ctx.storage.sql`) and tool-boundary steering (`whenBusy: "steer"`).
   - Connects back to the EmDash site's native MCP server so it can work with
     core CMS content or any installed DinkusKit plugins (`Commerce`,
     `Payments`, `Ship`) without sandbox plugin-to-plugin coupling.

## Verification

```sh
npm install
npm run verify:quick
```

## Status

Public runnable plugin scaffold (`0.0.0`, `private: true`). MIT.
