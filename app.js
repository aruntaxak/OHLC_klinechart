// OHLC Viewer — KLineChart v10 frontend (supports Split + Link).
//
// Reuses the existing Python/polars backend (ohlc_viewer.py) which serves
//   GET /api/meta                -> { symbol, dates[], minDate, maxDate, totalBars }
//   GET /api/data?from=&to=&tf=  -> { bars: [{time(epoch SECONDS), open, high, low, close}] }
//
// KLineChart pulls data through a DataLoader (setDataLoader -> getBars). It calls
// getBars with type 'init' (first load), 'forward' (panned past the OLDEST bar,
// bars are PREPENDED) and 'backward' (panned past the NEWEST bar, bars are
// APPENDED). Those names are the opposite of what you'd guess — verified in
// klinecharts.min.js (_addData: forward => data.concat(list), backward =>
// list.concat(data)). Do not "fix" them.
//
// Timestamps: the backend turns naive Date+Time into epoch seconds as if the
// wall-clock were UTC. Rendering the chart in the 'UTC' timezone therefore shows
// the original (IST) wall-clock labels. Do not change this to a real timezone.
//
// A "view" is one KLineChart instance in its own pane of the split. Split shows
// two views side by side (e.g. different timeframes). Link keeps the two views'
// CENTRES aligned in time while panning, even at different timeframes.

(function () {
    'use strict';

    const BASE_DAYS = 5;            // window width (trading days) at the 1m base
    const DEFAULT_CANDLE_PX = 7;    // target candle width for default/reset zoom
    const MAIN_PANE = 'candle_pane';
    const UP = '#26a69a', DOWN = '#ef5350';

    const TF_OPTIONS = ['1', '5', '15', '30', '60', '1D'];
    const TF_LABEL = { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '60m', '1D': '1D' };
    const TF_MIN = { '1': 1, '5': 5, '15': 15, '30': 30, '60': 60, '1D': 390 };

    // Built-in KLineChart indicators. `overlay` draws on the price pane; otherwise
    // it claims its own pane. Volume-based indicators are absent (no volume column).
    // ATR is NOT a built-in — it ships as a plugin in indicators/.
    const BUILTIN_INDICATORS = [
        { name: 'MA', label: 'MA', overlay: true },
        { name: 'EMA', label: 'EMA', overlay: true },
        { name: 'SMA', label: 'SMA', overlay: true },
        { name: 'BOLL', label: 'Bollinger Bands', overlay: true },
        { name: 'SAR', label: 'Parabolic SAR', overlay: true },
        { name: 'BBI', label: 'BBI', overlay: true },
        { name: 'MACD', label: 'MACD', overlay: false },
        { name: 'RSI', label: 'RSI', overlay: false },
        { name: 'KDJ', label: 'KDJ (Stochastic)', overlay: false },
        { name: 'CCI', label: 'CCI', overlay: false },
        { name: 'WR', label: 'Williams %R', overlay: false },
        { name: 'DMI', label: 'DMI', overlay: false },
    ];

    // Human-readable labels for each indicator's calcParams, so the settings
    // panel shows what a parameter means instead of "Param 1/2/…". Keyed by the
    // indicator name; any index not listed falls back to "Param N".
    const INDICATOR_PARAM_LABELS = {
        MA: ['MA1 Period', 'MA2 Period', 'MA3 Period', 'MA4 Period'],
        EMA: ['EMA1 Period', 'EMA2 Period', 'EMA3 Period'],
        SMA: ['Period', 'Smoothing'],
        BOLL: ['Middle Period', 'Std Dev Multiplier'],
        BBI: ['MA Period 1', 'MA Period 2', 'MA Period 3', 'MA Period 4'],
        CCI: ['Period'],
        DMI: ['Period', 'Smoothing'],
        MACD: ['Fast EMA', 'Slow EMA', 'Signal Period'],
        RSI: ['Short Period', 'Medium Period', 'Long Period'],
        KDJ: ['RSV Period', 'K Smoothing', 'D Smoothing'],
        SAR: ['Initial AF', 'AF Step', 'Max AF'],
        WR: ['WR1 Period', 'WR2 Period', 'WR3 Period'],
        ATR: ['Period'],
        KALMAN: ['Process Noise (Q)', 'Measurement Noise (R)'],
        HARMONIC: ['Pivot Lookback'],
        HHLL: ['Pivot Lookback'],
        DIVERGENCE: ['Pivot Lookback'],
    };

    const OVERLAYS = [
        { name: 'horizontalStraightLine', label: 'Horizontal line' },
        { name: 'segment', label: 'Segment' },
        { name: 'straightLine', label: 'Trend line' },
        { name: 'priceChannelLine', label: 'Price channel' },
        { name: 'parallelStraightLine', label: 'Parallel lines' },
        { name: 'fibonacciLine', label: 'Fibonacci retracement' },
        { name: 'priceLine', label: 'Price line' },
        { name: 'rect', label: 'Rectangle' },
    ];

    const app = {
        dates: [], symbol: '', totalBars: 0,
        focusIdx: null,                 // day the navigation is centred on
        split: false, linked: false,
        views: [], activeView: null, uid: 0,
        drawColor: '#2962ff',           // current colour for new drawing tools
        pricePrecision: 2,              // decimals shown on the price axis (auto-detected)
    };

    const $ = (id) => document.getElementById(id);
    function setStatus(m) { $('status').textContent = m || ''; }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function dayStartMs(d) { return Date.parse(d + 'T00:00:00Z'); }
    function lastIdx() { return app.dates.length - 1; }

    function report(m) {
        try { if (window.pywebview && window.pywebview.api) window.pywebview.api.report(String(m)); } catch (_) {}
        console.log('[kl]', m);
    }

    // ----- timeframe <-> KLineChart period -----

    function tfToPeriod(tf) {
        if (tf === '1D') return { type: 'day', span: 1 };
        return { type: 'minute', span: parseInt(tf, 10) };
    }
    function periodToTf(p) {
        if (p && p.type === 'day') return '1D';
        return String((p && p.span) || 1);
    }

    function initDays(tf) {
        if (tf === '1D') return Math.max(1, Math.min(500, app.dates.length));
        return Math.max(1, BASE_DAYS * (TF_MIN[tf] || 1));
    }
    function chunkDays(tf) {
        if (tf === '1D') return Math.max(1, app.dates.length);
        return Math.max(1, Math.ceil(initDays(tf) / 2));
    }

    function toKL(bars) {
        return bars.map((b) => ({
            timestamp: b.time * 1000,
            open: b.open, high: b.high, low: b.low, close: b.close,
        }));
    }

    // Auto-detect how many decimals the price axis needs (Forex ~1.08 needs 4-5,
    // BTC ~60000 needs 2). Based on the largest close in the most recent day.
    function pricePrecisionFor(maxPrice) {
        if (maxPrice >= 1000) return 2;
        if (maxPrice >= 100) return 3;
        if (maxPrice >= 1) return 4;
        if (maxPrice > 0) return 6;
        return 2;
    }
    async function detectPrecision(tf) {
        try {
            const last = lastIdx();
            const bars = await fetchRange(app.dates[last], app.dates[last], tf);
            let mx = 0;
            for (const b of bars) if (b && b.close > mx) mx = b.close;
            return mx > 0 ? pricePrecisionFor(mx) : 2;
        } catch (e) { return 2; }
    }

    async function fetchRange(from, to, tf) {
        const url = '/api/data?from=' + encodeURIComponent(from) +
                    '&to=' + encodeURIComponent(to) + '&tf=' + encodeURIComponent(tf);
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        return j.bars || [];
    }

    // ----- data loader -----

    // Day-index window of width `span` centred on `center`, shifted to stay inside
    // [0, lastIdx()].
    function windowAround(center, span) {
        const last = lastIdx();
        span = Math.min(span, app.dates.length);
        const half = Math.floor(span / 2);
        let from = center - half;
        let to = from + span - 1;
        if (from < 0) { to -= from; from = 0; }
        if (to > last) { from -= (to - last); to = last; }
        return [Math.max(0, from), Math.min(last, to)];
    }

    // The data loader is per-view: it closes over `view` so each chart maintains
    // its own loaded day-window. KLineChart expects the loader to be an OBJECT
    // with a `getBars(params)` method (not a bare function).
    function makeLoader(view) {
        return {
            getBars: async function getBars(params) {
                const tf = periodToTf(params.period);
                const last = lastIdx();
                try {
                    if (params.type === 'init') {
                        const center = (view.focusIdx == null) ? last : view.focusIdx;
                        const [from, to] = windowAround(center, initDays(tf));
                        view.loadedFrom = from; view.loadedTo = to;
                        const bars = await fetchRange(app.dates[from], app.dates[to], tf);
                        params.callback(toKL(bars), { forward: from > 0, backward: to < last });
                        afterLoad(view, tf);
                        return;
                    }
                    if (params.type === 'forward') {
                        if (view.loadedFrom <= 0) { params.callback([], { forward: false }); return; }
                        const newFrom = Math.max(0, view.loadedFrom - chunkDays(tf));
                        const bars = await fetchRange(app.dates[newFrom], app.dates[view.loadedFrom - 1], tf);
                        view.loadedFrom = newFrom;
                        params.callback(toKL(bars), { forward: view.loadedFrom > 0 });
                        afterLoad(view, tf);
                        return;
                    }
                    if (params.type === 'backward') {
                        if (view.loadedTo >= last) { params.callback([], { backward: false }); return; }
                        const newTo = Math.min(last, view.loadedTo + chunkDays(tf));
                        const bars = await fetchRange(app.dates[view.loadedTo + 1], app.dates[newTo], tf);
                        view.loadedTo = newTo;
                        params.callback(toKL(bars), { backward: view.loadedTo < last });
                        afterLoad(view, tf);
                        return;
                    }
                    params.callback([], false);
                } catch (e) {
                    report('getBars ' + params.type + ': ' + (e && e.message ? e.message : e));
                    setStatus('Data error: ' + (e && e.message ? e.message : e));
                    params.callback([], false);
                }
            },
        };
    }

    function afterLoad(view, tf) {
        setTimeout(() => {
            if (view.pendingProfile) {
                const pv = view.pendingProfile; view.pendingProfile = null;
                applyViewProfile(view, pv);
                markProfileReady();
                return;
            }
            if (view.pendingFocus != null) {
                const idx = view.pendingFocus; view.pendingFocus = null;
                centreOnDay(view, idx, 0);
            }
            if (view.pendingIndicators) {
                const list = view.pendingIndicators; view.pendingIndicators = null;
                applyIndicators(view, list);
            }
            // A timeframe switch changed the apply-threshold eligibility; recreate
            // the indicators so TF-apply (minTf) is re-evaluated. Skipped on normal
            // panning loads, which also funnel through afterLoad.
            if (view._tfChanged) {
                view._tfChanged = false;
                applyIndicators(view, view.indicators);
            }
            updateStatus();
        }, 0);
    }

    function updateStatus() {
        if (!app.dates.length) { setStatus('No data.'); return; }
        const v = app.activeView;
        if (!v) return;
        const tf = v.tf;
        const n = v.chart ? v.chart.getDataList().length : 0;
        let extra = '';
        if (app.split && app.views.length > 1)
            extra = '  •  selected: pane ' + (app.views.indexOf(v) + 1);
        setStatus(app.symbol + '  •  ' + app.dates[v.loadedFrom] + ' → ' + app.dates[v.loadedTo] +
                  '  •  ' + (v.loadedTo - v.loadedFrom + 1) + ' of ' + app.dates.length + ' days' +
                  '  •  ' + n + ' bars @ ' + TF_LABEL[tf] + extra);
    }

    // ----- navigation -----

    // Scroll so `idx`'s trading day sits in the middle of the viewport. Returns
    // false when that day isn't in the loaded data.
    function centreOnDay(view, idx, anim) {
        const chart = view.chart;
        if (!chart || idx == null || !app.dates[idx]) return false;
        const list = chart.getDataList();
        if (!list.length) return false;
        const t0 = dayStartMs(app.dates[idx]);
        const t1 = t0 + 86400000;
        let first = -1, lastBar = -1;
        for (let i = 0; i < list.length; i++) {
            const ts = list[i].timestamp;
            if (ts >= t0 && ts < t1) { if (first < 0) first = i; lastBar = i; }
            else if (ts >= t1) break;
        }
        if (first < 0) return false;
        const vr = chart.getVisibleRange();
        const visible = vr ? Math.max(1, Math.round(vr.to - vr.from)) : 1;
        const dayCount = lastBar - first + 1;
        let target;
        if (dayCount <= visible) {
            // Whole day fits on screen: keep it centred (as on 5m).
            const mid = Math.floor((first + lastBar) / 2);
            target = mid + Math.floor(visible / 2);
        } else {
            // Day is wider than the viewport: pin its first bar (09:15) to the
            // left edge (offset 15 bars of breathing room) so it's visible
            // without dragging. scrollToDataIndex anchors its argument at the
            // right edge, so offset by `visible`.
            target = first - 15 + visible;
        }
        const tgt = Math.max(0, Math.min(list.length - 1, target));
        chart.scrollToDataIndex(tgt, anim || 0);
        return true;
    }

    function reinit(view, focusIdx) {
        view.pendingFocus = (focusIdx == null) ? null : focusIdx;
        view.chart.setDataLoader(view.loader);   // resetData() -> 'init' load
    }

    function navTo(idx) {
        idx = clamp(idx, 0, lastIdx());
        app.focusIdx = idx;
        $('dateInput').value = app.dates[idx];
        const v = app.activeView;
        if (!v) return;
        v.focusIdx = idx;
        if (idx >= v.loadedFrom && idx <= v.loadedTo && centreOnDay(v, idx, 200)) { updateStatus(); scheduleSave(); return; }
        reinit(v, idx);
        scheduleSave();
    }

    // ----- zoom -----

    function chartCentreX(view) {
        const el = view ? view.el : $('chart');
        return { x: (el && el.clientWidth ? el.clientWidth : 800) / 2, y: 0 };
    }

    function zoom(factor) {
        const v = app.activeView; if (!v || !v.chart) return;
        try { v.chart.zoomAtCoordinate(factor, chartCentreX(v), 0); } catch (e) { report('zoom: ' + e.message); }
    }

    // Clear any manual (scroll-zoomed) price-axis scaling so Reset restores the
    // auto-fit Y axis. Scrolling the mouse over the price axis calls setRange() on
    // the y-axis component, which flips its autoCalcTickFlag to false and stores a
    // manual range (it does NOT set the pane-level isManualYAxis flag). buildTicks()
    // only recomputes the range from the visible data when autoCalcTickFlag is true,
    // so we flip every component's flag back on and force a redraw with chart.resize()
    // (its layout runs with buildYAxisTick:true).
    function resetYAxisScale(view) {
        try {
            const chart = view.chart; if (!chart) return;
            const panes = chart.getDrawPanes ? chart.getDrawPanes() : [];
            panes.forEach((pane) => {
                if (!pane || !pane.getYAxisComponents) return;
                (pane.getYAxisComponents() || []).forEach((c) => {
                    if (c.getAutoCalcTickFlag && !c.getAutoCalcTickFlag()) {
                        c.setAutoCalcTickFlag(true);
                    }
                });
                // Also clear any pane-level manual y-axis (e.g. custom indicator axes).
                if (pane.getYAxisComponents && pane.isManualYAxis) {
                    (pane.getYAxisComponents() || []).forEach((c) => {
                        if (pane.isManualYAxis(c.id)) pane.setManualYAxis(c.id, false);
                    });
                }
            });
        } catch (e) { report('resetYAxis: ' + e.message); }
    }

    function resetZoom(view) {
        if (!view || !view.chart) return;
        try {
            resetYAxisScale(view);                      // restore auto-fit price axis
            view.chart.setBarSpace(DEFAULT_CANDLE_PX);  // restore default candle width
            view.chart.resize();                        // force full redraw incl. Y ticks
            if (!centreOnDay(view, view.focusIdx, 0)) view.chart.scrollToRealTime(0);
        } catch (e) { report('resetZoom: ' + e.message); }
    }

    // ----- indicators (per view) -----

    function applyIndicators(view, list) {
        if (!view.chart) { view.pendingIndicators = list; return; }
        // Remove currently-shown indicators, then (re)create the enabled ones.
        try {
            view.chart.getIndicators().forEach((i) => view.chart.removeIndicator({ name: i.name }));
        } catch (e) { report('clearIndicators: ' + e.message); }
        let createdAny = false;
        for (const it of list) {
            if (!it.enabled) continue;
            // TF-apply: only render on timeframes at or above the chosen threshold.
            if (it.minTf && TF_MIN[it.minTf] != null && (TF_MIN[view.tf] || 0) < TF_MIN[it.minTf]) continue;
            try {
                const value = { name: it.name };
                if (it.calcParams) value.calcParams = it.calcParams.slice();
                if (it.overlay) value.paneId = MAIN_PANE;
                else value.id = 'pane_' + it.name;
                const created = view.chart.createIndicator(
                    value, true, it.overlay ? undefined : { id: 'pane_' + it.name });
                if (created) {
                    createdAny = true;
                    const inst = view.chart.getIndicators()
                        .find((i) => i.name === it.name && (it.overlay ? i.paneId === MAIN_PANE : true));
                    if (inst) {
                        if (!it.calcParams && inst.calcParams) it.calcParams = inst.calcParams.slice();
                        it.paneId = inst.paneId;
                        // Re-apply previously chosen colours (toggling recreates
                        // the indicator from defaults, which would drop them).
                        if (it.colors && Object.keys(it.colors).length) {
                            try { applyIndicatorColors(view, it); }
                            catch (e) { report('reapply color ' + it.name + ': ' + e.message); }
                        }
                        // Re-apply the Label on/off flag for Inside Bar (read by its draw()).
                        if (it.labelToggle) {
                            try { view.chart.overrideIndicator({ name: it.name, paneId: inst.paneId, styles: { showLabel: it.showLabel !== false } }); }
                            catch (e) { report('reapply label ' + it.name + ': ' + e.message); }
                        }
                    }
                } else setStatus('Indicator ' + it.name + ' is unavailable');
            } catch (e) { report('indicator ' + it.name + ': ' + e.message); }
        }
        updateStatus();
    }

    function toggleIndicator(name, overlay) {
        const v = app.activeView; if (!v) return;
        const it = v.indicators.find((x) => x.name === name);
        if (!it) return;
        it.enabled = !it.enabled;
        applyIndicators(v, v.indicators);
        scheduleSave();
        const cb = $('indMenu').querySelector('.ind-row[data-name="' + name + '"] input');
        if (cb) cb.checked = it.enabled;
        if (it.enabled) openIndicatorSettings(v, it);
    }

    function indicatorList() {
        const supported = (typeof klinecharts !== 'undefined' && klinecharts.getSupportedIndicators)
            ? klinecharts.getSupportedIndicators() : null;
        const seen = new Set();
        return BUILTIN_INDICATORS.concat(window.INDICATORS || [])
            .filter((i) => {
                if (!i || !i.name || seen.has(i.name)) return false;
                if (supported && supported.indexOf(i.name) < 0) { report('skip ' + i.name); return false; }
                seen.add(i.name); return true;
            });
    }

    // ----- indicator settings box (TradingView-style) -----

    // Inline action icons drawn by KLineChart itself, inside each indicator's
    // always-on legend (the official web-demo behaviour). This build has no
    // embedded icon font, so each feature is a hand-built SVG path (M/L/Q/Z only;
    // arc commands are not supported by the renderer) rendered via the `path`
    // feature type. The `onIndicatorTooltipFeatureClick` event reports which
    // `feature.id` was clicked, so we wire visible/setting/remove below.
    const INDICATOR_TOOLTIP_FEATURES = [
        {
            id: 'visible', position: 'middle', type: 'path', size: 12,
            marginLeft: 8, marginRight: 4, paddingLeft: 2, paddingTop: 2, paddingRight: 2, paddingBottom: 2,
            color: '#76808F', activeColor: '#1f2933',
            backgroundColor: 'rgba(0,0,0,0)', activeBackgroundColor: 'rgba(118,128,143,0.18)', borderRadius: 2,
            content: {
                lineWidth: 1.3, style: 'stroke',
                // eye outline + diamond pupil
                path: 'M1.5 6 Q6 2.5 10.5 6 Q6 9.5 1.5 6 Z M6 4.2 L7 5.2 L6 6.2 L5 5.2 Z',
            },
        },
        {
            id: 'setting', position: 'middle', type: 'path', size: 12,
            marginLeft: 2, marginRight: 4, paddingLeft: 2, paddingTop: 2, paddingRight: 2, paddingBottom: 2,
            color: '#76808F', activeColor: '#1f2933',
            backgroundColor: 'rgba(0,0,0,0)', activeBackgroundColor: 'rgba(118,128,143,0.18)', borderRadius: 2,
            content: {
                lineWidth: 1.3, style: 'stroke',
                // sliders: three lines with knobs
                path: 'M2 3 L10 3 M5 1.5 L5 4.5 M2 6 L10 6 M7.5 4.5 L7.5 7.5 M2 9 L10 9 M5 7.5 L5 10.5',
            },
        },
        {
            id: 'remove', position: 'middle', type: 'path', size: 12,
            marginLeft: 2, marginRight: 10, paddingLeft: 2, paddingTop: 2, paddingRight: 2, paddingBottom: 2,
            color: '#76808F', activeColor: '#c0392b',
            backgroundColor: 'rgba(0,0,0,0)', activeBackgroundColor: 'rgba(192,57,43,0.15)', borderRadius: 2,
            content: {
                lineWidth: 1.4, style: 'stroke',
                // close X
                path: 'M3.5 3.5 L8.5 8.5 M8.5 3.5 L3.5 8.5',
            },
        },
    ];



    // Harmonic patterns get their own colours (the plugin draws via a custom
    // canvas routine, reading overrideIndicator styles.patterns).
    const HARMONIC_PATTERNS = ['Gartley', 'Butterfly', 'Bat', 'Crab'];
    const HARMONIC_DEFAULT_COLORS = {
        Gartley: '#ff9800', Butterfly: '#3f51b5', Bat: '#4caf50', Crab: '#e91e63',
    };
    const LINE_PALETTE = ['#2196f3', '#26a69a', '#ef5350', '#ff9800', '#ab47bc', '#26c6da', '#ec407a', '#789262'];

    // The colour targets for an indicator: one per line/circle/text figure for a
    // normal indicator (so MA's 4 lines can each be coloured), or one per pattern
    // for HARMONIC.
    function indicatorColorTargets(it, inst) {
        if (it.name === 'HARMONIC') {
            return HARMONIC_PATTERNS.map((p) => ({ key: p, label: p, type: 'pattern', color: HARMONIC_DEFAULT_COLORS[p] }));
        }
        const figs = (inst && inst.figures) ? inst.figures : [];
        const out = [];
        figs.forEach((f, idx) => {
            if (f.type === 'line' || f.type === 'circle' || f.type === 'text') {
                let c = f.color;
                if (!c || c === 'currentColor') c = LINE_PALETTE[idx % LINE_PALETTE.length];
                out.push({ key: f.key, label: (f && f.title) ? f.title : f.key, type: f.type, color: c });
            }
        });
        return out;
    }

    // Apply the per-target colours (stored in it.colors) via overrideIndicator.
    function applyIndicatorColors(view, it) {
        try {
            const inst = (view.chart.getIndicators() || [])
                .find((i) => i.name === it.name && (it.overlay ? i.paneId === MAIN_PANE : true));
            if (!inst) return;
            const targets = indicatorColorTargets(it, inst);
            const lines = [], circles = [], texts = [], patterns = {};
            targets.forEach((t) => {
                const c = (it.colors && it.colors[t.key]) || t.color;
                if (it.name === 'HARMONIC') patterns[t.key] = c;
                else if (t.type === 'line') lines.push({ color: c });
                else if (t.type === 'circle') circles.push({ color: c, noChangeColor: c });
                else if (t.type === 'text') texts.push({ color: c });
            });
            const styles = {};
            if (lines.length) styles.lines = lines;
            if (circles.length) styles.circles = circles;
            if (texts.length) styles.texts = texts;
            if (it.name === 'HARMONIC') {
                HARMONIC_PATTERNS.forEach((p) => { patterns[p] = (it.colors && it.colors[p]) || HARMONIC_DEFAULT_COLORS[p]; });
                styles.patterns = patterns;
            }
            view.chart.overrideIndicator({ name: it.name, paneId: it.paneId, styles: styles });
        } catch (e) { report('indicator color ' + it.name + ': ' + e.message); }
    }

    // Floating settings box for one indicator's calc params. Editing a value live
    // updates the chart via overrideIndicator (which recalculates with the new
    // calcParams). Also opened automatically when the indicator is first enabled.
    function openIndicatorSettings(view, it) {
        const panel = $('indSettings');
        if (!panel || !view.chart) return;
        const inst = (view.chart.getIndicators() || [])
            .find((i) => i.name === it.name && (it.overlay ? i.paneId === MAIN_PANE : true));
        const params = (it.calcParams && it.calcParams.slice()) ||
            (inst && inst.calcParams ? inst.calcParams.slice() : []);
        if (!it.calcParams && inst) it.calcParams = params.slice();
        if (inst) it.paneId = inst.paneId;

        panel.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'is-head';
        head.innerHTML = '<span>' + (inst ? (inst.shortName || inst.name) : it.name) + ' settings</span>';
        const close = document.createElement('button');
        close.className = 'is-close';
        close.title = 'Close';
        close.textContent = '×';
        close.addEventListener('click', () => panel.classList.add('hidden'));
        head.appendChild(close);
        panel.appendChild(head);

        const body = document.createElement('div');
        body.className = 'is-body';
        let hasSettings = params.length > 0;
        params.forEach((val, idx) => {
            const row = document.createElement('div');
            row.className = 'is-row';
            const label = document.createElement('label');
            const labels = INDICATOR_PARAM_LABELS[it.name];
            label.textContent = (labels && labels[idx]) ? labels[idx] : ('Param ' + (idx + 1));
            const input = document.createElement('input');
            input.type = 'number';
            input.step = 'any';
            input.value = val;
            input.addEventListener('input', () => {
                const nv = parseFloat(input.value);
                if (isNaN(nv)) return;
                it.calcParams[idx] = nv;
                try {
                    view.chart.overrideIndicator({
                        name: it.name, paneId: it.paneId, calcParams: it.calcParams.slice(),
                    });
                    scheduleSave();
                } catch (e) { report('overrideIndicator ' + it.name + ': ' + e.message); }
            });
            row.appendChild(label);
            row.appendChild(input);
            body.appendChild(row);
        });

        // One colour picker per colour target (each MA line, or each harmonic
        // pattern). Stored in it.colors keyed by figure key / pattern name.
        if (!it.colors) it.colors = {};
        indicatorColorTargets(it, inst).forEach((t) => {
            const crow = document.createElement('div');
            crow.className = 'is-row';
            const clabel = document.createElement('label');
            clabel.textContent = t.label;
            const cinput = document.createElement('input');
            cinput.type = 'color';
            cinput.className = 'is-color';
            cinput.value = it.colors[t.key] || t.color;
            cinput.addEventListener('input', () => {
                it.colors[t.key] = cinput.value;
                applyIndicatorColors(view, it);
                scheduleSave();
            });
            crow.appendChild(clabel);
            crow.appendChild(cinput);
            body.appendChild(crow);
            hasSettings = true;
        });

        // TF-apply threshold: the indicator only renders on timeframes at or
        // above the chosen value (e.g. 15m and above), and stays invisible below it.
        if (it.tfApply) {
            const row = document.createElement('div');
            row.className = 'is-row';
            const label = document.createElement('label');
            label.textContent = 'Apply on TF ≥';
            const sel = document.createElement('select');
            TF_OPTIONS.forEach((t) => {
                const o = document.createElement('option');
                o.value = t; o.textContent = TF_LABEL[t];
                if (t === (it.minTf || '1')) o.selected = true;
                sel.appendChild(o);
            });
            sel.addEventListener('change', () => {
                it.minTf = sel.value;
                applyIndicators(view, view.indicators);
                scheduleSave();
                // If the threshold now hides it, close its (now stale) settings panel.
                const stillOn = (view.chart.getIndicators() || []).some(
                    (i) => i.name === it.name && (it.overlay ? i.paneId === MAIN_PANE : true));
                if (!stillOn) { const p = $('indSettings'); if (p) p.classList.add('hidden'); }
            });
            row.appendChild(label);
            row.appendChild(sel);
            body.appendChild(row);
        }

        // Label on/off toggle (Inside Bar). Drives indicator.styles.showLabel,
        // which the plugin reads in its draw() to show or hide the "IB" text.
        if (it.labelToggle) {
            const row = document.createElement('div');
            row.className = 'is-row';
            const label = document.createElement('label');
            label.textContent = 'Label';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = (it.showLabel !== false);
            cb.addEventListener('change', () => {
                it.showLabel = cb.checked;
                try { view.chart.overrideIndicator({ name: it.name, paneId: it.paneId, styles: { showLabel: cb.checked } }); }
                catch (e) { report('insidebar label: ' + e.message); }
                scheduleSave();
            });
            row.appendChild(label);
            row.appendChild(cb);
            body.appendChild(row);
            hasSettings = true;
        }

        // Nothing configurable at all (no params / colours / TF-apply / label).
        if (!hasSettings) {
            const none = document.createElement('div');
            none.className = 'is-none';
            none.textContent = 'This indicator has no editable parameters.';
            body.appendChild(none);
        }

        panel.appendChild(body);
        openSettingsPanel(panel);
    }

    // ---- drawing (overlay) style editor ----

    // Map a UI line-type choice to KLineChart's line style + dash pattern.
    function overlayLineStyle(kind) {
        if (kind === 'dotted') return { style: 'dashed', dashedValue: [1, 4] };
        if (kind === 'dashed') return { style: 'dashed', dashedValue: [4, 4] };
        return { style: 'solid', dashedValue: [2, 2] };
    }

    function applyOverlayStyle(view, kind, color, size) {
        const overlay = view._overlay;
        if (!overlay || !view.chart) return;
        const ls = overlayLineStyle(kind);
        const styles = {
            // Lines (trend/horizontal/segment/price-line) and the marker points.
            line: { style: ls.style, color: color, size: size, dashedValue: ls.dashedValue },
            point: { style: ls.style, color: color, size: size, borderColor: color, borderSize: size, dashedValue: ls.dashedValue },
            // Filled / outlined shapes (rect, price channel, fibonacci, parallel).
            rect: { color: color, borderColor: color, borderSize: size, borderStyle: ls.style, borderDashedValue: ls.dashedValue },
            polygon: { color: color, borderColor: color, borderSize: size, borderStyle: ls.style, borderDashedValue: ls.dashedValue },
            text: { color: color },
        };
        try {
            view.chart.overrideOverlay({ id: overlay.id, paneId: overlay.paneId, styles: styles });
            scheduleSave();
        } catch (e) { report('overlay style: ' + e.message); }
    }

    // Floating editor opened when a drawing is selected on the chart. Lets the user
    // recolor / resize / change the dash style of an existing overlay.
    function openOverlaySettings(view, overlay) {
        const panel = $('overlaySettings');
        if (!panel || !view.chart || !overlay) return;
        view._overlay = overlay;

        const lineStyle = (overlay.styles && overlay.styles.line) || {};
        let color = (typeof lineStyle.color === 'string' && lineStyle.color && lineStyle.color !== 'currentColor')
            ? lineStyle.color : (app.drawColor || '#2962ff');
        let size = (typeof lineStyle.size === 'number' && lineStyle.size > 0) ? lineStyle.size : 1;
        let kind = 'solid';
        if (lineStyle.style === 'dashed') {
            const dv = lineStyle.dashedValue;
            kind = (dv && dv.length >= 2 && dv[0] <= 1) ? 'dotted' : 'dashed';
        }

        panel.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'os-head';
        head.innerHTML = '<span>' + (overlay.name || 'Drawing') + ' style</span>';
        const close = document.createElement('button');
        close.className = 'os-close';
        close.title = 'Close';
        close.textContent = '×';
        close.addEventListener('click', () => panel.classList.add('hidden'));
        head.appendChild(close);
        panel.appendChild(head);

        const body = document.createElement('div');
        body.className = 'os-body';

        function row(labelText, control) {
            const r = document.createElement('div');
            r.className = 'os-row';
            const l = document.createElement('label');
            l.textContent = labelText;
            r.appendChild(l);
            r.appendChild(control);
            body.appendChild(r);
        }

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'is-color';
        colorInput.value = color;
        colorInput.addEventListener('input', () => { color = colorInput.value; applyOverlayStyle(view, kind, color, size); });
        row('Color', colorInput);

        const sizeInput = document.createElement('input');
        sizeInput.type = 'number';
        sizeInput.min = '1'; sizeInput.max = '12'; sizeInput.step = '1';
        sizeInput.value = size;
        sizeInput.addEventListener('input', () => {
            const v = parseInt(sizeInput.value, 10);
            if (isNaN(v) || v < 1) return;
            size = v; applyOverlayStyle(view, kind, color, size);
        });
        row('Thickness', sizeInput);

        const typeSelect = document.createElement('select');
        [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']].forEach(([val, txt]) => {
            const o = document.createElement('option');
            o.value = val; o.textContent = txt;
            if (val === kind) o.selected = true;
            typeSelect.appendChild(o);
        });
        typeSelect.addEventListener('change', () => { kind = typeSelect.value; applyOverlayStyle(view, kind, color, size); });
        row('Line type', typeSelect);

        panel.appendChild(body);
        panel.classList.remove('hidden');
    }

    // ----- Link (keep pane centres aligned in time while panning) -----

    function centerTimestamp(view) {
        const chart = view.chart; if (!chart) return null;
        const vr = chart.getVisibleRange(); const list = chart.getDataList();
        if (!vr || !list || !list.length) return null;
        const c = (vr.from + vr.to) / 2;
        const i0 = clamp(Math.floor(c), 0, list.length - 1);
        const i1 = clamp(Math.ceil(c), 0, list.length - 1);
        const f = c - i0;
        return list[i0].timestamp * (1 - f) + list[i1].timestamp * f;
    }

    function nearestIndex(list, ts) {
        const n = list.length; if (!n) return null;
        let lo = 0, hi = n - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].timestamp < ts) lo = m + 1; else hi = m; }
        if (lo > 0 && (ts - list[lo - 1].timestamp) < (list[lo].timestamp - ts)) lo--;
        return lo;
    }

    // One global guard prevents the cross-chart ping-pong when the synced
    // scroll itself fires 'onScroll' on the other pane (a per-view guard would
    // still let view B re-sync back onto view A). The guard blocks ALL syncs for
    // the duration of a single sync, then releases on the next tick.
    let _linkSyncing = false;

    // Timestamp of the last settings-panel open. The document outside-click
    // handler ignores dismissals that occur within a short window after opening,
    // so the same gesture that opened the panel (e.g. the native indicator gear,
    // which fires on canvas mousedown, then bubbles a click to document) does not
    // immediately close it. A time window (rather than a tick flag) is used
    // because the bubbled click can arrive after a 0ms timeout in some webviews.
    let _panelOpenedAt = 0;
    function openSettingsPanel(panel) {
        panel.classList.remove('hidden');
        _panelOpenedAt = Date.now();
    }

    function syncLink(source) {
        if (!app.linked || app.views.length < 2 || _linkSyncing) return;
        const ts = centerTimestamp(source); if (ts == null) return;
        _linkSyncing = true;
        for (const o of app.views) {
            if (o === source || !o.chart) continue;
            const list = o.chart.getDataList(); if (!list.length) continue;
            const vr = o.chart.getVisibleRange(); if (!vr) continue;
            const half = (vr.to - vr.from) / 2;
            const idx = nearestIndex(list, ts);
            try { o.chart.scrollToDataIndex(Math.min(list.length - 1, idx + half), 0); }
            catch (e) { report('syncLink: ' + e.message); }
        }
        setTimeout(() => { _linkSyncing = false; }, 0);
    }

    // ----- chart / view -----

    function makeStyles() {
        return {
            grid: { show: false },
            // KLineChart renders the indicator legend (name + params + live values)
            // inline at the top of each indicator pane by default. We attach the
            // visible / setting / remove action icons there via `features` so they
            // sit right next to the legend text (official web-demo behaviour).
            // NOTE: the price-axis `gap` is NOT a `styles` property — it is set via
            // `layout.yAxis.gap` (and overrideYAxis) in createView, or KLineChart
            // silently ignores it here.
            indicator: {
                tooltip: {
                    showRule: 'always',
                    showType: 'standard',
                    title: { show: true, showName: true, showParams: true },
                    legend: { defaultValue: 'n/a' },
                    features: INDICATOR_TOOLTIP_FEATURES,
                },
            },
            candle: {
                type: 'candle_stroke',
                bar: {
                    upColor: UP, downColor: DOWN, noChangeColor: '#888888',
                    upBorderColor: UP, downBorderColor: DOWN, noChangeBorderColor: '#888888',
                    upWickColor: UP, upBorderColor: UP, downWickColor: DOWN, noChangeWickColor: '#888888',
                },
                priceMark: { last: { upColor: UP, downColor: DOWN, noChangeColor: '#888888' } },
                tooltip: {
                    legend: [
                        { title: 'time', value: '{time}' },
                        { title: 'O', value: '{open}' },
                        { title: 'H', value: '{high}' },
                        { title: 'L', value: '{low}' },
                        { title: 'C', value: '{close}' },
                    ],
                },
            },
        };
    }

    function createView(tf, focusIdx) {
        const v = {
            uid: 'v' + (app.uid++), chart: null, el: null, root: null,
            tf: tf || app.currentTf || '1',
            loadedFrom: 0, loadedTo: 0,
            focusIdx: (focusIdx == null) ? lastIdx() : focusIdx,
            indicators: indicatorList().map((i) => ({ name: i.name, overlay: i.overlay, enabled: false, calcParams: null, paneId: null, tfApply: !!i.tfApply, minTf: (i.tfApply ? '1' : null), labelToggle: !!i.labelToggle, showLabel: (i.labelToggle ? true : undefined) })),
            panel: null,
        };
        v.loader = makeLoader(v);

        const root = document.createElement('div');
        root.className = 'chart-view';
        const el = document.createElement('div'); el.className = 'cv-chart';
        root.appendChild(el);
        v.root = root; v.el = el;

        $('views').appendChild(root);
        root.addEventListener('mousedown', () => setActiveView(v));

        if (typeof klinecharts !== 'undefined') {
            // `gap` is an axis-layout property, NOT a `styles` property — set it
            // via layout.yAxis.gap (and reinforce with overrideYAxis below).
            const chart = klinecharts.init(el, {
                timezone: 'UTC',
                styles: makeStyles(),
                layout: { yAxis: { gap: { top: 10, bottom: 13 } } },
            });
            v.chart = chart;
            try {
                if (chart.overrideYAxis) {
                    chart.overrideYAxis({ paneId: MAIN_PANE, gap: { top: 10, bottom: 13 } });
                } else if (chart.setPaneOptions) {
                    chart.setPaneOptions({ id: MAIN_PANE, gap: { top: 0, bottom: 0 } });
                }
            } catch (e) { report('overrideYAxis gap: ' + e.message); }
            chart.setSymbol({ ticker: app.symbol || 'OHLC', pricePrecision: app.pricePrecision || 2, volumePrecision: 0 });
            chart.setPeriod(tfToPeriod(v.tf));
            chart.setDataLoader(v.loader);
            chart.setBarSpace(DEFAULT_CANDLE_PX);
            // Re-apply styles last so our gap:0 (and other tweaks) are the final
            // word, in case any earlier set* call disturbed them.
            chart.setStyles(makeStyles());
            try {
                chart.subscribeAction('onScroll', () => { syncLink(v); });
            } catch (e) { report('subscribeAction unavailable: ' + e.message); }
            // Inline indicator action icons (visible / setting / remove) rendered by
            // KLineChart inside the indicator legend (see INDICATOR_TOOLTIP_FEATURES).
            try {
                chart.subscribeAction('onIndicatorTooltipFeatureClick', ({ paneId, feature, indicator }) => {
                    // Resolve the indicator record. The event payload's `indicator`
                    // is the live instance; fall back to the chart's indicator list
                    // by id in case its `name` isn't populated on the payload.
                    const live = (v.chart.getIndicators() || []).find((i) => i.id === indicator.id);
                    const name = (indicator && (indicator.name || indicator.shortName)) || (live && live.name);
                    if (!name) return;
                    let it = v.indicators.find((x) => x.name === name);
                    if (!it) it = { name, overlay: paneId === MAIN_PANE, enabled: true, calcParams: null, colors: {} };
                    try {
                        if (feature.id === 'visible') {
                            chart.overrideIndicator({ paneId, id: indicator.id, visible: !indicator.visible });
                            scheduleSave();
                        } else if (feature.id === 'setting') {
                            openIndicatorSettings(v, it);
                        } else if (feature.id === 'remove') {
                            chart.removeIndicator({ paneId, id: indicator.id });
                            const rec = v.indicators.find((x) => x.name === name);
                            if (rec) rec.enabled = false;
                            const cb = $('indMenu').querySelector('.ind-row[data-name="' + name + '"] input');
                                if (cb) cb.checked = false;
                            updateStatus();
                            scheduleSave();
                        }
                    } catch (err) { report('indicator ' + name + ' action ' + feature.id + ': ' + err.message); }
                });
            } catch (e) { report('subscribeAction feature click unavailable: ' + e.message); }
        }
        return v;
    }

    function setActiveView(v) {
        if (!v) return;
        app.activeView = v;
        app.views.forEach((o) => o.root.classList.toggle('active-view', o === v));
        const tfSel = $('tfSelect'); if (tfSel) tfSel.value = v.tf;
        // NOTE: do NOT hide #indSettings here. A mousedown on the chart (e.g. the
        // native indicator gear, which is drawn on the canvas inside this root)
        // also triggers setActiveView, and would close the panel the gear just
        // opened in the same gesture. The document outside-click handler closes
        // it instead (the gear re-open is protected by the _panelOpenedAt window).
        $('overlaySettings').classList.add('hidden');
        buildIndicatorMenu();
        updateStatus();
    }

    function setSplit(on) {
        app.split = on;
        if (on && app.views.length < 2) {
            const ref = app.views[0];
            const v = createView(ref ? ref.tf : (app.currentTf || '1'),
                                 ref ? ref.focusIdx : (app.focusIdx != null ? app.focusIdx : lastIdx()));
            app.views.push(v);
        } else if (!on && app.views.length > 1) {
            const v = app.views.pop();
            // Drop the DOM node; the chart instance is tied to it and will be
            // garbage-collected (along with its onScroll subscription). Avoids
            // disposing while a sync may be in flight.
            if (v.root) v.root.remove();
            if (app.activeView === v) app.activeView = app.views[0] || null;
            // Link needs two panes; turn it off when leaving Split.
            if (app.linked) {
                app.linked = false;
                const lb = $('linkBtn'); if (lb) lb.classList.remove('active');
            }
        }
        app.views.forEach((v) => v.root.classList.toggle('active-view', v === app.activeView));
        setActiveView(app.activeView || app.views[0]);
        updateStatus();
    }

    // ----- menus -----

    function buildIndicatorMenu() {
        const menu = $('indMenu');
        const v = app.activeView; if (!v) return;
        menu.innerHTML = '<div class="menu-title">Indicators (pane ' +
            (app.views.indexOf(v) + 1) + ')</div>' +
            v.indicators.map((i) =>
                `<div class="ind-row" data-name="${i.name}" data-overlay="${i.overlay}">` +
                `<input type="checkbox" id="ind-${i.name}" ${i.enabled ? 'checked' : ''}>` +
                `<label for="ind-${i.name}">${i.name}</label></div>`
            ).join('');
        menu.querySelectorAll('.ind-row').forEach((row) => {
            const name = row.dataset.name;
            row.addEventListener('click', (e) => { if (e.target.tagName === 'INPUT') return; e.preventDefault(); toggleIndicator(name, row.dataset.overlay === 'true'); });
            row.querySelector('input').addEventListener('change', () => toggleIndicator(name, row.dataset.overlay === 'true'));
        });
    }

    function buildDrawMenu() {
        const menu = $('drawMenu');
        menu.innerHTML = '<div class="menu-title">Drawing tools</div>';

        // Colour picker (kept out of the overlay-click handler below so picking a
        // colour never starts a drawing).
        const colorRow = document.createElement('div');
        colorRow.className = 'ind-row draw-color-row';
        const clabel = document.createElement('label');
        clabel.textContent = 'Line colour';
        clabel.htmlFor = 'drawColor';
        const cinput = document.createElement('input');
        cinput.type = 'color';
        cinput.id = 'drawColor';
        cinput.className = 'draw-color';
        cinput.value = app.drawColor || '#2962ff';
        cinput.addEventListener('input', () => { app.drawColor = cinput.value; });
        cinput.addEventListener('click', (e) => e.stopPropagation());
        colorRow.appendChild(clabel);
        colorRow.appendChild(cinput);
        menu.appendChild(colorRow);

        const list = document.createElement('div');
        list.innerHTML = OVERLAYS.map((o) => `<div class="ind-row" data-name="${o.name}"><label>${o.label}</label></div>`).join('') +
            '<div class="ind-row" data-clear="1"><label>Clear all drawings</label></div>';
        menu.appendChild(list);

        list.querySelectorAll('.ind-row').forEach((row) => {
            row.addEventListener('click', () => {
                try {
                    if (row.dataset.clear) { app.activeView.chart.removeOverlay(); scheduleSave(); }
                    else {
                        const color = app.drawColor || '#2962ff';
                        const view = app.activeView;
                        const paneId = MAIN_PANE;
                        // `getOverlays` is a real chart method; `getOverlaysByFilter`
                        // is not, so diff the pane's overlays to find the new one.
                        const before = new Set((view.chart.getOverlays({ paneId: paneId }) || [])
                            .map((o) => o && o.id));
                        view.chart.createOverlay({
                            name: row.dataset.name,
                            paneId: paneId,
                            styles: {
                                line: { color: color, activeColor: color },
                                point: { color: color, activeColor: color, backgroundColor: color, borderColor: color },
                                rect: { color: color, borderColor: color, activeColor: color },
                                polygon: { color: color, borderColor: color, activeColor: color },
                                text: { color: color },
                            },
                        });
                        const all = view.chart.getOverlays({ paneId: paneId }) || [];
                        const inst = all.find((o) => o && o.id && !before.has(o.id)) || all[all.length - 1];
                        // KLineChart's overlay `override()` drops callback options
                        // and never dispatches a chart-level 'onSelected' action, so
                        // we attach the handlers straight to the live instance.
                        if (inst) {
                            inst.onSelected = function (p) { openOverlaySettings(view, p && p.overlay); scheduleSave(); };
                            inst.onDeselected = function () {
                                const os = $('overlaySettings'); if (os) os.classList.add('hidden');
                                scheduleSave();
                            };
                            inst.onRemoved = function () { scheduleSave(); };
                        }
                    }
                    scheduleSave();
                    $('drawMenu').classList.add('hidden');
                } catch (e) { report('overlay: ' + e.message); setStatus('Draw error: ' + e.message); }
            });
        });
    }

    function wireMenu(btnId, menuId, otherMenuId) {
        const btn = $(btnId), menu = $(menuId);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.toggle('hidden');
            $(otherMenuId).classList.add('hidden');
        });
        return { btn, menu };
    }

    // ----- profile (per-file persistence, TradingView-style) -----
    //
    // Each parquet file gets a JSON "profile" stored by the backend (one file per
    // parquet, keyed by path hash). The profile remembers, per view: the
    // timeframe, focused day, candle width, enabled indicators (with their calc
    // params + colours) and every drawing (overlay). On open we restore it; on
    // any change we autosave (diff-based, debounced) so drawings/indicators
    // survive re-opening the same file.

    let _lastSnapshot = '';
    let _profileReady = false;

    // Strip an overlay instance down to serialisable fields (drop functions).
    function serializeOverlay(o) {
        if (!o) return null;
        let points = null;
        if (Array.isArray(o.points)) {
            points = o.points.map((p) => {
                const np = {};
                if (p.timestamp != null) np.timestamp = p.timestamp;
                if (p.dataIndex != null) np.dataIndex = p.dataIndex;
                if (p.price != null) np.price = p.price;
                if (p.value != null) np.value = p.value;
                return np;
            });
        }
        return {
            id: o.id,
            name: o.name,
            paneId: o.paneId || MAIN_PANE,
            lock: !!o.lock,
            visible: (o.visible === undefined ? true : !!o.visible),
            points: points,
            styles: o.styles || null,
        };
    }

    // Gather overlays across the candle pane and any indicator panes.
    function getViewOverlays(view) {
        const out = [];
        if (!view.chart || !view.chart.getOverlays) return out;
        const panes = [MAIN_PANE];
        view.indicators.forEach((it) => { if (!it.overlay && it.enabled) panes.push('pane_' + it.name); });
        panes.forEach((pid) => {
            let arr = [];
            try { arr = view.chart.getOverlays({ paneId: pid }) || []; } catch (e) { /* pane may not exist yet */ }
            arr.forEach((o) => { const s = serializeOverlay(o); if (s) out.push(s); });
        });
        return out;
    }

    function serializeView(view) {
        if (!view.chart) return { tf: view.tf, indicators: [], overlays: [] };
        return {
            tf: view.tf,
            focusIdx: view.focusIdx,
            candlePx: (view.chart.getBarSpace ? view.chart.getBarSpace() : DEFAULT_CANDLE_PX),
            indicators: view.indicators.map((it) => ({
                name: it.name, overlay: it.overlay, enabled: it.enabled,
                calcParams: it.calcParams || null, colors: it.colors || null, paneId: it.paneId || null,
                minTf: it.minTf || null, showLabel: (it.showLabel === undefined ? null : it.showLabel),
            })),
            overlays: getViewOverlays(view),
        };
    }

    function snapshot() {
        return JSON.stringify({
            symbol: app.symbol,
            split: !!app.split,
            linked: !!app.linked,
            views: app.views.map(serializeView),
        });
    }

    function postSave(s) {
        fetch('/api/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: s,
        }).catch((e) => report('save profile: ' + (e && e.message ? e.message : e)));
    }

    // Persist when state differs from the last saved snapshot. Safe to call
    // liberally; it no-ops unless something actually changed.
    function scheduleSave() {
        if (!_profileReady) return;
        const s = snapshot();
        if (s !== _lastSnapshot) { _lastSnapshot = s; postSave(s); }
    }

    function startAutosave() {
        setInterval(() => {
            if (!_profileReady || !app.views.length || !app.views[0].chart) return;
            const s = snapshot();
            if (s !== _lastSnapshot) { _lastSnapshot = s; postSave(s); }
        }, 1500);
    }

    // Attach selection / removal handlers so editing or deleting a drawing
    // (including dragging it to a new position) triggers a save.
    function attachOverlayHandlers(view, inst) {
        if (!inst) return;
        try {
            inst.onSelected = function (p) { openOverlaySettings(view, p && p.overlay); scheduleSave(); };
            inst.onDeselected = function () {
                const os = $('overlaySettings'); if (os) os.classList.add('hidden'); scheduleSave();
            };
            inst.onRemoved = function () { scheduleSave(); };
        } catch (e) { /* ignore */ }
    }

    function recreateOverlays(view, list) {
        if (!view.chart || !view.chart.createOverlay || !Array.isArray(list)) return;
        const known = new Set(((view.chart.getOverlays ? view.chart.getOverlays({ paneId: MAIN_PANE }) : []) || []).map((o) => o && o.id));
        list.forEach((od) => {
            let inst = null;
            try {
                inst = view.chart.createOverlay({
                    name: od.name, paneId: od.paneId || MAIN_PANE,
                    points: od.points || [], styles: od.styles || {},
                    lock: od.lock, visible: od.visible,
                });
            } catch (e) { report('recreate overlay ' + (od && od.name) + ': ' + e.message); }
            attachOverlayHandlers(view, inst && inst.id ? inst : null);
        });
    }

    function applyViewProfile(view, pv) {
        if (!view || !pv) return;
        // Indicators first (so their panes exist for any overlays placed on them).
        if (Array.isArray(pv.indicators)) {
            pv.indicators.forEach((s) => {
                const it = view.indicators.find((x) => x.name === s.name);
                if (!it) return;
                it.enabled = !!s.enabled;
                if (s.calcParams) it.calcParams = s.calcParams;
                if (s.colors) it.colors = s.colors;
                if (s.paneId) it.paneId = s.paneId;
                if (s.minTf != null) it.minTf = s.minTf;
                if (s.showLabel != null) it.showLabel = s.showLabel;
            });
            applyIndicators(view, view.indicators);
        }
        if (pv.overlays && pv.overlays.length) recreateOverlays(view, pv.overlays);
        if (typeof pv.candlePx === 'number' && view.chart.setBarSpace) view.chart.setBarSpace(pv.candlePx);
        if (typeof pv.focusIdx === 'number' && app.dates[pv.focusIdx]) {
            view.focusIdx = pv.focusIdx;
            app.focusIdx = pv.focusIdx;
            $('dateInput').value = app.dates[pv.focusIdx];
            centreOnDay(view, pv.focusIdx, 0);
        }
        updateStatus();
    }

    async function applyProfile(profile) {
        if (!profile || !Array.isArray(profile.views) || !profile.views.length) {
            _profileReady = true;
            _lastSnapshot = snapshot();
            return;
        }
        const v0p = profile.views[0];
        const v0 = app.views[0];
        // Match the saved timeframe before the first data load so overlays land
        // on the same time axis.
        if (v0p.tf && v0p.tf !== v0.tf) {
            v0.tf = v0p.tf;
            if (v0.chart) v0.chart.setPeriod(tfToPeriod(v0.tf));
        }
        v0.pendingProfile = v0p;

        // Split: rebuild the second pane and apply its saved state.
        if (profile.split && profile.views[1]) {
            app.split = true;
            if (app.views.length < 2) {
                const ref = app.views[0];
                const v1 = createView(ref ? ref.tf : (app.currentTf || '1'),
                                      ref ? ref.focusIdx : (app.focusIdx != null ? app.focusIdx : lastIdx()));
                app.views.push(v1);
            }
            const sb = $('splitBtn'); if (sb) sb.classList.add('active');
            const v1 = app.views[1];
            if (profile.views[1].tf && profile.views[1].tf !== v1.tf) {
                v1.tf = profile.views[1].tf;
                if (v1.chart) v1.chart.setPeriod(tfToPeriod(v1.tf));
            }
            v1.pendingProfile = profile.views[1];
            app.linked = !!profile.linked;
            const lb = $('linkBtn'); if (lb) lb.classList.toggle('active', app.linked);
            app.views.forEach((v) => v.root.classList.toggle('active-view', v === app.activeView));
        }
    }

    // init() calls this once the first data load has finished; we then mark the
    // profile fully applied so autosave begins comparing against the restored
    // state (not the blank initial state, which would wipe a saved profile).
    function markProfileReady() {
        if (_profileReady) return;
        _profileReady = true;
        _lastSnapshot = snapshot();
        startAutosave();
    }

    // ----- init -----

    async function init() {
        let meta;
        try { meta = await (await fetch('/api/meta')).json(); }
        catch (e) { setStatus('Could not reach the backend: ' + e.message); return; }

        app.dates = meta.dates || [];
        app.symbol = meta.symbol || 'OHLC';
        app.totalBars = meta.totalBars || 0;
        app.currentTf = '1';

        const di = $('dateInput');
        if (meta.minDate) di.min = meta.minDate;
        if (meta.maxDate) di.max = meta.maxDate;
        if (!app.dates.length) { setStatus('No OHLC data found in this file.'); return; }

        const tfSel = $('tfSelect');
        tfSel.innerHTML = TF_OPTIONS.map((t) => `<option value="${t}">${TF_LABEL[t]}</option>`).join('');
        tfSel.value = app.currentTf;

        app.focusIdx = lastIdx();
        di.value = app.dates[app.focusIdx];

        app.pricePrecision = await detectPrecision('1');
        const v = createView('1', app.focusIdx);
        app.views.push(v);
        setActiveView(v);

        // Restore this file's saved workspace (drawings + indicators + view
        // layout) if a profile exists. applyProfile stashes the state on the
        // view's `pendingProfile`, which afterLoad applies once data is loaded.
        try {
            const profile = await (await fetch('/api/profile')).json();
            if (profile && Object.keys(profile).length) applyProfile(profile);
            else { _profileReady = true; _lastSnapshot = snapshot(); startAutosave(); }
        } catch (e) {
            report('load profile: ' + (e && e.message ? e.message : e));
            _profileReady = true; _lastSnapshot = snapshot(); startAutosave();
        }

        buildIndicatorMenu();
        buildDrawMenu();

        // Watchlist sidebar (UI now; ticker -> chart loading comes in a later step)
        const sbToggle = $('sbToggle');
        if (sbToggle) sbToggle.addEventListener('click', () => $('app').classList.toggle('collapsed'));
        initSidebarResize();
        const sbSearch = $('sbSearch');
        if (sbSearch) sbSearch.addEventListener('input', applyFilter);
        loadWatchlists();

        tfSel.addEventListener('change', () => {
            const vw = app.activeView; if (!vw) return;
            vw.tf = tfSel.value;
            vw.pendingFocus = vw.focusIdx;
            vw._tfChanged = true;
            vw.chart.setPeriod(tfToPeriod(vw.tf));   // triggers a fresh 'init' load
            scheduleSave();
        });

        $('zoomInBtn').addEventListener('click', () => zoom(1.25));
        $('zoomOutBtn').addEventListener('click', () => zoom(0.8));
        $('resetBtn').addEventListener('click', () => { if (app.activeView) resetZoom(app.activeView); scheduleSave(); });
        $('latestBtn').addEventListener('click', () => navTo(lastIdx()));

        const splitBtn = $('splitBtn'), linkBtn = $('linkBtn');
        splitBtn.addEventListener('click', () => {
            setSplit(!app.split);
            splitBtn.classList.toggle('active', app.split);
            scheduleSave();
            if (app.split && !app.linked) { /* Link stays off until toggled */ }
        });
        linkBtn.addEventListener('click', () => {
            if (!app.split || app.views.length < 2) {
                setStatus('Link only applies in Split mode (two panes). Toggle Split first.');
                return;
            }
            app.linked = !app.linked;
            linkBtn.classList.toggle('active', app.linked);
            if (app.linked) syncLink(app.activeView);
            updateStatus();
            scheduleSave();
        });

        $('prevBtn').addEventListener('click', () => navTo(app.focusIdx - 1));
        $('nextBtn').addEventListener('click', () => navTo(app.focusIdx + 1));
        di.addEventListener('change', () => {
            const val = di.value, idx = app.dates.indexOf(val);
            if (idx >= 0) navTo(idx);
            else setStatus('No data for ' + val + ' (pick a trading day between ' + meta.minDate + ' and ' + meta.maxDate + ')');
        });

        const ind = wireMenu('indBtn', 'indMenu', 'drawMenu');
        const draw = wireMenu('drawBtn', 'drawMenu', 'indMenu');
        document.addEventListener('click', (e) => {
            if (!ind.menu.classList.contains('hidden') && !ind.menu.contains(e.target) && !ind.btn.contains(e.target)) ind.menu.classList.add('hidden');
            if (!draw.menu.classList.contains('hidden') && !draw.menu.contains(e.target) && !draw.btn.contains(e.target)) draw.menu.classList.add('hidden');
            const isPanel = $('indSettings');
            // Ignore dismissals within a short window of opening (see
            // _panelOpenedAt / openSettingsPanel) so the gesture that opened the
            // panel (e.g. the native gear, canvas mousedown) doesn't immediately
            // close it when its click bubbles here.
            if (isPanel && Date.now() - _panelOpenedAt > 200 && !isPanel.classList.contains('hidden') &&
                !isPanel.contains(e.target)) {
                isPanel.classList.add('hidden');
            }
        });

        document.addEventListener('keydown', (e) => {
            const t = e.target && e.target.tagName;
            if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
            switch (e.key) {
                case 'ArrowLeft': navTo(app.focusIdx - 1); break;
                case 'ArrowRight': navTo(app.focusIdx + 1); break;
                case '+': case '=': zoom(1.25); break;
                case '-': case '_': zoom(0.8); break;
                case '0': if (app.activeView) resetZoom(app.activeView); break;
                case 'i': case 'I': ind.menu.classList.toggle('hidden'); draw.menu.classList.add('hidden'); break;
                default: return;
            }
            e.preventDefault();
        });

        setStatus(app.dates.length + ' trading days · ' + app.totalBars + ' bars · loading…');
    }

    // ----- watchlist sidebar (UI only; ticker -> chart wiring comes later) -----
    // ----- sidebar resize (drag handle) -----
    function initSidebarResize() {
        const sb = $('sidebar'), handle = $('sbResize'), appEl = $('app');
        if (!sb || !handle || !appEl) return;
        let dragging = false;
        handle.addEventListener('mousedown', (e) => {
            dragging = true;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const rect = appEl.getBoundingClientRect();
            let w = e.clientX - rect.left;
            w = Math.max(160, Math.min(480, w));
            sb.style.flexBasis = w + 'px';
            sb.style.width = w + 'px';
        });
        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            document.body.style.cursor = '';
        });
    }

    const wlState = { lists: [], open: {}, selected: null };

    async function loadWatchlists() {
        try {
            const res = await fetch('/api/watchlists');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            wlState.lists = (data && data.watchlists) || [];
            renderWatchlists();
        } catch (e) {
            report('watchlists: ' + (e && e.message ? e.message : e));
        }
    }

    function renderWatchlists() {
        const root = $('watchlists');
        if (!root) return;
        root.innerHTML = '';
        wlState.lists.forEach((wl) => {
            const sec = document.createElement('div');
            sec.className = 'wl' + (wlState.open[wl.name] ? ' open' : '');

            const head = document.createElement('div');
            head.className = 'wl-head';
            head.innerHTML = '<span class="wl-chev">&#9656;</span>' +
                '<span class="wl-name"></span><span class="wl-count"></span>';
            head.querySelector('.wl-name').textContent = wl.name;
            head.querySelector('.wl-count').textContent = (wl.symbols || []).length;
            head.addEventListener('click', () => {
                wlState.open[wl.name] = !wlState.open[wl.name];
                sec.classList.toggle('open', wlState.open[wl.name]);
            });

            const ul = document.createElement('ul');
            ul.className = 'wl-items';
            (wl.symbols || []).forEach((sym) => {
                const li = document.createElement('li');
                li.className = 'wl-item';
                li.textContent = sym;
                li.dataset.sym = sym;
                li.dataset.wl = wl.name;
                if (sym === app.symbol) {
                    li.classList.add('sel');
                    wlState.selected = { wl: wl.name, sym: sym };
                    sec.classList.add('open');
                    wlState.open[wl.name] = true;
                }
                li.addEventListener('click', () => selectTicker(wl.name, sym, li));
                ul.appendChild(li);
            });

            sec.appendChild(head);
            sec.appendChild(ul);
            root.appendChild(sec);
        });
        applyFilter();
    }

    function selectTicker(wl, sym, li) {
        const prev = document.querySelector('.wl-item.sel');
        if (prev) prev.classList.remove('sel');
        if (li) li.classList.add('sel');
        wlState.selected = { wl: wl, sym: sym };
        openTicker(wl, sym);
    }

    // Switch the active view to a different ticker resolved via the backend's
    // per-ticker API. We rebuild the views from scratch (mirroring init) so the
    // new ticker's own saved profile (drawings + indicators) loads cleanly.
    function loadViews(meta, profile) {
        // Tear down any existing views/charts.
        app.views.forEach((v) => {
            try { if (v.chart && v.chart.dispose) v.chart.dispose(); } catch (e) {}
            if (v.root && v.root.remove) v.root.remove();
        });
        app.views = [];
        app.split = false; app.linked = false;
        const sb = $('splitBtn'); if (sb) sb.classList.remove('active');
        const lb = $('linkBtn'); if (lb) lb.classList.remove('active');

        const v = createView(app.currentTf || '1', app.focusIdx);
        app.views.push(v);
        setActiveView(v);

        if (profile && Object.keys(profile).length) applyProfile(profile);
        else { _profileReady = true; _lastSnapshot = snapshot(); startAutosave(); }
    }

    async function openTicker(wl, sym) {
        setStatus('Loading ' + sym + ' (' + wl + ') …');
        let meta;
        try {
            const res = await fetch('/api/open?wl=' + encodeURIComponent(wl) +
                                    '&sym=' + encodeURIComponent(sym));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            meta = await res.json();
        } catch (e) {
            setStatus('Failed to open ' + sym + ': ' + (e && e.message ? e.message : e));
            return;
        }
        if (!meta || !meta.dates || !meta.dates.length) {
            setStatus('No data for ' + sym);
            return;
        }

        app.symbol = meta.symbol || sym;
        app.dates = meta.dates;
        app.totalBars = meta.totalBars || 0;
        app.focusIdx = lastIdx();
        app.currentTf = app.currentTf || '1';

        const di = $('dateInput');
        if (meta.minDate) di.min = meta.minDate;
        if (meta.maxDate) di.max = meta.maxDate;
        di.value = app.dates[app.focusIdx];

        app.pricePrecision = await detectPrecision(app.currentTf || '1');
        _profileReady = false;
        let profile = {};
        try { profile = await (await fetch('/api/profile')).json(); }
        catch (e) { report('load profile: ' + (e && e.message ? e.message : e)); }

        loadViews(meta, profile);
        setStatus(app.symbol + '  •  ' + app.dates.length + ' trading days  •  ' +
                  app.totalBars + ' bars');
    }

    function applyFilter() {
        const sb = $('sbSearch');
        const q = (sb ? sb.value : '').trim().toLowerCase();
        document.querySelectorAll('#watchlists .wl').forEach((sec) => {
            let any = false;
            sec.querySelectorAll('.wl-item').forEach((li) => {
                const hit = !q || li.dataset.sym.toLowerCase().indexOf(q) >= 0;
                li.style.display = hit ? '' : 'none';
                if (hit) any = true;
            });
            if (q) {
                sec.classList.toggle('open', any);
                const nm = sec.querySelector('.wl-name').textContent;
                if (nm) wlState.open[nm] = any;
            }
        });
    }

    window.addEventListener('DOMContentLoaded', init);
})();
