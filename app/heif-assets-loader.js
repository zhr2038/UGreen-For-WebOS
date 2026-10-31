(() => {
  'use strict';
  const source = new URL('heif-assets.js', document.currentScript?.src || document.baseURI).href;
  const abortError = () => new DOMException('HEIF component loading cancelled', 'AbortError');
  function loadAssets({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (window.CloudFrameHeifAssets) return Promise.resolve(window.CloudFrameHeifAssets);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script'); let done = false;
      const finish = error => {
        if (done) return; done = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort); script.onload = script.onerror = null; script.remove();
        error ? reject(error) : resolve(window.CloudFrameHeifAssets);
      };
      const abort = () => finish(abortError());
      const timer = setTimeout(() => finish(Object.assign(new Error('HEIF 组件加载超时'), { code: 'HEIF_TIMEOUT' })), 15000);
      script.onload = () => finish(window.CloudFrameHeifAssets ? null : new Error('HEIF 组件内容无效'));
      script.onerror = () => finish(new Error('HEIF 组件无法加载'));
      signal?.addEventListener('abort', abort, { once: true }); script.src = source; document.head.appendChild(script);
    });
  }
  window.CloudFrameHeifConfig = { ...(window.CloudFrameHeifConfig || {}), loadAssets };
})();
