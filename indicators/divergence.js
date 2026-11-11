// Divergence — multi-oscillator confirmation overlay on the main pane.
//
// Detects REGULAR divergences between price swings and a basket of oscillators
// that are known to diverge (RSI, MACD, CCI, Stochastic, ROC, Williams %R).
//   Bullish (regular): price makes a LOWER LOW but the oscillator makes a
//                      HIGHER LOW  -> potential up reversal.
//   Bearish (regular): price makes a HIGHER HIGH but the oscillator makes a
//                      LOWER HIGH  -> potential down reversal.
//
// The pivot PAIRS come from price (so every oscillator is tested against the
// same pairs). We aggregate confirmations per pair and, when >=1 oscillator
// agrees, draw one connector plus a label listing every confirming indicator
// ("DIV↑ RSI, MACD, CCI"). More names = stronger confirmation, which is the
// whole point of the multi-indicator approach (as used on TradingView).
//
// Oscillators are volume-free because this viewer's bars carry no volume.
(function () {
    'use strict';

    const COL_BULL = '#26a69a';
    const COL_BEAR = '#ef5350';
    const cache = new Map();   // indicator.id -> divergence groups

    // ---------- oscillator helpers (arrays aligned with dataList) ----------
    function ema(vals, period) {
        const n = vals.length, out = new Array(n).fill(NaN);
        const k = 2 / (period + 1);
        let prev = NaN, started = false;
        for (let i = 0; i < n; i++) {
            const v = vals[i];
            if (v == null || isNaN(v)) continue;
            if (!started) { prev = v; started = true; out[i] = v; }
            else { prev = v * k + prev * (1 - k); out[i] = prev; }
        }
        return out;
    }

    function rsiArr(closes, period) {
        const n = closes.length, out = new Array(n).fill(NaN);
        let g = 0, l = 0;
        for (let i = 1; i < n; i++) {
            const ch = closes[i] - closes[i - 1];
            const gain = ch > 0 ? ch : 0, loss = ch < 0 ? -ch : 0;
            if (i <= period) {
                g += gain; l += loss;
                if (i === period) {
                    g /= period; l /= period;
                    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
                }
            } else {
                g = (g * (period - 1) + gain) / period;
                l = (l * (period - 1) + loss) / period;
                out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
            }
        }
        return out;
    }

    function macdArr(closes, fast, slow) {
        const ef = ema(closes, fast), es = ema(closes, slow), n = closes.length;
        const out = new Array(n).fill(NaN);
        for (let i = 0; i < n; i++)
            if (!isNaN(ef[i]) && !isNaN(es[i])) out[i] = ef[i] - es[i];
        return out;
    }

    function cciArr(high, low, close, period) {
        const n = high.length, out = new Array(n).fill(NaN);
        for (let i = period - 1; i < n; i++) {
            let sum = 0, ad = 0;
            for (let j = 0; j < period; j++) {
                const tp = (high[i - j] + low[i - j] + close[i - j]) / 3;
                sum += tp;
            }
            const ma = sum / period;
            for (let j = 0; j < period; j++) {
                const tp = (high[i - j] + low[i - j] + close[i - j]) / 3;
                ad += Math.abs(tp - ma);
            }
            const md = ad / period;
            out[i] = md === 0 ? 0 : (tp0(close, high, low, i) - ma) / (0.015 * md);
        }
        return out;
        function tp0(c, h, l, i) { return (h[i] + l[i] + c[i]) / 3; }
    }

    function stochArr(high, low, close, kPeriod) {
        const n = high.length, raw = new Array(n).fill(NaN);
        for (let i = kPeriod - 1; i < n; i++) {
            let hh = -Infinity, ll = Infinity;
            for (let j = 0; j < kPeriod; j++) {
                hh = Math.max(hh, high[i - j]);
                ll = Math.min(ll, low[i - j]);
            }
            raw[i] = (hh === ll) ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
        }
        return ema(raw, 3);
    }

    function rocArr(closes, period) {
        const n = closes.length, out = new Array(n).fill(NaN);
        for (let i = period; i < n; i++) {
            const base = closes[i - period];
            out[i] = base === 0 ? 0 : ((closes[i] - base) / base) * 100;
        }
        return out;
    }

    function williamsRArr(high, low, close, period) {
        const n = high.length, out = new Array(n).fill(NaN);
        for (let i = period - 1; i < n; i++) {
            let hh = -Infinity, ll = Infinity;
            for (let j = 0; j < period; j++) {
                hh = Math.max(hh, high[i - j]);
                ll = Math.min(ll, low[i - j]);
            }
            out[i] = (hh === ll) ? 0 : ((hh - close[i]) / (hh - ll)) * -100;
        }
        return out;
    }

    // ---------- detection ----------
    function oscEvents(pricePiv, vals, type) {
        const seq = pricePiv.filter(p => p.type === type).sort((a, b) => a.i - b.i);
        const ev = [];
        for (let k = 1; k < seq.length; k++) {
            const a = seq[k - 1], b = seq[k];
            if (b.i <= a.i) continue;
            const priceExtreme = (type === 'L') ? (b.price < a.price) : (b.price > a.price);
            if (!priceExtreme) continue;
            const oscA = vals[a.i], oscB = vals[b.i];
            if (oscA == null || isNaN(oscA) || oscB == null || isNaN(oscB)) continue;
            // Standard pivot-to-pivot comparison: for a regular bullish divergence
            // (price lower low) the oscillator must be HIGHER at the 2nd low; for
            // bearish (price higher high) the oscillator must be LOWER at the 2nd high.
            const oscOpposite = (type === 'L') ? (oscB > oscA) : (oscB < oscA);
            if (oscOpposite) ev.push({ a: a, b: b });
        }
        return ev;
    }

    function detect(bars, left) {
        const U = window.INDU;
        const pricePiv = U.pivots(bars, left);
        const close = bars.map(b => b.close), high = bars.map(b => b.high), low = bars.map(b => b.low);

        const oscs = [
            { name: 'RSI', vals: rsiArr(close, 14) },
            { name: 'MACD', vals: macdArr(close, 12, 26) },
            { name: 'CCI', vals: cciArr(high, low, close, 20) },
            { name: 'STO', vals: stochArr(high, low, close, 14) },
            { name: 'ROC', vals: rocArr(close, 12) },
            { name: 'WPR', vals: williamsRArr(high, low, close, 14) },
        ];

        const groups = new Map();
        function add(type, ev, name) {
            for (const e of ev) {
                const key = type + ':' + e.a.i + ':' + e.b.i;
                if (!groups.has(key)) groups.set(key, { type: type, a: e.a, b: e.b, names: [] });
                groups.get(key).names.push(name);
            }
        }
        for (const o of oscs) {
            add('L', oscEvents(pricePiv, o.vals, 'L'), o.name);
            add('H', oscEvents(pricePiv, o.vals, 'H'), o.name);
        }
        return Array.from(groups.values());
    }

    klinecharts.registerIndicator({
        name: 'DIVERGENCE',
        shortName: 'Divergence',
        series: 'price',
        shouldOhlc: true,
        calcParams: [5],          // pivot lookback for price swings
        precision: 2,
        figures: [],
        calc(dataList, indicator) {
            const left = Math.max(1, indicator.calcParams[0] | 0);
            const groups = dataList.length ? detect(dataList, left) : [];
            cache.set(indicator.id, groups);
            const res = new Array(dataList.length);
            for (let i = 0; i < dataList.length; i++) res[i] = {};
            return res;
        },
        draw({ ctx, indicator, xAxis, yAxis }) {
            const groups = cache.get(indicator.id);
            if (!groups || !groups.length) return true;

            ctx.save();
            ctx.font = 'bold 10px "Helvetica Neue", Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.setLineDash([4, 3]);

            for (const g of groups) {
                const bull = (g.type === 'L');
                ctx.strokeStyle = bull ? COL_BULL : COL_BEAR;
                ctx.fillStyle = bull ? COL_BULL : COL_BEAR;
                ctx.lineWidth = 1;

                const x1 = xAxis.convertToPixel(g.a.i), x2 = xAxis.convertToPixel(g.b.i);
                const y1 = yAxis.convertToPixel(g.a.price), y2 = yAxis.convertToPixel(g.b.price);

                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.beginPath(); ctx.arc(x1, y1, 2.5, 0, Math.PI * 2); ctx.fill();
                ctx.beginPath(); ctx.arc(x2, y2, 2.5, 0, Math.PI * 2); ctx.fill();

                // List every confirming oscillator. The colour already encodes the
                // direction (teal = bullish, red = bearish), so no arrow/prefix is
                // needed; the names are stacked as a small column for readability.
                // Offset one full row beyond the pivot price so the labels clear the
                // HHLL labels (which sit ~4px off the pivot) instead of overlapping.
                const lineH = 11;
                const LABEL_GAP = 16;
                ctx.textAlign = 'center';
                if (bull) {
                    ctx.textBaseline = 'top';
                    let y = y2 + LABEL_GAP;
                    for (const nm of g.names) { ctx.fillText(nm, x2, y); y += lineH; }
                } else {
                    ctx.textBaseline = 'bottom';
                    let y = y2 - LABEL_GAP;
                    for (let k = 0; k < g.names.length; k++) { ctx.fillText(g.names[k], x2, y); y -= lineH; }
                }
                ctx.setLineDash([4, 3]);
            }

            ctx.restore();
            return true;
        },
    });

    window.INDICATORS = window.INDICATORS || [];
    window.INDICATORS.push({ name: 'DIVERGENCE', label: 'Divergence (multi-osc)', overlay: true, tfApply: true });
})();
