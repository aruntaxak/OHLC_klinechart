# OHLC Viewer (Taxak Capital)

A small, **standalone desktop candlestick viewer** for OHLC data stored in
**Parquet** files. It reads the file with [polars](https://pola.rs/), draws
true candlesticks with [KLineChart v10](https://klinecharts.com/) (vendored
locally for fully-offline use), and opens the chart in a native window via
[pywebview](https://github.com/r0x0r/pywebview).

## Features

- **Candlestick charts** (hollow candles, light theme) with a configurable
   **indicator** menu — the built-in KLineChart indicators (MA, EMA, SMA,
   Bollinger Bands, SAR, BBI, MACD, RSI, KDJ, CCI, Williams %R, DMI) **plus** custom
   plugins in `indicators/`: **ATR**, a **Kalman filter** overlay, a **Harmonic
   Patterns** scanner (Gartley / Butterfly / Bat / Crab), **Inside Bar** (outlines
   inside bars, coloured green/red by direction, with an optional `IB` label),
   **HHLL** (labels swing pivots HH / LL / HL / LH), and **Divergence** (detects
   regular bullish/bearish divergence across RSI, MACD, CCI, Stochastic, ROC and
   Williams %R, and lists every confirming oscillator so multiple confirmations
   are easy to read). Overlays draw on the price pane; oscillators (RSI, MACD, KDJ,
   CCI, WR, DMI, ATR) claim their own pane.
- **Per-indicator settings** — the settings panel shows meaningful parameter names
   (e.g. RSI's Short / Medium / Long periods, MACD's Fast / Slow / Signal) instead
   of "Param 1/2/…". The custom overlays (Inside Bar, HHLL, Divergence) also expose
   a **TF-apply** threshold so they only render on timeframes at or above a chosen
   value (e.g. 15m and above), staying invisible on lower timeframes.
- **Zoom / squeeze** — mouse wheel, the `+` / `−` buttons, the **Reset** button, or
  the `+` / `-` / `0` keys. Reset returns to the default zoom: a constant candle
  width (7 px) centred on the focused day.
- **Drag / pan** — drag the chart or the time axis. Panning past the loaded edge
  automatically fetches and appends/prepends more trading days through
  KLineChart's data loader.
- **Date navigation** — pick a day in the date box, or use the **Prev / Next**
  buttons / **← / →** arrow keys. The viewer keeps a sliding window of trading days
  on screen and recentres on the focused day. Jumping to a day outside the loaded
  window reloads the data around it. The **Latest** button jumps to the most recent
  trading day.
- **Split / Link** — **Split** opens a second chart side by side (e.g. to compare
  two timeframes); each pane is independent and the toolbar acts on the one you
  last clicked. **Link** (only with two panes) keeps the two panes' **centres
  aligned in time** while you pan, even at different timeframes. Turning Split off
  also switches Link off.
- **Drawing tools** — trend / horizontal / parallel / channel lines, segments,
  Fibonacci retracements, price lines and rectangles.
- **Workspace profiles (TradingView-style persistence)** — every drawing
  (trendline, channel, segment, fib, etc.) and every indicator (with its
  parameters and colours), plus the timeframe, focused day, zoom and Split/Link
  layout, is **saved per parquet file** and automatically restored the next time
  you open the same file. No manual "save" — changes autosave within ~1.5 s.
- **Crosshair legend** — hover to read O/H/L/C and the timestamp (rendered via
  KLineChart's built-in candle tooltip).
- Works **fully offline** (the chart library is vendored locally).

## Indicators

Indicators are registered directly with KLineChart. The built-ins come from
KLineChart's own registry; the custom ones live in the `indicators/` folder, each
file self-registers via `klinecharts.registerIndicator(...)` **and** pushes an
entry onto the global `window.INDICATORS` array (loaded by `index.html`). Adding a
new one is just dropping a file there (and a `<script>` tag in `index.html`) — no
build step:

```js
klinecharts.registerIndicator({
  name: 'MyInd', shortName: 'My Indicator',
  series: 'price', shouldOhlc: true,            // overlay on the candle pane
  calcParams: [20], precision: 2,
  figures: [{ key: 'myval', title: 'My: ', type: 'line' }],
  calc(dataList, indicator) {
    const p = indicator.calcParams[0] | 0;
    return dataList.map((b, i) => ({ myval: i < p ? null : /* … */ }));
  },
});
window.INDICATORS = window.INDICATORS || [];
window.INDICATORS.push({ name: 'MyInd', label: 'My Indicator', overlay: true });
```

Shared math helpers (swing pivots, range checks) live in `indicators/util.js`
(`window.INDU`).

The **Harmonic Patterns** entry is a good template for custom *drawn* indicators:
it returns `true` from a `draw({ ctx, chart, indicator, xAxis, yAxis })` hook to
replace KLineChart's default figure rendering and paints directly onto the canvas.

## Requirements

- Python 3.10+
- `polars` and `pywebview` (in the **system `python3`** — the current macOS
  build wraps this interpreter rather than bundling one):
  ```bash
  pip install polars pywebview
  ```
  (`pywebview` uses the system webview: built in on macOS; on Linux install
  `webkit2gtk`; on Windows use the Edge WebView2 runtime.)

## Usage

Open a file directly:

```bash
python ohlc_viewer.py /path/to/data.parquet
```

Or run it with no argument — it opens the **watchlist** sidebar (defaulting to
Nifty), from which you pick a ticker:

```bash
python ohlc_viewer.py
```

### Expected Parquet schema

The loader auto-detects columns. It supports either:

- A **`Date`** (e.g. `01-01-2008` or `2008-01-01`) **+ `Time`** (`09:54`) pair, **and**
  `Open` / `High` / `Low` / `Close` columns, **or**
- A single **`Datetime`** column plus `Open` / `High` / `Low` / `Close`.

Column names are matched case-insensitively (e.g. `open`, `OPEN`, `Close` all work).

## Keyboard & mouse shortcuts

| Action | Mouse | Button | Key |
|---|---|---|---|
| Zoom in / squeeze | Wheel up | `+` | `+` / `=` |
| Zoom out / expand | Wheel down | `−` | `-` / `_` |
| Reset zoom to default | — | `Reset` | `0` |
| Previous trading day | — | `Prev` | `←` |
| Next trading day | — | `Next` | `→` |
| Jump to most recent day | — | `Latest` | — |
| Toggle indicators menu | — | `Indicators` | `i` |
| Toggle Split (second pane) | — | `▣ Split` | — |
| Toggle Link (align pane centres) | — | `Link` | — |
| Pan | Drag chart / time axis | — | — |
| Read O/H/L/C | Hover crosshair | — | — |

## Data windowing note

Large files (e.g. years of 1-minute bars) are loaded entirely into memory once,
but only a **sliding window of trading days** (scaled by timeframe so the on-screen
bar count stays constant) is sent to the chart at a time — so loading is instant
and the chart stays smooth. Panning past the loaded edge automatically fetches
more days through KLineChart's data loader. The date axis shows real market
timestamps
(Indian market hours display in IST wall-clock time via a UTC-label trick); the
overnight break between sessions appears as a normal intraday gap.

## Workspace profiles (saved drawings & indicators)

The viewer remembers your work **per parquet file**, like a TradingView profile.
Everything you do on the chart is automatically persisted:

- **Drawings** — trendlines, channels, segments, horizontal/parallel lines,
  Fibonacci retracements, price lines, rectangles.
- **Indicators** — which are enabled, their calc parameters, and their colours.
- **Layout** — the timeframe, the focused trading day, the candle width/zoom,
  and the Split / Link state.

When you reopen the **same** parquet file, the exact same drawings, indicators
and layout are restored — no manual save step. Changes autosave within ~1.5 s
of the last edit (and immediately for discrete actions like toggling an
indicator or drawing a line).

Profiles are stored on disk as **one JSON file per parquet**, keyed by a SHA-256
hash of the file's absolute path:

```
~/.ohlc_viewer/profiles/<hash>.json
```

Deleting a profile file simply clears the saved workspace for that parquet; the
viewer will start blank for it next time.

## macOS: "Open With" on .parquet

`build_macos.sh` wraps the app into an `.app` and registers it to open Parquet
files via Finder's **Open With**. No PyInstaller, no bundled interpreter — it
copies `ohlc_viewer.py` + the static assets (`index.html`, `app.js`, the
vendored chart lib, icon, `indicators/`) into
`/Applications/OHLC Viewer.app/Contents/Resources` and runs them with the
**system `python3`** (so `polars` / `pywebview` / `tkinter` must be installed
there). It patches `Info.plist` with a `.parquet` UTI and registers the
association with `lsregister`.

```bash
bash build_macos.sh
```

Result: `/Applications/OHLC Viewer.app`, self-contained except for the Python
libraries (runtime log at `/tmp/OHLC Viewer.log`). Supports right-click →
**Open With → OHLC Viewer**; the opened path arrives as the first argument.

## Project layout

| File | Purpose |
|---|---|
| `ohlc_viewer.py` | Python launcher: loads Parquet, serves data over a local HTTP API, opens the pywebview window. |
| `index.html` | Viewer page (light theme, toolbar, legend, indicators menu). |
| `app.js` | Frontend (KLineChart v10: candles, windowed data-loader navigation, pan-fetch, zoom, indicator/overlay menus). |
| `indicators/` | Indicator plugins (ATR, Kalman, Harmonic, Inside Bar, HHLL, Divergence) + `util.js` math helpers (self-registering). |
| `klinecharts.min.js` | Vendored chart library (offline). |
| `OHLC Viewer.webp` | App icon / favicon. |
| `build_macos.sh` | macOS `.app` packaging + `.parquet` UTI registration (**system python**). |

> **Runtime data (not in the repo):** per-file workspace profiles are written to
> `~/.ohlc_viewer/profiles/<hash>.json` (one JSON file per parquet, keyed by a
> SHA-256 of its absolute path).

## License

KLineChart is licensed under the Apache-2.0 license; this viewer embeds a vendored
copy for fully-offline use under that license.
