import { simulateHydraulicNetwork } from './lib/hydraulic-simulation.js';
const scope = globalThis;
scope.onmessage = event => {
    try {
        let last = -1;
        const result = simulateHydraulicNetwork(event.data.network, event.data.settings, progress => { const percent = Math.floor(progress * 100); if (percent > last) {
            last = percent;
            scope.postMessage({ progress });
        } });
        scope.postMessage({ result });
    }
    catch (error) {
        scope.postMessage({ error: error.message });
    }
};
//# sourceMappingURL=hydraulic-simulation-worker.js.map