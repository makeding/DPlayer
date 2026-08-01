declare module 'worker-loader?inline=no-fallback!*' {
    class InlineWorker extends Worker {
        constructor();
    }
    export default InlineWorker;
}
