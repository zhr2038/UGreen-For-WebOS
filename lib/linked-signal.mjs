export function linkSignals(signals) {
  const active = signals.filter(Boolean);
  if (active.length <= 1) {
    return { signal: active[0], dispose() {} };
  }
  const controller = new AbortController();
  const listeners = [];
  const dispose = () => {
    while (listeners.length) {
      const [source, fn] = listeners.pop();
      source.removeEventListener('abort', fn);
    }
  };
  for (const source of active) {
    if (source.aborted) {
      dispose();
      controller.abort(source.reason);
      return { signal: controller.signal, dispose };
    }
    const onAbort = () => {
      dispose();
      controller.abort(source.reason);
    };
    source.addEventListener('abort', onAbort, { once: true });
    listeners.push([source, onAbort]);
  }
  return { signal: controller.signal, dispose };
}
