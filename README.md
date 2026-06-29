# Exam Proctor — Chrome/Edge Extension

A Manifest V3 browser extension that monitors exam integrity. It detects and
logs suspicious activity during an online exam, all **locally** (no server, no
data leaves the machine).

## What it detects

| Signal | Detected by | Notes |
| --- | --- | --- |
| Exiting fullscreen | content script | `fullscreenchange` |
| Switching to another tab | background | compares against the exam tab id |
| Page hidden / minimised | content script | `visibilitychange` (backup signal) |
| Switching to another app | background | window focus lost |
| Opening a new tab | background | `tabs.onCreated` |
| Closing the exam tab | background | `tabs.onRemoved` |
| Copy / cut / paste | content script | blocked; clipboard cleared on copy/cut |
| Right-click (context menu) | content script | optionally blocked |
| Text selection / drag | content script | blocked (not logged as a violation) |
| Devtools shortcuts / open panel | content script | F12, Ctrl+Shift+I/J/C + size heuristic |
| Print / save / view-source / find / select-all / new window | content script | Ctrl+P/S/U/F/A/N |
| Screenshot key | content script | PrintScreen — logged + clipboard cleared (OS capture can't be blocked) |
| More than one display | content script | blocks the page (not a violation); see below |

Enforcement extras (none of these count as strikes):

- The page is **kept blocked unless in fullscreen** — the gate re-appears on
  every fullscreen exit.
- The **Window Management permission is compulsory.** A blocking gate (highest
  priority) requires the student to grant it before the exam can begin; if they
  decline, the gate shows site-settings guidance and a **Re-check** button and
  stays up until it is granted. This guarantees accurate multi-display detection
  via `getScreenDetails()`, with the `screenschange` event driving updates.
  *Browsers that don't support the API are not hard-blocked* — they fall back to
  the best-effort `screen.isExtended` flag.
- A **second/extended display then blocks the page** until it is disconnected,
  taking priority over the fullscreen gate (re-checked live; 2 s poll backstop).
- A native **leave-guard** prompts before navigating away or closing the tab.

## Files

```
manifest.json          Extension manifest (MV3)
background.js          Service worker: exam state, settings, violation store,
                       browser-level watchers (tab/window/new-tab/close)
violation-logger.js    Content-script logger → forwards violations to background
warning-overlay.js     Content-script red warning banner shown on the page
content.js             Content-script DOM detectors (fullscreen, clipboard, keys)
icons/                 Extension icons (16/48/128 px)
```

There is no popup or options page in this build — proctoring runs entirely on
the exam website and starts/stops automatically.

## Install (developer / unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension` folder.

## Use

Monitoring is fully automatic and only runs on the exam site:

1. The student opens `https://exams.myschool.com/take/...`.
2. As soon as the page finishes loading, proctoring **starts automatically** for
   that tab. Optionally pass identity in the URL query string, e.g.
   `.../take/?student=Jane%20Doe&examId=MATH101`.
3. If the page is **not in fullscreen**, a blocking overlay covers it with an
   **Enter fullscreen** button — the student must click it to begin (fullscreen
   cannot be forced programmatically). This does not count as a strike.
4. Violations are recorded to local storage and (if enabled) raise a desktop
   notification, and trigger an escalating on-page warning (see below).
5. The session **ends automatically** when the tab navigates away from the exam
   URL, is closed, or the 3-strike limit is reached.

### 3-strike rule

Every violation (of any type) counts toward a shared strike counter:

| Strike | Response |
| --- | --- |
| 1st | Warning banner that auto-hides after a 5-second window |
| 2nd | Warning banner that stays until the student clicks to acknowledge |
| 3rd | Session ends; a terminal blocking overlay is shown |

The limit is the `maxViolations` default in `background.js` (set to `3`).

### Log file

A JSON log is auto-saved to `<Downloads>/exam-proctor-reports/` and rewritten
on every change — at session start, after each violation, and at session end
(when `endedAt` / `endReason` are filled in). The filename is stable per
session (`proctor-log-<examId>-<startedAt>.json`) and uses overwrite, so it is
a single, continuously-updated file rather than one file per event.

Two browser constraints to be aware of:

- Extensions **cannot append** to a file, so the whole log is rewritten each
  time (not incrementally appended).
- Extensions **cannot choose an arbitrary folder** — auto-saved files must live
  under the browser's Downloads directory. Each rewrite also adds an entry to
  the browser's download history/shelf.

## Configure for your exam site

The extension ships pointed at a placeholder domain plus a localhost test URL.
To deploy on your real exam site, edit **two files** so they stay in sync:

1. `background.js` → `EXAM_URL_PREFIXES` (top of file): replace the production
   prefix with your exam URL prefix, and delete the `http://localhost:8000/take/`
   test entry.
2. `manifest.json` → `content_scripts[0].matches` and `host_permissions`:
   replace `https://exams.myschool.com/*` accordingly, and delete the two
   `http://localhost:8000/*` test entries.

Strike limit and which detectors are on are controlled by `DEFAULT_SETTINGS` in
`background.js`.

## Testing locally

A self-contained 2-page mock app lives in `test/` with a zero-dependency server:

```powershell
cd test
node serve.js          # serves http://localhost:8000  (keep this running)
```

Then open `http://localhost:8000/take/exam.html?student=Jane%20Doe&examId=DEMO101`
and walk through the on-page checklist. The localhost test URL is already wired
into the manifest and `EXAM_URL_PREFIXES` (marked **TEST ONLY**).

## Privacy

All data stays on the student's machine: violations are held in
`chrome.storage.local` and the JSON log is written to the local Downloads
folder. Nothing is transmitted to any server in this build. (Real-time upload to
a server is a possible future enhancement.)

## Settings

There is no settings UI in this build. Detector defaults live in
`DEFAULT_SETTINGS` in `background.js` (all detectors on; actions blocked;
on-page warnings and desktop notifications on; `maxViolations: 3`). Edit those
defaults to change behaviour.

## Limitations (browser sandbox)

These are inherent to what a browser extension is allowed to see — no extension
can fully prevent them:

- It cannot detect OS-level Alt+Tab to apps *without* the browser losing focus,
  phones, or a second device. (Extra *displays* are reliably detected on
  browsers that support the Window Management API, where granting the permission
  is mandatory; other browsers fall back to best-effort detection.)
- Devtools-open detection is a heuristic (window-size gap) and can have false
  positives/negatives.
- `Ctrl+T`/`Ctrl+N`/`Ctrl+W` are handled by the browser before the page sees
  them, so they are caught at the browser level (new tab / tab close) rather than
  blocked.
- For exam-grade integrity you would normally pair this with a locked-down kiosk
  mode or a managed-browser policy.
