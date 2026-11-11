// Average True Range — own pane, Wilder smoothing.
//
// Registers itself with KLineChart and advertises itself to app.js through
// window.INDICATORS. `overlay: false` puts it on its own pane.
(function () {
    'use strict';

    klinecharts.registerIndicator({
        name: 'ATR',
        shortName: 'ATR',
        calcParams: [14],
        precision: 2,
        figures: [{ key: 'atr', title: 'ATR: ', type: 'line' }],
        styles: { lines: [{ color: '#787b86', size: 1 }] },
        regenerateFigures(params) {
            return [{ key: 'atr', title: 'ATR(' + params[0] + '): ', type: 'line' }];
        },
        calc(dataList, indicator) {
            const p = Math.max(1, indicator.calcParams[0] | 0);
            const res = [];
            let sum = 0, prev = 0;
            for (let i = 0; i < dataList.length; i++) {
                const b = dataList[i];
                const tr = (i === 0)
                    ? b.high - b.low
                    : Math.max(
                        b.high - b.low,
                        Math.abs(b.high - dataList[i - 1].close),
                        Math.abs(b.low - dataList[i - 1].close)
                    );
                if (i < p) sum += tr;
                if (i === p - 1) { prev = sum / p; res.push({ atr: prev }); }
                else if (i >= p) { prev = (prev * (p - 1) + tr) / p; res.push({ atr: prev }); }
                else res.push({});
            }
            return res;
        },
    });

    window.INDICATORS = window.INDICATORS || [];
    window.INDICATORS.push({ name: 'ATR', label: 'ATR', overlay: false });
})();
