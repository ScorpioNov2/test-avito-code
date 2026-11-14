# Avito code — P2P collaborative code editor (no backend)

TypeScript + Vite + Monaco. Real-time sync via Yjs + y-webrtc. Code runs 100% in the browser.

## Run locally

```bash
npm install
npm run fetch-wasm     # downloads ~225 MB of C/C++, Rust and Java toolchains into public/wasm/ (self-hosted)
npm run dev            # http://localhost:5173
npm run build          # type-check + production build (copies public/wasm into dist/)
```

`npm run fetch-wasm -- clang|rust|java` downloads only one toolchain. Files are pinned to exact commits and
verified with SHA-256 (`scripts/wasm-assets.manifest.json`). Python needs no download here (Pyodide is fetched
from jsDelivr on the first Python run); JavaScript needs nothing.

**Rooms.** In the lobby, **Create room** makes a new room (the link is copied) and **Join room** opens a popup where you type a room ID
or paste a full room link. Inside a room the top bar shows the full room name with **Copy link**, **QR code** and **Leave**
buttons. Leaving asks for confirmation, then returns to the lobby: the code you had stays in your editor (for that one
reload) and the others remain in the room. Joining a room starts from the room's code, not from what was in your lobby editor.
Rooms need a signaling server, see below. To test alone, open the room link in two tabs.

**Phones.** The layout adapts down to 320px: the top bar splits into two rows (logo + actions / room controls), the status bar wraps,
icon-only buttons replace labels, inputs use 16px text (so iOS does not zoom in), and the splitter has a larger touch area.

## Language runtimes

| Language | How it runs | First run | Notes |
|----------|-------------|-----------|-------|
| JavaScript | Web Worker | instant | `console.*` -> terminal, top-level `await` works. Like Node, the run ends only when no timer / `fetch` is pending (`setTimeout`, `setInterval`, async callbacks, `fetch(...).then(...)`); a never-cleared `setInterval` keeps running until you press Stop. Errors show the worker's raw stack trace (its line numbers are offset by 2 from the editor's) |
| Python | Pyodide in a Web Worker | ~5 s | `input()` not supported |
| C/C++ | clang + wasm-ld (LLVM 8) compiled to wasm, in a Web Worker | downloads ~60 MB (cached) | C++17, libc++, no exceptions, no threads, no `sleep`/`usleep`, stdin is empty. Source is always compiled as C++ |
| Rust | **Miri interpreter** compiled to wasm, in a Web Worker | downloads ~150 MB (cached) | Interprets code (does not compile to machine code), so it is slow. Single file, std only, no stdin. A panic prints an extra "unsupported Miri functionality" message (no unwinding) |
| Java | javac + TeaVM compiled to wasm ([`live-codes/java`](https://github.com/live-codes/java), Apache-2.0), in a Web Worker | downloads ~8 MB | Java 25 syntax (records, streams, `var`...) but TeaVM's **subset** of the class library: no reflection, JNI, runtime class loading or files; limited threads. Each run takes ~1-3 s (TeaVM builds wasm). Use Stop for infinite loops. stdin is empty |

Why Rust is an interpreter: there is currently no prebuilt, working `rustc` for WebAssembly that can *link* an
executable (the available builds stop at object files). Miri sidesteps linking.

Java's engine is a young project; it is pinned to one commit and checksummed, so it cannot change under you.
The engine returns stdout only when the program ends, so `scripts/patches/javaStreamOutput.mjs` patches its worker
(right after the checksum check, with an exact-match assertion) to send each line as soon as the program prints it:
`System.out.println` followed by `Thread.sleep(10000)` shows the line immediately.
A public class that is not named `Main` (for example `public class Solution`) is accepted: the `public` keyword is
blanked out before compiling because the engine always compiles `Main.java`.

Stop (the red square) works for C/C++, Rust, Java and Python, by terminating the worker; the next run reloads the toolchain
from the browser cache. Downloaded toolchains are kept in the browser's Cache Storage: if you replace files in
`public/wasm/`, bump `ASSET_CACHE_VERSION` in `src/languages/toolchains/browserAssetLoader.ts`.
Open **Settings > WebAssembly cache** to see the cached C/C++, Rust, and Java toolchain sizes and clear an individual
toolchain. The size bar reports cached response bytes; the separate browser quota meter includes all data stored for the site.
Python/Pyodide is loaded through the browser's HTTP cache and cannot be selectively cleared by this app.

## Deploy to GitHub Pages

The workflow `.github/workflows/deploy.yml` builds and deploys on every push to `main`.

1. Push this project to your repository (for example `avito-code-runtime`) on branch `main`.
2. **Settings > Pages > Build and deployment > Source: GitHub Actions**.
3. Deploy the signaling server (next section) and add its URL in
   **Settings > Secrets and variables > Actions > Variables**: name `VITE_SIGNALING_URLS`,
   value `wss://avito-code-signaling.<your-subdomain>.workers.dev`.
4. Push (or run the workflow from the Actions tab). The site is at `https://<user>.github.io/<repo>/`.

The workflow runs `npm ci`, downloads the toolchains (cached between runs), builds with the right `--base`
path and publishes `dist/` (about 225 MB, under GitHub Pages' 1 GB limit; no single file exceeds 100 MB).
No special HTTP headers are needed (no SharedArrayBuffer / cross-origin isolation).

## Signaling server

WebRTC peers need a *signaling server* to find each other (it carries connection setup only, never your code).
GitHub Pages cannot run one, and the free public servers are unreliable: the `*.herokuapp.com` addresses are old
y-webrtc defaults that its author abandoned, and the current default (`y-webrtc-eu.fly.dev`) has been reported down.
So run your own. The one in `signaling/` runs on **Cloudflare Workers** (Durable Objects, WebSocket hibernation) and
speaks the same protocol as y-webrtc's reference server.

```bash
cd signaling
npm install
npx wrangler login
npx wrangler deploy        # prints https://avito-code-signaling.<your-subdomain>.workers.dev
```

Use `wss://` plus that host as `VITE_SIGNALING_URLS` (repository variable for GitHub Actions, or `.env` locally).
Recommended: set `ALLOWED_ORIGINS` in `signaling/wrangler.toml` (for example
`"https://<user>.github.io,http://localhost:5173"`) and deploy again, so only your site can use it.
Check Cloudflare's current free-plan limits for Durable Objects and WebSocket messages. `npm run dev` in `signaling/`
runs it locally on `ws://127.0.0.1:8787`.

Alternative without Cloudflare: `PORT=4444 npx y-webrtc-signaling` (installed with `y-webrtc`) on any Node host that
terminates TLS, such as a small VPS. Peers behind strict NAT/firewalls (including phones on mobile data) need a TURN server: see the next section.

## TURN: rooms that work on WiFi but not on mobile data

Symptom: two people in the same room see each other on the same WiFi, but as soon as one switches to mobile data (4G/5G) they stop
seeing each other, even though the signaling server answers fine. Cause: WebRTC first tries a *direct* connection. STUN only helps
two devices learn their public addresses, which is enough on the same network or behind friendly routers. Mobile carriers put phones
behind CGNAT / symmetric NAT where the direct path is impossible, so traffic must go through a **TURN relay**. y-webrtc's underlying
library (simple-peer) ships with STUN only, so before this fix there was no way to connect in that case.

Now the app asks the signaling Worker for short-lived TURN credentials (`GET /turn-credentials`) before it joins a room, and falls
back to STUN (with a console warning) if that fails. The Worker holds the secret, so no API token ever reaches the browser. It uses
[Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/) (at the time of writing 1,000 GB/month free, then $0.05/GB; check current pricing).

Setup (once):

1. Cloudflare Dashboard > **Realtime** > **TURN Server** > create a key. Copy the **Turn Token ID** and the **API token**.
2. Put the Turn Token ID in `signaling/wrangler.toml` (`TURN_KEY_ID = "..."`) and store the API token as a secret:
   ```bash
   cd signaling
   npx wrangler secret put TURN_API_TOKEN
   npx wrangler deploy
   ```
3. Check it from a terminal (add the `Origin` header if you set `ALLOWED_ORIGINS`; the answer must list `turn:` / `turns:` URLs with a `username` and `credential`):
   ```bash
   curl -H "Origin: https://<user>.github.io" https://avito-code-signaling.<your-subdomain>.workers.dev/turn-credentials
   ```
4. Redeploy the site (push to `main`) so everyone gets the new version. Nothing else to configure: the app derives the URL from `VITE_SIGNALING_URLS`.

Responses: `200` credentials, `501` TURN not configured (app uses STUN only), `502` Cloudflare API failed (app uses STUN only), `403` origin not allowed.

**The dot next to the room name** tells you what is going on (hover for details):
green = connected to other people, amber = nobody else connected yet, red = the signaling server is unreachable (it reconnects by itself).
If you see amber while a friend says they are in the room, your networks cannot reach each other directly: check that TURN works.

**Verify that TURN really works** (not just that it is configured): build/run with `VITE_ICE_TRANSPORT_POLICY=relay`. The browser is then
*forbidden* from using a direct path, so two people can only connect if the relay works. It is slower and spends TURN bandwidth, so
use it only for the test and remove it afterwards.

**Reconnecting.** When a connection is lost (for example WiFi to mobile data, or the phone's browser comes back from the background),
the signaling library reconnects automatically with backoff. The app does not restart the signaling provider just because the room
temporarily has no connected peer; restarting it can create avoidable WebSocket churn.

## Supabase signaling (alternative to Cloudflare)

`supabase/functions/signaling/` is a WebSocket-compatible y-webrtc relay backed by Supabase Realtime Broadcast. Unlike a module-level
in-memory socket map, Realtime can fan messages out even when browser connections are handled by different Edge Function instances.
The app derives the TURN URL as `/functions/v1/signaling/ice-servers` and accepts the raw ICE server array returned by the function.

Configure these Edge Function variables/secrets:

- `XIRSYS_AUTH_TOKEN`: the Xirsys authorization string. Keep it in Function Secrets, never in Vite variables or committed source.
- `ALLOWED_ORIGINS`: comma-separated website origins, for example `https://<user>.github.io,http://localhost:5173`.
- `SUPABASE_URL` plus a server-side key: the function reads `SUPABASE_SECRET_KEYS` (`default`) or `SUPABASE_SECRET_KEY` /
  `SUPABASE_SERVICE_ROLE_KEY`. These must remain server-side.

Set the frontend's `VITE_SIGNALING_URLS` to
`wss://<project-ref>.supabase.co/functions/v1/signaling`, then deploy the function with
`supabase functions deploy signaling --no-verify-jwt` and rebuild the site. The WebSocket route uses room links as bearer access;
an origin allowlist is not authentication for non-browser clients. Add JWT or room authorization before using private rooms.
Each connected browser session also holds a Supabase Realtime subscription, so Realtime connection and broadcast limits apply.

**Other TURN servers** (your own coturn, Metered...): set `VITE_ICE_SERVERS` to a JSON array such as
`[{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]`. Those credentials end up in the page, so prefer the Worker
route above for anything that matters.

## Keeping everyone's text identical

Yjs counts positions with `\n` (LF), but Monaco's default line ending on **Windows is CRLF**, and y-monaco only resets the
editor text when it differs, so someone who joins an (initially empty) room kept CRLF. Each line then shifted positions by
one character: other people's typing landed in the wrong place and cursors were drawn in the wrong place.
`src/app/sharedTextBinding.ts` forces LF on every editor (without writing anything to the shared document) and
re-checks the editor against the shared document whenever it has been idle for 0.4 s; if they ever differ it resyncs the
editor from the shared document and logs `[avito-code] The editor diverged from the shared document; resyncing it.` in the
browser console. It also removes any stray `\r` that a client still running an older version writes into the document.

## Themes

Visual Studio Dark, Visual Studio (default), High Contrast Dark/Light, GitHub Dark/Light, Dracula, Monokai, One Dark,
Solarized Dark/Light. A theme colors both the editor and the surrounding UI. Themes are per user, not synced.

**Settings** also has a switch, "Show names on other people's cursors": turn it off when a name label covers the code
you are reading (the colored cursor bar and selection stay). It is saved in your browser and affects only you.
Add one: create `src/app/editorThemes/themes/<name>Theme.ts` with `export default createPaletteTheme(meta, palette)`
(copy an existing file); it is picked up automatically.

## Project layout

```
scripts/fetch-wasm-assets.mjs      downloads + verifies toolchains
signaling/                         Cloudflare Worker signaling server (separate package)
supabase/functions/signaling/      Supabase Edge Function + Realtime Broadcast relay
.github/workflows/deploy.yml       GitHub Pages deployment
src/
  main.ts                          wires everything together
  app/                             UI, collaboration, editor, themes, splitter, terminal, toasts, settings, QR
  languages/
    languagePlugin.ts              the plugin interface
    languageRegistry.ts            registry (plugins/*Plugin.ts are auto-registered)
    languageValidator.ts           detects code written in a language other than the selected runtime
    workerRunnerHost.ts            runs code in a Web Worker, supports Stop
    plugins/                       one file per language
    workers/                       javascript, python, cpp, rust workers
    toolchains/
      clang/                       TypeScript port of wasm-clang (memfs, tar, WASI process, compile+link+run)
      rust/                        Miri runner + vendored WASI shim
      java/                        teavm-javac wrapper, `public class` handling, Stop
```

## Add a language (Open/Closed)

Create `src/languages/plugins/<name>Plugin.ts` and `export default` a `LanguagePlugin`
(id = Monaco language id, starter code, fingerprints, `run`, `stop`). It is picked up automatically via
`import.meta.glob` — no existing file changes. See `THIRD_PARTY_NOTICES.md` for licenses of bundled toolchains.

Shortcuts: `Ctrl/Cmd + Enter` runs (or stops) the code.
