(() => {
  'use strict';
  const cancelled = () => new DOMException('Playback changed', 'AbortError');
  window.createMovieMedia = ({ video, api, asset, getPlayback, onChange = () => {}, onWarning = () => {}, captureTracks = () => null, restoreTracks = async () => {}, timeoutMs = 45000 }) => {
    let operation, generation = 0;
    const current = p => getPlayback() === p;
    function cancel() { generation++; operation?.controller.abort(); operation?.rollbackController?.abort(); }
    function load(url, { position, paused, rate }, signal, isCurrent = () => true) {
      return new Promise((resolve, reject) => {
        let settled = false, expected = url;
        const finish = error => {
          if (settled) return; settled = true; clearTimeout(timer);
          for (const [name, handler] of listeners) video.removeEventListener(name, handler);
          signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve();
        };
        const metadata = () => {
          if (!isCurrent() || video.src !== expected) return finish(cancelled());
          try {
            if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.max(0, Math.min(position, video.duration - .1));
            video.playbackRate = rate;
          } catch (error) { finish(error); }
        };
        const ready = () => { if (!isCurrent() || video.src !== expected) return finish(cancelled()); if (video.readyState >= 2 && !video.seeking) finish(); };
        const abort = () => finish(cancelled());
        const listeners = [['loadedmetadata', metadata], ['loadeddata', ready], ['canplay', ready], ['seeked', ready], ['error', () => finish(new Error('电视无法解码这个画质'))]];
        const timer = setTimeout(() => finish(new Error('画质切换超时')), timeoutMs);
        for (const [name, handler] of listeners) video.addEventListener(name, handler);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        if (!isCurrent()) { abort(); return; }
        video.preload = 'auto'; video.src = url; expected = video.src; video.load();
        if (!paused) Promise.resolve(video.play()).catch(finish);
        if (video.readyState >= 1) metadata();
        ready();
      });
    }
    async function switchSource(candidate, context) {
      const p = context.playback;
      const connection = p?.connection;
      const discard = () => api('/api/play/quality', { id: context.id, candidateId: candidate.candidateId, action: 'discard' }, undefined, connection).catch(() => {});
      if (!p || !candidate.candidateId || !current(p) || !context.isCurrent() || context.signal?.aborted) { await discard(); throw cancelled(); }
      cancel(); const epoch = generation, controller = new AbortController();
      const job = { controller, committing: false, playback: p }; operation = job;
      const old = { url: video.currentSrc || video.src, position: Number.isFinite(video.currentTime) ? video.currentTime : 0, duration: Number.isFinite(video.duration) ? video.duration : p.duration, paused: video.paused, rate: video.playbackRate || 1, preload: video.preload, tracks: captureTracks() }; job.old = old;
      const abort = () => { if (!job.committing) controller.abort(); };
      context.signal?.addEventListener('abort', abort, { once: true });
      const live = () => epoch === generation && current(p) && !controller.signal.aborted;
      try {
        await load(context.sourceUrl || asset(candidate.stream), old, controller.signal, live);
        job.ready = true;
        await restoreTracks(old.tracks, { isCurrent: live });
        if (!live() || !context.isCurrent()) throw cancelled();
        // Once sent, commit is reconciled even if the settings panel closes.
        // Aborting the HTTP response cannot roll back a NAS task transaction.
        job.committing = true;
        let active;
        try { active = await api('/api/play/quality', { id: p.id, candidateId: candidate.candidateId, action: 'commit' }, undefined, connection); }
        catch (error) {
          // Read the authoritative source after an uncertain commit response.
          const actual = await api('/api/play/active?id=' + encodeURIComponent(p.id), undefined, undefined, connection).catch(() => null);
          if (actual?.sourceId !== candidate.candidateId) {
            if (!actual) { error.commitUnknown = true; onWarning('画质提交结果尚未确认，请返回影片后重新打开'); }
            throw error;
          }
          active = actual;
        }
        if (!current(p) || epoch !== generation) return active;
        Object.assign(p, { sourceId: active.sourceId, stream: active.stream, kind: active.kind, quality: active.quality, position: old.position });
        for (const warning of active.warnings || []) onWarning(warning.message);
        onChange(p); return active;
      } catch (error) {
        if (!error.commitUnknown && current(p) && epoch === generation && old.url) {
          job.ready = false;
          // The service retains the active source until commit succeeds.
          const rollback = new AbortController(); job.rollbackController = rollback;
          const restoring = () => epoch === generation && current(p) && !rollback.signal.aborted;
          try { await load(old.url, old, rollback.signal, restoring); await restoreTracks(old.tracks, { isCurrent: restoring }); }
          catch (restoreError) { if (restoring() && restoreError.name !== 'AbortError') onWarning('原画质恢复失败，请重新打开影片'); }
        }
        if (!error.commitUnknown) await discard(); throw error;
      } finally {
        context.signal?.removeEventListener('abort', abort);
        if (operation === job) { operation = null; video.preload = old.preload; }
      }
    }
    function snapshot() {
      if (!operation || !current(operation.playback)) return null;
      if (operation.ready && video.readyState >= 2 && Number.isFinite(video.currentTime) && Number.isFinite(video.duration) && video.duration > 0) return { position: video.currentTime, duration: video.duration };
      return { position: operation.old.position, duration: operation.old.duration };
    }
    return { switchSource, cancel, switching: () => Boolean(operation && current(operation.playback)), snapshot, load };
  };
})();
