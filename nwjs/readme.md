# NW.js SDK AI Debugging Environment

A real Chromium runtime (NW.js SDK flavor) that starts headless, runs the
real `onlykey.github.io` web app as a child process, and lets an external
script or an LLM open/drive/inspect real browser windows against it over
CDP - for stepping through the actual GUI workflow, injecting test code,
and reading real console/error output, not just testing the crypto in
isolation.

---

## Quickstart

```bash
node ensure.js   # reuses a healthy session, or cleans up a stale one
npm start        # only if ensure.js printed "Ready to start" (exit code 2)
```

`ensure.js` exists because nw.js/Chromium can crash natively (confirmed
live: a real SIGSEGV inside `libnw.so` - not caused by anything in this
project, this VM just has no GPU acceleration, a known source of Chromium
instability, mitigated but not eliminated by the `--disable-gpu` flags in
`package.json`'s `start` script). When that happens the main process dies
and drops off CDP (port 9222), but the web app server it spawned as a
child process survives as an orphan (still answering on port 3000) -
`ensure.js` detects and clears that stale state before a fresh `npm start`,
rather than a new session fighting over the same port with a dead one.

Once running:

```bash
node run.js <script.js> [url]   # inject a script into the real app window,
                                 # opens one if needed; prints its return
                                 # value + console/error output from during
                                 # the call

node console.js [--clear]       # dump everything the app window has
                                 # logged since it opened (or since the
                                 # last --clear) - persistent, independent
                                 # of any specific injected call, so GUI-
                                 # only activity (a human clicking around,
                                 # or the app's own background behavior)
                                 # is still visible after the fact
```

Mocha tests / other Node code should `require('../lib/nwjs_client')`
directly rather than shelling out to these CLI scripts - it's our own
code, not a third-party binary.

---

## How it's wired together

* `package.json`'s `"main": "index.js"` (not an HTML page) runs NW.js's
  real headless/background-script mode: a genuine Node module context
  (`__dirname`, `require`, all normal) with no window opened on startup.
* `index.js` (the background script) spawns the real
  `onlykey.github.io/index.js` server as a **child process**, not
  `require()`'d directly into its own JS realm - confirmed live that
  breaks: the app's GUN.js dependency does its own environment detection,
  and NW.js's hybrid window+Node context (both `window`/`document` *and*
  `require`/`process` in scope at once) makes it pick an incompatible
  code path and throw on startup. A genuinely separate child process
  sidesteps that entirely.
* `index.js` also exposes `global.openAppWindow(url)` - opens a real,
  visible window via the native `nw.Window` API, injecting
  `inject_console_capture.js` at document-start so the window's console
  output/uncaught errors accumulate in `window.__nwConsoleLog`
  persistently, independent of whether/when anything is actively
  evaluating something against the page.
* `lib/nwjs_client.js` (outside this directory - the reusable part) talks
  CDP to whichever tab it needs: `evalInBackground()` for controlling nwjs
  itself (spawns/windows), `evalInPage()` for the real app window (opens
  one via `openAppWindow()` automatically if none exists), `getConsoleLog()`
  for the persistent buffer.

---

## Project Structure

```text
nwjs/
├── index.js                     # background script - main entry (not HTML)
├── ensure.js                    # session check/cleanup - run before npm start
├── run.js                       # CLI: inject a script file into the app window
├── console.js                   # CLI: dump the persistent console log
├── inject_console_capture.js    # injected at document-start into opened windows
├── package.json                 # project config + scripts
└── udata/                       # isolated user data directory (auto-generated)
```
