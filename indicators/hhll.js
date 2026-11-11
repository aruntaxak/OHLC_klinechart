// HHLL — Higher-High / Lower-Low / Higher-Low / Lower-High swing labelling.
//
// Overlay on the main pane. We find swing pivots (a bar more extreme than
// `left` bars on each side) and then, walking the pivots in time order, classify
// each against the previous pivot of the SAME type:
//   swing HIGH  > previous HIGH  => HH (Higher High)   else => LH (Lower High)
//   swing LOW   < previous LOW   => LL (Lower Low)     else => HL (Higher Low)
// Bullish labels (HH, HL) are teal; bearish (LH, LL) are red.
(function () {
    'use strict';

    const COL_BULL = '#26a69a';
    const COL_BEAR = '#ef5350';
    const cache = new Map();   // indicator.id -> labelled pivots

    function classify(bars, left) {
        const U = window.INDU;
        const piv = U.pivots(bars, left);
        const out = [];
        let prevHigh = null, prevLow = null;
        for (const q of piv) {
            if (q.type === 'H') {
                let label = null;
                if (prevHigh !== null) label = (q.price > prevHigh) ? 'HH' : 'LH';
                prevHigh = q.price;
                out.push({ i: q.i, price: q.price, label: label, type: 'H' });
            } else {
                let label = null;
                if (prevLow !== null) label = (q.price < prevLow) ? 'LL' : 'HL';
                prevLow = q.price;
                out.push({ i: q.i, price: q.price, label: label, type: 'L' });
            }
        }
        return out;
    }

    klinecharts.registerIndicator({
        name: 'HHLL',
        shortName: 'HHLL',
        series: 'price',
        shouldOhlc: true,
        calcParams: [5],          // pivot lookback on each side
        precision: 2,
        figures: [],
        calc(dataList, indicator) {
            const left = Math.max(1, indicator.calcParams[0] | 0);
            const pts = dataList.length ? classify(dataList, left) : [];
            cache.set(indicator.id, pts);
            const res = new Array(dataList.length);
            for (let i = 0; i < dataList.length; i++) res[i] = {};
            return res;
        },
        draw({ ctx, indicator, xAxis, yAxis }) {
            const pts = cache.get(indicator.id);
            if (!pts || !pts.length) return true;

            ctx.save();
            ctx.font = 'bold 10px "Helvetica Neue", Arial, sans-serif';
            ctx.textAlign = 'center';

            for (const q of pts) {
                if (!q.label) continue;
                const x = xAxis.convertToPixel(q.i);
                const bull = (q.label === 'HH' || q.label === 'HL');
                ctx.fillStyle = bull ? COL_BULL : COL_BEAR;
                if (q.type === 'H') {
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(q.label, x, yAxis.convertToPixel(q.price) - 4);
                } else {
                    ctx.textBaseline = 'top';
                    ctx.fillText(q.label, x, yAxis.convertToPixel(q.price) + 4);
                }
            }

            ctx.restore();
            return true;
        },
    });

    window.INDICATORS = window.INDICATORS || [];
    window.INDICATORS.push({ name: 'HHLL', label: 'HHLL (HH/LL/HL/LH)', overlay: true, tfApply: true });
})();
