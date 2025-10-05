# CAPER Lesson History User Script

A Tampermonkey/Greasemonkey helper that records every POST to
`/lesson/store` on CAPER and shows a floating history panel with quick reuse
tools. Recent submissions are persisted in user-script storage across reloads.

## Features

- Hooks both `fetch` and `XMLHttpRequest` to capture real submissions and store
  their payloads.
- Renders a "Lesson History" overlay showing the date field, grade, description,
  request status, and timestamp for each capture.
- Provides quick actions: auto-fill the CAPER form, paste the captured text over
  the current field contents, copy the raw payload to the clipboard, or remove
  individual entries.
- Supports a **Collapse/Expand** toggle so you can keep the panel minimized in
  the corner; the state is remembered between visits.
- Persists up to 50 submissions using Tampermonkey storage so history survives
  refreshes.
- Includes a debug mode with a local sandbox and simulated submissions so you can
  test the workflow without hitting CAPER.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge) or
   [Greasemonkey](https://www.greasespot.net/) (Firefox).
2. Create a new script and paste the contents of
   `caper-lesson-history.user.js` into the editor.
3. Save the script. It runs automatically on `https://caper.sks.go.th/*` and on
   local debug pages (`http://localhost/*`, `http://127.0.0.1/*`).

## Using the CAPER history panel

- Navigate to a CAPER page that posts to `lesson/store` and submit the form as
  usual. New entries appear in the floating "Lesson History" panel.
- Click **Fill form** to repopulate the current page's inputs with the captured
  values (date, description, grade) using scripted assignments.
- Click **Paste data** if you want the captured text to overwrite any current
  selection in the field, mirroring a manual paste.
- Use the toggle button next to the title to collapse/expand the panel; the
  preference is saved automatically.
- Click **Copy payload** to copy the exact `application/x-www-form-urlencoded`
  string to your clipboard.
- Use **Remove** or the top-level **Clear history** button to prune entries.

## Debug mode and sandbox

You can exercise the script without touching CAPER:

1. Serve the bundled sandbox page (for example with Python):
   ```bash
   python3 -m http.server 4173 --directory debug
   ```
2. Visit `http://localhost:4173/?caper-history-debug=1` with the user script
   enabled. Debug mode persists via `localStorage` until you disable it.
3. Use the sandbox form to trigger mock submissions, or the "Debug tools" widget
   injected by the script to add simulated entries instantly.
4. Disable debug mode by visiting the same page with
   `?caper-history-debug=0` (or pressing the **Disable debug** button).

> **Note:** On local hosts the mock request will usually 404; the script treats a
> status of `0` or any error as a captured entry so you can still inspect the
> payload.

## Customisation

- Change the `@match` rules at the top of `caper-lesson-history.user.js` if your
  CAPER instance lives on a different domain.
- Adjust `HISTORY_LIMIT`, panel styling, or the captured fields to fit your
  usage.
- Toggle debug mode manually by setting `localStorage.caperHistoryDebug` to `"1"`
  or `"0"` in the browser console.
