// Shared math helpers for the custom indicators. Attached to window.INDU.
//
// KLineChart bar objects are { timestamp, open, high, low, close }; the pivot
// helpers work off the bar INDEX (dataIndex) because that is the coordinate
// space KLineChart's xAxis.convertToPixel() expects.
window.INDU = window.INDU || {};

(function (U) {
    'use strict';

    U.inRange = function (x, lo, hi) { return x >= lo && x <= hi; };

    // Swing highs/lows: a bar that is strictly more extreme than `left` bars on
    // both sides. Returns points sorted by index: { i, price, type: 'H'|'L' }.
    U.pivots = function (bars, left) {
        const pts = [];
        for (let i = left; i < bars.length - left; i++) {
            let isH = true, isL = true;
            for (let j = 1; j <= left; j++) {
                if (bars[i - j].high >= bars[i].high) isH = false;
                if (bars[i + j].high >= bars[i].high) isH = false;
                if (bars[i - j].low <= bars[i].low) isL = false;
                if (bars[i + j].low <= bars[i].low) isL = false;
                if (!isH && !isL) break;
            }
            if (isH) pts.push({ i, price: bars[i].high, type: 'H' });
            if (isL) pts.push({ i, price: bars[i].low, type: 'L' });
        }
        return pts.sort(function (a, b) { return a.i - b.i; });
    };

    // True when four consecutive pivots alternate high/low/high/low.
    U.alt = function (a, b, c, d) {
        return (a.type !== b.type) && (b.type !== c.type) && (c.type !== d.type);
    };
})(window.INDU);
