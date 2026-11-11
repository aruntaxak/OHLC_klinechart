# AGENTS.md — OHLC Viewer (Taxak Capital) — KLineChart variant

Project memory: architecture decisions and tech stack. Keep this file in sync with
real changes; do not let it drift from the code.

## What this project is

A **standalone desktop candlestick viewer** for OHLC data stored in **Parquet**
files. No server, no cloud, no accounts — it launches into a **watchlist** sidebar
and the user picks a ticker (or opens a parquet directly) to chart it offline.

## Tech stack

- **Language**: Python 3.10+ (launcher/backend) + vanilla JavaScript (frontend).
  No TypeScript, no frontend build step, no bundler.
- **Data**: [polars](https://pola.rs/) for reading/parsing/resampling Parquet
  (via a **lazy scan** — the file is never fully materialised in RAM).
- **UI shell**: [pywebview](https://github.com/r0x0r/pywebview) native window
  (system webview). tkinter is used *only* for the macOS Open-With event capture;
  the file picker is an `osascript` "choose file" dialog.
- **Charting**: [KLineChart v10](https://klinecharts.com/) (10.0.2),
  **vendored locally** as `klinecharts.min.js` so the app works fully offline
   (Apache-2.0). Vendored so the app works fully offline with no attribution logo.
- **Packaging (macOS)**: `build_macos.sh` wraps the app into
  `/Applications/OHLC Viewer.app` using the **system `python3`** (no PyInstaller,
  no bundled interpreter); it copies the Python script + static assets (including
  `indicators/`) into the bundle and registers a `.parquet` UTI.

## Architecture decisions

1. **Local HTTP bridge, not direct file access.** `ohlc_viewer.py` lazily scans
   the Parquet, starts a `ThreadingHTTPServer` on `127.0.0.1` (ephemeral port),
   and the pywebview window loads `index.html` from `http://127.0.0.1:<port>/`.
   The browser talks to the backend only via two JSON endpoints:
    - `GET /api/meta` → `{ symbol, dates[], minDate, maxDate, totalBars }`
    - `GET /api/data?from=&to=&tf=` → `{ bars: [{time, open, high, low, close}] }`
    - `GET /api/profile` → the saved workspace for the current parquet (or `{}`).
    - `POST /api/profile` → persist the workspace (JSON body) for the current parquet.
    (`time` is epoch **seconds**.) This keeps heavy data work in Python and the
    frontend dumb/portable.

2. **KLineChart PULLS data** — `app.js` registers
   `chart.setDataLoader({ getBars })` and KLineChart calls `getBars` with:
   - `init` — first load for the current symbol+period.
   - `forward` — user panned past the **oldest** loaded bar. Returned bars are
     **PREPENDED**. `params.timestamp` = oldest loaded bar.
   - `backward` — user panned past the **newest** loaded bar. Returned bars are
     **APPENDED**. `params.timestamp` = newest loaded bar.

   **The names are the opposite of what you would guess** — verified in
   `klinecharts.min.js` (`_addData()` does `data.concat(dataList)` for `forward`
   and `dataList.concat(data)` for `backward`). Do not "fix" them.

3. **KLineChart only loads data once BOTH a symbol and a period are set.**
   `_processDataLoad()` is guarded on `_period` being non-null and there is **no
   default period**. Forgetting `chart.setPeriod(...)` in `initChart()` yields a
   silently **blank chart**. Keep the `setSymbol` → `setPeriod` → `setDataLoader`
   order in `initChart()`.

4. **Windowed data loading.** Only a sliding window of trading days is ever sent
   to the chart. Window width scales with the timeframe (`BASE_DAYS=5` days ×
   minutes at the 1m base; `1D` shows up to 500 daily bars) so the on-screen bar
   count stays stable across timeframes. Panning past a loaded edge auto-fetches
   more days through the loader.

5. **Resampling lives in Python, not JS.** Timeframe aggregation (1/5/15/30/60
   min, 1D) is done with polars `group_by` + `first/max/min/last` over `_ts`
   buckets on the backend. The frontend only asks for a timeframe via `tf`.

6. **IST wall-clock via a UTC label trick.** The backend converts naive
   `Date`+`Time` into epoch seconds *as if the wall clock were UTC*, so the chart
   is created with `timezone: 'UTC'` to render the original IST times. Setting a
   real timezone here would shift every label. The overnight session break shows
   as a normal intraday gap.

7. **Plugin-style indicators, no build.** Every file in `indicators/`
   self-registers with `klinecharts.registerIndicator(...)` **and** pushes
   `{ name, label, overlay }` onto the global `window.INDICATORS` array (loaded by
   `index.html` after `klinecharts.min.js`, before `app.js`). Adding an indicator =
   drop a file. Shared math helpers (pivots, ratio bands) live in
   `indicators/util.js` as `window.INDU`.
   - `overlay: true` → the indicator is created on the main pane and **must** pass
     `paneId: 'candle_pane'`, otherwise `createIndicator()` spawns a new pane.
   - `overlay: false` → the indicator claims its own pane.
    - Most indicators come from KLineChart's built-in registry (MA, EMA, SMA, BOLL,
      SAR, BBI, MACD, RSI, KDJ, CCI, WR, DMI). **ATR is NOT a built-in** — it ships
      as a plugin, together with the custom **Kalman filter** and **Harmonic
      Patterns** scanner (Gartley/Butterfly/Bat/Crab). Three more overlay plugins
      live in `indicators/`: **insidebar.js** (marks inside bars with a dashed box and an `IB` label; the label has an on/off toggle in its settings),
      **hhll.js** (labels swing pivots HH/LL/HL/LH), and **divergence.js** (regular
      bullish/bearish divergence across RSI, MACD, CCI, Stochastic, ROC, Williams %R;
       aggregates confirmations per price-pivot pair and labels every confirming
       oscillator, e.g. `RSI, STO, ROC, WPR` stacked as a column (teal = bullish,
       red = bearish; no DIV prefix/arrow — colour encodes direction). These three
       overlay plugins (insidebar / hhll / divergence) each expose a **TF-apply**
       threshold in their settings panel: they render only on timeframes at or above
       the chosen value (e.g. 15m and above) and stay invisible below it; the
       threshold is saved per indicator in the profile and re-evaluated on TF switch.
   - `app.js` filters the menu against `klinecharts.getSupportedIndicators()` so an
     unregistered name can never render a dead menu row.

8. **Split / Link (multiple views).** A "view" is one `klinecharts.init()`
   instance living in its own column of `#views` (flex row). **Split** adds a
   second view (e.g. to compare timeframes side by side); the new view copies the
   first view's timeframe and focused day. **Link** (only meaningful with two
   views) keeps the two views' **centres aligned in time** while panning, even at
   different timeframes — implemented via `chart.subscribeAction('onScroll', …)`
   → `syncLink()`, which finds the source centre timestamp and `scrollToDataIndex()`
   on the other view. A single global `_linkSyncing` guard prevents the
   cross-chart ping-pong (a per-view guard would still let view B re-sync back).
   Each view has its own `loadedFrom/loadedTo` window, `tf`, `focusIdx`, and
   indicator set; the toolbar always acts on the **active** view (selected by
   clicking it / its header). Default/Reset zoom targets a **constant candle width
   in pixels** (`DEFAULT_CANDLE_PX=7`) via `setBarSpace()`.

9. **Column auto-detection.** The loader matches OHLC/date columns
   case-insensitively and supports either `Date`+`Time` strings (multiple formats)
   or a single `Datetime` column. Don't assume fixed column names.

10. **Per-file workspace profiles (TradingView-style persistence).** Drawings
    (overlays) and indicator state survive re-opening the same parquet. On launch
    the frontend `GET /api/profile`; on any change it `POST /api/profile` with a
    JSON snapshot. The backend stores **one file per parquet**, keyed by a SHA-256
    of the file's absolute path: **`~/.ohlc_viewer/profiles/<hash>.json`**.
    The profile records, per *view*: timeframe (`tf`), focused day (`focusIdx`),
    candle width (`candlePx`), the indicator list (enabled flag, `calcParams`,
    `colors`, `paneId`) and every overlay (serialised as `{name, paneId, points,
    styles, lock, visible}`). Split/Link flags are stored at the top level.
    - Overlays are serialised by reading `chart.getOverlays({ paneId })` (use this,
      **not** the internal `getOverlaysByFilter()`) and stripping functions; points
      are stored as `{timestamp, price}` / `{dataIndex, price}` / `{value}` so they
      re-anchor to the same bars regardless of timeframe. Restoring recreates each
      overlay via `createOverlay()` (which returns the live instance) and re-attaches
      `onSelected`/`onDeselected`/`onRemoved` handlers.
    - Saving is diff-based: `snapshot()` JSON-stringifies the workspace and only
      `POST`s when it differs from the last saved snapshot. `scheduleSave()` fires
      on every discrete mutation (draw create/move/delete, style/colour change,
      indicator toggle/settings, tf change, zoom reset, nav, split/link); a 1.5 s
      watchdog (`startAutosave`) catches overlay drags, which have no edit callback.
      Saves are suppressed until the restored profile has been applied
      (`_profileReady`) so the blank initial state never overwrites a saved one.

## Watchlists

A **watchlist** is a *named collection of folders* of parquet files, and it is the
app's **entry point** — it replaced the single-file launch (the macOS file dialog
and the argv/Open-With resolution in `main()`). Selecting a watchlist shows its
tickers (parquet files); clicking a ticker charts it. **One ticker is shown at a
time.** **Split** is used to study that *same* ticker across two **timeframes**,
not to show two different tickers. Switching tickers drops the previous ticker's
data from memory (polars already lazy-scans, so this is just discarding the cached
frame).

### Design
- Config lives in **`watchlists.json`** at the **project root** (committed,
  manually edited — add/remove categories and folder paths here). Schema:
  `{ "version": 1, "watchlists": [ { "name": str, "folders": [abs paths] } ] }`.
  A watchlist may list **multiple folders** (e.g. `Index India` = `INDEX` + `index_c`).
- **Ticker resolution**: each watchlist carries an explicit **`symbols`** array
  (baked into `watchlists.json`, no runtime folder scanning — every folder holds
  exactly one `SYMBOL-1m.parquet` per symbol, so the symbol name == the file stem
  minus `-1m`). The backend resolves each symbol to a file by globbing
  `SYMBOL*.parquet` inside the watchlist's folder(s) (picks the first hit).
  **Equity India** ships with all 2006 symbols listed; trim it to the subset you
  want. To add or remove a ticker, edit `symbols` in `watchlists.json` (manually
  maintained).
  - **List order is the display order.** The frontend renders tickers in the same
    order they appear in `symbols` (do not re-sort alphabetically).
- **Backend is multi-file / on-demand.** `/api/meta`, `/api/data`, `/api/profile`
  take a ticker id (or file path), lazy-load + cache that parquet, and discard the
  previous frame on switch.
- **Profiles need no keying change.** `profile_path()` hashes the absolute file
  path, so each ticker keeps its own drawings/indicators regardless of how opened.
- Only one ticker in memory at a time; switching discards the previous frame.

### Status

All watchlist functionality is implemented and in production use:

- [x] `watchlists.json` with 7 categories (Index India, Equity India, Commodity,
      Crypto, Forex, Index foreign, Equity USA); each carries an explicit `symbols`
      list (generated by a one-time scan, manually maintained).
- [x] Backend: load `watchlists.json` + expose `/api/watchlists`.
- [x] Backend: `/api/open?wl=&sym=` resolves a ticker and lazy-loads it;
      `/api/meta` `/api/data` `/api/profile` serve the active file (previous frame
      dropped on switch).
- [x] `main()` / launch: starts **without** a file dialog; defaults to Nifty
      (Index India). A `python3 ohlc_viewer.py <file>` arg still opens that file.
- [x] Frontend: collapsible watchlist sidebar (filter box, drag-resize handle,
      per-group expand/collapse). Clicking a ticker calls `openTicker()`, which
      rebuilds the active view and applies that ticker's saved profile. The sidebar
      auto-highlights the currently open ticker.
- [x] Ticker naming resolved: symbol == file stem minus `-<tf>`; backend globs
      `SYMBOL*.parquet`.

**Out of scope (decided 2026-08-23):** per-view ticker tracking so Split could
show *two different tickers* with separate profiles. **Split is intentionally a
multi-timeframe study tool for a single ticker** — both panes always show the same
symbol at different timeframes. The `openTicker` reset-to-single-view behaviour is
by design, not a TODO.

## Project layout

| File | Purpose |
|---|---|
| `ohlc_viewer.py` | Python launcher: lazy-scans Parquet, serves local HTTP API, opens pywebview window. |
| `index.html` | Viewer page (light theme, toolbar, indicator + drawing menus, error overlay). |
| `app.js` | Frontend: KLineChart v10 data loader, windowed nav, zoom, indicator/overlay menus. |
| `indicators/` | Indicator plugins (`atr.js`, `kalman.js`, `harmonic.js`) + `util.js` math helpers. |
| `klinecharts.min.js` | Vendored chart library (offline). |
| `OHLC Viewer.webp` | App icon / favicon. |
| `build_macos.sh` | macOS `.app` packaging + `.parquet` UTI registration (system python). |

> **Runtime data (not in the repo):** per-file workspace profiles are written to
> `~/.ohlc_viewer/profiles/<hash>.json` (one JSON file per parquet, keyed by a
> SHA-256 of its absolute path). Watchlist config lives at
> `~/.ohlc_viewer/watchlists.json` (see the *Watchlists* section above).
> Watchlist config now lives at **`watchlists.json`** in the project root (committed,
> manually edited).

## KLineChart v10 API gotchas (all verified against the vendored bundle)

- `zoomAtPosition()` **does not exist**. Use `zoomAtCoordinate(scale, coord, ms)`,
  `zoomAtDataIndex()` or `zoomAtTimestamp()`.
- `removeIndicator()` takes a **filter object** (`{ paneId, name, id }`), not
  positional `(paneId, name)`. Passing a bare string removes *every* indicator.
- `createIndicator(value, isStack, paneOptions)` — `isStack: true` keeps existing
  indicators in the target pane; `false` wipes them.
- There is **no `klinecharts.getChart()`** export. `klinecharts.init(el)` returns
  the cached instance for an already-initialised element.
- Custom indicators: `calc(dataList, indicator)` must return an array **aligned
  with `dataList`** whose objects are keyed by `figures[].key`; the result lands on
  `indicator.result`. A `draw({ ctx, chart, indicator, bounding, xAxis, yAxis })`
  returning **truthy** replaces the default figure rendering. Use
  `xAxis.convertToPixel(dataIndex)` / `yAxis.convertToPixel(price)`.
- `chart.setPeriod()` / `setSymbol()` / `setDataLoader()` each reset the data and
  re-trigger an `init` load. `setDataLoader()` is the way to force a reload.

## Conventions / gotchas

- Frontend is **plain JS via globals** (`window.INDICATORS`, `window.INDU`,
  `klinecharts`), not modules — do not introduce a build step or imports
  without reworking `index.html`.
- Backend endpoints must stay JSON and use epoch-**seconds** `time`; `app.js`
  multiplies by 1000 because KLineChart timestamps are **milliseconds**.
- `index.html` has a full-screen error overlay plus a `window.pywebview.api.report`
  bridge so in-page JS errors surface in the terminal (pywebview does not forward
  the webview console).
- New indicator plugins must be added to both `index.html` (script tag) and
  `build_macos.sh` is already covered because it copies the whole `indicators/`
  folder.
