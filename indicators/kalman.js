// Kalman filter — overlay on the main pane.
//
// A scalar random-walk Kalman smoother on closing price: it predicts a gently
// drifting state and corrects it with each new bar, so the line tracks the trend
// while rejecting noise.
//   calcParams[0] = Q (process noise)     — higher = more responsive / noisier
//   calcParams[1] = R (measurement noise) — higher = smoother
(function () {
    'use strict';

    klinecharts.registerIndicator({
        name: 'KALMAN',
        shortName: 'Kalman',
        series: 'price',
        shouldOhlc: true,
        calcParams: [0.01, 1],
        precision: 2,
        figures: [{ key: 'kalman', title: 'Kalman: ', type: 'line' }],
        styles: { lines: [{ color: '#9b59b6', size: 2 }] },
        calc(dataList, indicator) {
            const Q = Number(indicator.calcParams[0]);
            const R = Number(indicator.calcParams[1]);
            const res = [];
            let x = null, P = 1;
            for (let i = 0; i < dataList.length; i++) {
                const z = dataList[i].close;
                if (x === null) x = z;
                P = P + Q;                  // predict
                const K = P / (P + R);      // gain
                x = x + K * (z - x);        // correct
                P = (1 - K) * P;
                res.push({ kalman: x });
            }
            return res;
        },
    });

    window.INDICATORS = window.INDICATORS || [];
    window.INDICATORS.push({ name: 'KALMAN', label: 'Kalman Filter', overlay: true });
})();
