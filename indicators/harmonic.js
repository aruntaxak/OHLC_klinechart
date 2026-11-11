// Harmonic patterns — overlay on the main pane, fully custom canvas drawing.
//
// Heuristic swing-pivot + ratio scanner for Gartley / Butterfly / Bat / Crab.
// Draws the X-A-B-C geometry as a solid orange polyline and projects the C->D
// completion leg as a dashed line. The label at C shows the pattern name and an
// arrow for the expected direction (▲ bullish, ▼ bearish).
//
// The projected D is an equal ABCD leg (CD = AB in both price and bar distance),
// so the 4th line always agrees with the arrow and forms a coherent X-A-B-C-D
// shape. Tune the ratio bands in detect().
//
// KLineChart calls calc() whenever data changes and draw() every frame, so the
// detected geometry is cached per indicator id between the two.
(function () {
    'use strict';

    const MAX_PATTERNS = 15;   // cap drawn patterns to keep the chart readable
    const COLOR = '#ff9800';
    // Per-pattern default colours; overridden at runtime by the settings panel
    // (app.js writes indicator.styles.patterns = { Gartley: '#...', ... }).
    const PATTERN_COLORS = { Gartley: '#ff9800', Butterfly: '#3f51b5', Bat: '#4caf50', Crab: '#e91e63' };
    function patternColor(indicator, pat) {
        const pc = indicator && indicator.styles && indicator.styles.patterns;
        return (pc && pc[pat]) || PATTERN_COLORS[pat] || COLOR;
    }
    const cache = new Map();   // indicator.id -> pattern[]

    function detect(bars, left) {
        const U = window.INDU;
        const piv = U.pivots(bars, left);
        const out = [];
        for (let i = 0; i + 3 < piv.length; i++) {
            const X = piv[i], A = piv[i + 1], B = piv[i + 2], C = piv[i + 3];
            if (!U.alt(X, A, B, C)) continue;
            const XA = Math.abs(A.price - X.price);
            if (XA === 0) continue;
            const AB = Math.abs(B.price - A.price);
            const BC = Math.abs(C.price - B.price);
            if (AB === 0 || BC === 0) continue;
            const abxa = AB / XA, bcab = BC / AB;
            // XA down (A below X) => bullish setup; XA up => bearish.
            const bullish = (A.price - X.price) < 0;
            let pat = null;
            if (U.inRange(abxa, 0.545, 0.625) && U.inRange(bcab, 0.30, 0.55)) pat = 'Gartley';
            else if (U.inRange(abxa, 0.745, 0.795) && U.inRange(bcab, 0.30, 0.55)) pat = 'Butterfly';
            else if (U.inRange(abxa, 0.350, 0.500) && U.inRange(bcab, 0.30, 0.55)) pat = 'Bat';
            else if (U.inRange(abxa, 0.500, 0.700) && U.inRange(bcab, 0.75, 0.95)) pat = 'Crab';
            if (pat) out.push({ X, A, B, C, pat, bullish });
        }
        return out.slice(-MAX_PATTERNS);
    }

    klinecharts.registerIndicator({
        name: 'HARMONIC',
        shortName: 'Harmonic',
        series: 'price',
        shouldOhlc: true,
        calcParams: [5],          // pivot lookback on each side
        precision: 2,
        figures: [],
        calc(dataList, indicator) {
            const left = Math.max(1, indicator.calcParams[0] | 0);
            const pats = dataList.length ? detect(dataList, left) : [];
            cache.set(indicator.id, pats);
            // One (mostly empty) result per bar; the pattern name rides on its C
            // pivot so it shows up in the tooltip.
            const res = new Array(dataList.length);
            for (let i = 0; i < dataList.length; i++) res[i] = {};
            for (const p of pats) if (res[p.C.i]) res[p.C.i] = { pattern: p.pat };
            return res;
        },
        draw({ ctx, indicator, xAxis, yAxis }) {
            const pats = cache.get(indicator.id);
            if (!pats || !pats.length) return true;

            ctx.save();
            ctx.lineWidth = 1;
            ctx.font = '10px "Helvetica Neue", Arial, sans-serif';
            ctx.textAlign = 'center';

            for (const p of pats) {
                const col = patternColor(indicator, p.pat);
                ctx.strokeStyle = col;
                ctx.fillStyle = col;
                const pts = [p.X, p.A, p.B, p.C].map((q) => ({
                    x: xAxis.convertToPixel(q.i),
                    y: yAxis.convertToPixel(q.price),
                }));

                // X -> A -> B -> C
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
                ctx.stroke();

                // Projected C -> D (equal ABCD leg).
                const dIdx = p.C.i + (p.C.i - p.B.i);
                const dPrice = p.C.price + (p.B.price - p.A.price);
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(pts[3].x, pts[3].y);
                ctx.lineTo(xAxis.convertToPixel(dIdx), yAxis.convertToPixel(dPrice));
                ctx.stroke();
                ctx.setLineDash([]);

                // Label + direction arrow at C.
                const label = (p.bullish ? '▲ ' : '▼ ') + p.pat;
                ctx.textBaseline = p.bullish ? 'top' : 'bottom';
                ctx.fillText(label, pts[3].x, pts[3].y + (p.bullish ? 7 : -7));
            }

            ctx.restore();
            return true;   // we drew everything; skip the default figure pass
        },
    });

    window.INDICATORS = window.INDICATORS || [];
    window.INDICATORS.push({ name: 'HARMONIC', label: 'Harmonic Patterns', overlay: true });
})();
