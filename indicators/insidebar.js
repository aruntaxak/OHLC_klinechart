// Inside Bar — overlay on the main candle pane.
//
// An "inside bar" is one whose entire range sits inside the prior bar's range:
//   high[i] <= high[i-1]  AND  low[i] >= low[i-1]
// We outline each inside bar and tag it with "IB". Useful as a consolidation /
// breakout-setup marker. Swing traders read a break of the mother bar as a signal.
(function () {
    'use strict';

    const COLOR = '#9c27b0';
    const cache = new Map();   // indicator.id -> dataList

    klinecharts.registerIndicator({
        name: 'INSIDE_BAR',
        shortName: 'Inside Bar',
        series: 'price',
        shouldOhlc: true,
        calcParams: [],
        precision: 2,
        figures: [],
        calc(dataList, indicator) {
            cache.set(indicator.id, dataList);
            const res = new Array(dataList.length);
            for (let i = 0; i < dataList.length; i++) res[i] = {};
            return res;
        },
        draw({ ctx, indicator, xAxis, yAxis }) {
            const bars = cache.get(indicator.id);
            if (!bars || bars.length < 2) return true;

            ctx.save();
            ctx.strokeStyle = COLOR;
            ctx.fillStyle = COLOR;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 2]);
            ctx.font = '9px "Helvetica Neue", Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            const step = (xAxis.convertToPixel(1) - xAxis.convertToPixel(0)) || 8;
            const half = Math.max(2, step * 0.42);

            for (let i = 1; i < bars.length; i++) {
                const b = bars[i], p = bars[i - 1];
                if (b.high <= p.high && b.low >= p.low) {
                    // Colour by the inside bar's own direction: green = bullish
                    // (close >= open), red = bearish (close < open).
                    const up = b.close >= b.open;
                    ctx.strokeStyle = up ? '#26a69a' : '#ef5350';
                    ctx.fillStyle = up ? '#26a69a' : '#ef5350';
                    const x = xAxis.convertToPixel(i);
                    const yH = yAxis.convertToPixel(b.high);
                    const yL = yAxis.convertToPixel(b.low);
                    ctx.strokeRect(x - half, yH, half * 2, yL - yH);
                    // Label ("IB") is optional — controlled from the settings panel
                    // via indicator.styles.showLabel (default on).
                    const sl = indicator.styles && indicator.styles.showLabel;
                    if (sl !== false) {
                        ctx.setLineDash([]);
                        ctx.fillText('IB', x, yL + 2);
                        ctx.setLineDash([3, 2]);
                    }
                }
            }

            ctx.restore();
            return true;
        },
    });

    window.INDICATORS = window.INDICATORS || [];
    window.INDICATORS.push({ name: 'INSIDE_BAR', label: 'Inside Bar', overlay: true, tfApply: true, labelToggle: true });
})();
