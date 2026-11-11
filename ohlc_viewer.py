"""Standalone OHLC candlestick viewer.

Reads an OHLC parquet file with polars, serves candlestick data to a local
web page (KLineChart v10), and opens it in a native pywebview window.

Usage:
    python ohlc_viewer.py [path/to/file.parquet]

If no path is given, the app opens with Nifty (Index India) by default; the
watchlist sidebar drives which ticker is displayed. When a .parquet path is
passed as argv[1], that file is opened directly instead.

Only one trading day is sent to the browser at a time (the data file can hold
years of 1-minute bars), so loading is instant and the chart stays smooth.
"""
import os
import sys
import json
import time
import hashlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

# polars is imported lazily (see _ensure_polars) so that launching the app and
# showing the file picker stays fast; the heavy import only happens once a
# parquet file is actually chosen.

BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
PARQUET_PATH = None          # set by main() before the server starts
DF = None                    # loaded polars frame (with _day / _ts helpers)
META = {"symbol": "", "dates": [], "minDate": "", "maxDate": "", "totalBars": 0}
WATCHLISTS = []               # loaded from watchlists.json (see load_watchlists)

# Per-file "profile" (TradingView-style): the drawings (overlays) and indicator
# state for a parquet file. One small JSON file per parquet, stored in a hidden
# profiles folder and keyed by a hash of the file's absolute path, so re-opening
# the same file restores its workspace. See save_profile / load_profile.
PROFILES_DIR = os.path.join(os.path.expanduser("~"), ".ohlc_viewer", "profiles")


def profile_path():
    if not PARQUET_PATH:
        return None
    key = hashlib.sha256(os.path.abspath(PARQUET_PATH).encode("utf-8")).hexdigest()[:32]
    return os.path.join(PROFILES_DIR, key + ".json")


def save_profile(data):
    p = profile_path()
    if not p:
        return
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
    except Exception as e:
        print("[profile] save failed:", e, flush=True)


def load_profile():
    p = profile_path()
    if not p or not os.path.isfile(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception as e:
        print("[profile] load failed:", e, flush=True)
        return {}

DATE_FORMATS = ["%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"]
TIME_FORMATS = ["%H:%M", "%H:%M:%S"]

_pl = None


def _ensure_polars():
    """Import polars once, on demand."""
    global _pl
    if _pl is None:
        import polars as _pl
    return _pl


def _pick(df, names):
    """Pick a column by exact lower-cased name, then by substring."""
    cols = df.collect_schema().names()
    low = {c.lower(): c for c in cols}
    for n in names:
        if n in low:
            return low[n]
    for n in names:
        for c in cols:
            if n in c.lower():
                return c
    return None


def _parse_date(col):
    for fmt in DATE_FORMATS:
        try:
            return col.str.strptime(_pl.Date, fmt)
        except Exception:
            continue
    return None


def _parse_time(col):
    for fmt in TIME_FORMATS:
        try:
            return col.str.strptime(_pl.Time, fmt)
        except Exception:
            continue
    return None


def load_parquet(path):
    """Prepare per-day OHLC data from a parquet file.

    Uses a lazy scan so the full dataset is NOT materialised into RAM. Only the
    metadata scan at load and each /api/data window request read from disk.
    """
    global DF, META, PARQUET_PATH
    _ensure_polars()
    PARQUET_PATH = path
    df = _pl.scan_parquet(path)

    schema = df.collect_schema()
    date_col = _pick(df, ["date"])
    time_col = _pick(df, ["time"])

    # Determine the timestamp + day source. We always end up with two
    # expressions: `dt_expr` (a Datetime) and `_ts_expr` (epoch SECONDS, Int64).
    if date_col and time_col:
        d = _parse_date(_pl.col(date_col))
        t = _parse_time(_pl.col(time_col))
        if d is None or t is None:
            raise ValueError("Could not parse Date/Time columns as strings.")
        # Date + Time: promote date to datetime, then add the time as a duration.
        dt_expr = (d.cast(_pl.Datetime("us")) + t.cast(_pl.Time).cast(_pl.Duration("us"))).cast(_pl.Datetime("us"))
        _ts_expr = dt_expr.dt.timestamp("ms").cast(_pl.Int64) // 1000
    else:
        cols = schema.names()
        dtypes = schema.dtypes()
        dt_col = next((cols[i] for i in range(len(cols)) if str(dtypes[i]).startswith("Datetime")), None)
        if dt_col is not None:
            # A real Datetime column.
            dt_expr = _pl.col(dt_col).cast(_pl.Datetime("us"))
            _ts_expr = dt_expr.dt.timestamp("ms").cast(_pl.Int64) // 1000
        elif time_col is not None:
            # Numeric epoch column (e.g. Crypto 'Time' as seconds; milliseconds
            # if the values are huge). Values like 1502942464 are seconds.
            raw = _pl.col(time_col).cast(_pl.Float64)
            secs = (_pl.when(raw > 1e11).then(raw / 1000.0).otherwise(raw)).cast(_pl.Int64)
            dt_expr = _pl.from_epoch(secs, time_unit="s")
            _ts_expr = secs
        else:
            raise ValueError(
                "No usable date/time columns found. Expected 'Date'+'Time' "
                "strings, a Datetime column, or a numeric epoch 'Time' column."
            )

    df = df.with_columns(
        dt_expr.dt.strftime("%Y-%m-%d").alias("_day"),
        _ts_expr.alias("_ts"),
    )

    open_c = _pick(df, ["open"])
    high_c = _pick(df, ["high"])
    low_c = _pick(df, ["low"])
    close_c = _pick(df, ["close"])
    if not (open_c and high_c and low_c and close_c):
        raise ValueError("Could not find Open/High/Low/Close columns.")

    df = df.select(["_day", "_ts", open_c, high_c, low_c, close_c]).rename(
        {open_c: "open", high_c: "high", low_c: "low", close_c: "close"}
    )
    df = df.drop_nulls(subset=["_ts", "open", "high", "low", "close"])
    df = df.sort("_ts")

    # Validate date parsing on a single row before relying on lazy evaluation
    # (lazy expressions don't raise until collected, so surface errors early).
    try:
        df.select("_ts").head(1).collect()
    except Exception as e:
        raise ValueError(f"Could not parse the date/time columns: {e}")

    # Metadata: collect ONLY the derived _day column (unique + count). The full
    # dataset is never held in memory as a DataFrame.
    dates = df.select("_day").unique().sort("_day").collect()["_day"].to_list()
    total_bars = df.select(_pl.len()).collect().item()
    symbol = os.path.splitext(os.path.basename(path))[0]

    DF = df  # LazyFrame — materialised per request, not stored whole
    META = {
        "symbol": symbol,
        "dates": dates,
        "minDate": dates[0] if dates else "",
        "maxDate": dates[-1] if dates else "",
        "totalBars": total_bars,
    }


# Seconds per timeframe bucket (intraday). "1D" is handled separately as one
# bar per trading day.
TF_SECONDS = {1: 60, 5: 300, 15: 900, 30: 1800, 60: 3600}


def bars_for_range_tf(from_date, to_date, tf):
    """Bars for an inclusive range of trading days (YYYY-MM-DD), optionally
    resampled to `tf` minutes (aggregated from the base 1-minute data). `tf`
    may also be the string "1D" for daily bars."""
    if DF is None:
        return []
    tf = int(tf) if str(tf).isdigit() else str(tf)
    df = DF.filter((_pl.col("_day") >= from_date) & (_pl.col("_day") <= to_date))

    if tf == "1D":
        # One candlestick per trading day. Drop the group key (_day) and keep the
        # columns in the same [_ts, open, high, low, close] order as the other
        # branches, otherwise iter_rows() would put the date string first and
        # "time": int(r[0]) would raise.
        df = (
            df.sort("_ts")
            .group_by("_day", maintain_order=True)
            .agg([
                _pl.col("_ts").first().alias("_ts"),
                _pl.col("open").first().alias("open"),
                _pl.col("high").max().alias("high"),
                _pl.col("low").min().alias("low"),
                _pl.col("close").last().alias("close"),
            ])
            .select(["_ts", "open", "high", "low", "close"])
            .sort("_ts")
        )
    elif tf != 1:
        sec = TF_SECONDS.get(tf, 60)
        df = (
            df.sort("_ts")
            .with_columns((_pl.col("_ts") // sec * sec).alias("_bucket"))
            .group_by("_bucket", maintain_order=True)
            .agg([
                _pl.col("open").first().alias("open"),
                _pl.col("high").max().alias("high"),
                _pl.col("low").min().alias("low"),
                _pl.col("close").last().alias("close"),
            ])
            .rename({"_bucket": "_ts"})
            .sort("_ts")
        )
    else:
        df = df.select(["_ts", "open", "high", "low", "close"]).sort("_ts")

    df = df.collect()
    return [
        {
            "time": int(r[0]),
            "open": float(r[1]),
            "high": float(r[2]),
            "low": float(r[3]),
            "close": float(r[4]),
        }
        for r in df.iter_rows()
    ]


def load_watchlists():
    """Read watchlists.json (project root) into the module-level WATCHLISTS."""
    global WATCHLISTS
    p = os.path.join(BASE_DIR, "watchlists.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            WATCHLISTS = json.load(f).get("watchlists", [])
    except Exception as e:
        print("[watchlists] load failed:", e, flush=True)
        WATCHLISTS = []


def resolve_ticker_file(wl_name, sym):
    """Find the parquet file for a (watchlist, symbol) pair.

    Globs `SYMBOL*.parquet` inside the watchlist's folder(s). Falls back to
    searching every watchlist folder if the named watchlist isn't found.
    """
    folders = []
    for wl in WATCHLISTS:
        if wl.get("name") == wl_name:
            folders = wl.get("folders", [])
            break
    if not folders:
        folders = [f for wl in WATCHLISTS for f in wl.get("folders", [])]
    import glob
    for folder in folders:
        matches = sorted(glob.glob(os.path.join(folder, sym + "*.parquet")))
        if matches:
            return matches[0]
    return None


def bars_for_range(from_date, to_date):
    return bars_for_range_tf(from_date, to_date, 1)





def bars_for_day(date_str):
    return bars_for_range_tf(date_str, date_str, 1)


STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            self._send(200, open(os.path.join(BASE_DIR, "index.html"), "rb").read())
        elif path == "/api/meta":
            self._send(200, json.dumps(META), "application/json")
        elif path == "/api/profile":
            self._send(200, json.dumps(load_profile()), "application/json")
        elif path == "/api/data":
            tf = qs.get("tf", ["1"])[0]
            if "from" in qs and "to" in qs:
                bars = bars_for_range_tf(qs["from"][0], qs["to"][0], tf)
            elif "date" in qs:
                bars = bars_for_range_tf(qs["date"][0], qs["date"][0], tf)
            else:
                bars = []
            self._send(200, json.dumps({"bars": bars}), "application/json")
        elif path == "/api/watchlists":
            try:
                wl_path = os.path.join(BASE_DIR, "watchlists.json")
                with open(wl_path, "r", encoding="utf-8") as _f:
                    self._send(200, _f.read(), "application/json")
            except Exception as e:
                self._send(500, json.dumps({"error": str(e)}), "application/json")
        elif path == "/api/open":
            wl = qs.get("wl", [""])[0]
            sym = qs.get("sym", [""])[0]
            if not wl or not sym:
                self._send(400, json.dumps({"error": "wl and sym required"}), "application/json")
                return
            fp = resolve_ticker_file(wl, sym)
            if not fp or not os.path.isfile(fp):
                self._send(404, json.dumps({"error": "no file for " + wl + "/" + sym}), "application/json")
                return
            try:
                load_parquet(fp)
            except Exception as e:
                self._send(500, json.dumps({"error": str(e)}), "application/json")
                return
            self._send(200, json.dumps(META), "application/json")
        elif path.startswith("/"):
            rel = unquote(path[1:].split("?")[0])
            full = os.path.realpath(os.path.join(BASE_DIR, rel))
            base = os.path.realpath(BASE_DIR)
            if not (full.startswith(base + os.sep) or full == base):
                self._send(404, "not found")
                return
            if not os.path.isfile(full):
                self._send(404, "not found")
                return
            ext = os.path.splitext(full)[1].lower()
            ctype = STATIC_TYPES.get(ext, "application/octet-stream")
            self._send(200, open(full, "rb").read(), ctype)
        else:
            self._send(404, "<h1>Not Found</h1>")

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/profile":
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b""
                data = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception as e:
                self._send(400, json.dumps({"ok": False, "error": str(e)}), "application/json")
                return
            save_profile(data)
            self._send(200, json.dumps({"ok": True}), "application/json")
        else:
            self._send(404, "not found")

    def log_message(self, *args):
        pass


def pick_file():
    """Show a native macOS file picker.

    tkinter's filedialog is unreliable when the app is launched from a .app
    bundle (the dialog flashes and closes immediately), so we use the system
    'choose file' AppleScript dialog instead.
    """
    import subprocess

    script = (
        'try\n'
        '  set f to choose file of type {"parquet"} '
        'with prompt "Open an OHLC parquet file"\n'
        '  return POSIX path of f\n'
        'on error\n'
        '  return ""\n'
        'end try'
    )
    try:
        out = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=300,
        )
        path = out.stdout.strip()
        return path or None
    except Exception:
        return None


# macOS delivers a file opened via double-click / "Open With" as an
# kAEOpenDocuments Apple Event. A script-wrapped app never receives it as
# argv, and a raw NSAppleEventManager handler is unreliable here; however,
# Tk's Cocoa backend routes that event to the "::tk::mac::OpenDocument"
# command. We spin up a hidden Tk root briefly to capture the path (the same
# trick ParquetViewer uses). ParquetViewer uses this; it is the reliable way.
_OPENED_FILES = []
_tk_root = None


def _on_open_document(*paths):
    global _tk_root
    for p in paths:
        _OPENED_FILES.append(p)
    if _tk_root is not None:
        try:
            _tk_root.quit()
        except Exception:
            pass


def _capture_open_document(timeout=1.0):
    """Capture a file delivered via Open With / double-click, if any."""
    global _tk_root
    try:
        import tkinter as tk

        root = tk.Tk()
        root.withdraw()
        _tk_root = root
        root.createcommand("::tk::mac::OpenDocument", _on_open_document)
        root.after(int(timeout * 1000), root.quit)
        root.mainloop()
        try:
            root.destroy()
        except Exception:
            pass
    except Exception:
        pass
    _tk_root = None
    return list(_OPENED_FILES)


def main():
    load_watchlists()

    path = None
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        path = sys.argv[1]
    if not path:
        # Default launch: open Nifty from the Index India watchlist (no file
        # picker). The watchlist sidebar then drives which ticker is displayed.
        path = resolve_ticker_file("Index India", "NIFTY")
    if not path:
        # Fallback: first symbol of the first watchlist that resolves to a file.
        for wl in WATCHLISTS:
            for s in (wl.get("symbols") or []):
                fp = resolve_ticker_file(wl["name"], s)
                if fp:
                    path = fp
                    break
            if path:
                break
    if not path or not os.path.isfile(path):
        print("No data to open (no ticker resolved). Exiting.")
        return

    print(f"Loading {path} …")
    try:
        load_parquet(path)
    except Exception as e:
        print(f"Failed to load parquet: {e}")
        return
    print(f"Loaded {META['totalBars']} bars, {len(META['dates'])} trading days "
           f"({META['minDate']} … {META['maxDate']})")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"OHLC Viewer serving at {url}")

    import webview

    # Bridge so the in-page JS can surface errors/progress to this terminal
    # (pywebview does not forward the webview console by default).
    class JsApi:
        def report(self, msg):
            print("[webview]", msg, flush=True)

    webview.create_window(
        f"{META['symbol']} - OHLC Viewer", url, js_api=JsApi(), width=1280, height=800
    )
    webview.start()
    server.shutdown()
    print("Shutting down.")


if __name__ == "__main__":
    main()
