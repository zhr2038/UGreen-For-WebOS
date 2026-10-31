async page => {
  const base = '__PLAYER_OPTIONS_BASE__'; const results = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  await page.setViewportSize({ width: 1920, height: 1080 });
  async function boot(config = {}) {
    await page.goto(base);
    await page.evaluate(config => {
      const video = document.querySelector('video');
      const nativeAudio = [{ enabled: true, label: 'English', language: 'en' }, { enabled: false, label: '中文', language: 'zh' }];
      const nativeText = [{ mode: 'disabled', kind: 'subtitles', label: '中文', language: 'zh' }];
      Object.defineProperty(video, 'audioTracks', { configurable: true, value: nativeAudio }); Object.defineProperty(video, 'textTracks', { configurable: true, value: nativeText });
      window.po = { calls: [], switches: [], events: [], play: { id: 'play-one', title: '示例影片' }, config, closed: 0, options: { qualities: [{ id: 'original', label: '原画', original: true }, { id: '480P@720x400', label: '480P · 标清', resolution: '720x400' }], audio: Array.from({ length: 4 }, (_, i) => ({ id: 'audio:' + (4352 + i), label: 'NAS ' + i })), subtitles: [{ id: 'external:known', kind: 'external', label: '示例.srt', codec: 'srt' }], selected: 'original' } };
      const api = async (path, body, signal) => {
        po.calls.push({ path, body, signal });
        if (path.startsWith('/api/play/options')) { if (config.optionsError) throw new Error('NAS offline'); return structuredClone(po.options); }
        if (path === '/api/play/quality') { if (config.slowQuality) await new Promise(resolve => po.releaseQuality = resolve); return config.emptySource ? {} : { stream: '/media/local-hls', quality: { id: body.qualityId }, kind: 'hls' }; }
        if (path === '/api/play/preferences') { if (config.preferencesError) throw new Error('network offline'); return { ok: true }; }
        if (path === '/api/play/subtitle') {
          if (body.action === 'search') return { items: [{ id: 'result-one', label: '在线字幕', language: 'zh-cn' }] };
          if (body.action === 'delete') { po.options.subtitles = []; return { ok: true }; }
          return { status: 1 };
        }
        throw new Error('Unexpected API route');
      };
      let tracks;
      if (config.tracks) tracks = { state: () => ({ audio: nativeAudio.map((a,i) => ({ ...a, id: 'runtime-audio:' + i, index: i })), subtitles: nativeText.map((a,i) => ({ ...a, showing: a.mode === 'showing', id: 'runtime-text:' + i, index: i })) }), selectAudio: id => { po.events.push({ audio: id }); nativeAudio.forEach((a,i) => a.enabled = id === 'runtime-audio:' + i); }, selectText: id => { po.events.push({ text: id }); nativeText[0].mode = 'showing'; }, off: () => { po.events.push({ off: true }); nativeText.forEach(t => t.mode = 'disabled'); }, selectExternal: async id => { po.events.push({ external: id }); await api('/api/play/subtitle', { id: po.play.id, subtitleId: id, format: 'vtt' }); }, setOffset: value => { po.events.push({ offset: value }); return { applied: true }; }, setStyle: value => { po.events.push({ style: value }); return { applied: true }; }, selectLanguage: () => ({ applied: false }), setRate: rate => video.playbackRate = rate, setFit: fit => video.style.objectFit = fit };
      po.panel = window.createPlayerOptions({ video, api, asset: path => 'http://127.0.0.1' + path, root: document.querySelector('#dialog'), getPlayback: () => po.play, tracks, toast: message => po.events.push({ toast: message }), onClose: () => po.closed++, onSourceSwitch: async (response, context) => po.switches.push({ response, id: context.id, sourceUrl: context.sourceUrl, paused: context.paused }) });
    }, config);
  }
  const open = async name => { await page.evaluate(name => po.panel.open(name), name); await page.waitForSelector('.player-options'); };
  const click = (action, value) => page.locator(`[data-po-action="${action}"]${value !== undefined ? `[data-po-value="${value}"]` : ''}`).click();
  async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: error.message }); } }

  await test('动态画质仅使用 NAS 档位并通过注入回调切源', async () => {
    await boot(); await open('quality'); assert(await page.locator('[data-po-action="quality"]').count() === 2, 'Manufactured a quality'); assert(await page.locator('[data-po-value="original"]').getAttribute('aria-pressed') === 'true', 'Original not default');
    await click('quality', '480P@720x400'); await page.waitForFunction(() => po.switches.length === 1);
    assert(await page.evaluate(() => po.switches[0].id === 'play-one' && po.switches[0].sourceUrl.endsWith('/media/local-hls')), 'Wrong play/context');
  });
  await test('慢切源禁用重复按钮，退出后迟到响应不会换片', async () => {
    await boot({ slowQuality: true }); await open('quality'); await click('quality', '480P@720x400'); assert(await page.locator('[data-po-action="quality"]').first().isDisabled(), 'Buttons not busy');
    await page.locator('[data-po-back]').click(); await page.evaluate(() => { po.play = { id: 'different-play' }; po.releaseQuality(); });
    await page.waitForTimeout(100); assert(await page.evaluate(() => po.switches.length === 0), 'Late quality result switched playback');
  });
  await test('空播放地址不触发切源回调', async () => {
    await boot({ emptySource: true }); await open('quality'); await click('quality', '480P@720x400'); await page.waitForFunction(() => document.querySelector('.po-message').textContent.includes('播放地址'));
    assert(await page.evaluate(() => po.switches.length === 0), 'Empty source was accepted');
  });
  await test('音轨菜单受真实 HTML 轨道数量限制', async () => {
    await boot(); await open('audio'); assert(await page.locator('[data-po-action="audio"]').count() === 2, 'NAS PID list became fake runtime tracks'); await click('audio', 'native-audio:1');
    await page.waitForFunction(() => po.calls.some(c => c.path === '/api/play/preferences')); assert(await page.evaluate(() => document.querySelector('video').audioTracks[1].enabled), 'Audio setter not used');
  });
  await test('字幕样式延迟语言、六档速度及三种队列模式均可操作', async () => {
    await boot({ tracks: true }); await open('subtitleStyle'); await click('offset', '0.05'); await page.waitForFunction(() => po.events.some(e => e.offset === .05)); await click('size', '125'); await page.waitForFunction(() => po.events.some(e => e.style?.size === 125));
    await page.waitForFunction(() => document.activeElement?.dataset.poAction === 'size' && document.activeElement.dataset.poValue === '125');
    await page.evaluate(() => po.panel.key(new KeyboardEvent('keydown', { keyCode: 40, cancelable: true })));
    assert(await page.evaluate(() => document.activeElement?.dataset.poValue === '200'), 'Grid Down did not reach the next row');
    await page.locator('[data-po-action="size"][data-po-value="125"]').focus();
    await page.screenshot({ path: 'output/playwright/player-options-style.png' });
    await open('language'); await click('language', 'zh'); await page.waitForFunction(() => document.querySelector('.po-message').textContent.includes('没有对应'));
    await open('rate'); assert(await page.locator('[data-po-action="rate"]').count() === 6, 'TV rates differ'); await click('rate', '1.5'); await page.waitForFunction(() => document.querySelector('video').playbackRate === 1.5);
    await open('mode'); await click('mode', 'loop_list'); await page.waitForFunction(() => po.panel.mode() === 'loop_list'); assert(await page.evaluate(() => po.panel.nextIndex(2,3) === 0 && document.querySelector('video').onended === null), 'Panel installed its own ended handler or wrong queue behavior');
  });
  await test('偏好同步失败不会谎称保存或回滚已生效的当前倍速', async () => {
    await boot({ preferencesError: true }); await open('rate'); await click('rate', '1.25'); await page.waitForFunction(() => document.querySelector('.po-message').textContent.includes('未保存')); assert(await page.evaluate(() => document.querySelector('video').playbackRate === 1.25), 'Applied rate rolled back');
  });
  await test('外挂字幕选择保存安全文件名，不能把本次临时能力ID写成跨播放偏好', async () => {
    await boot({ tracks: true }); await open('subtitles'); await click('external-subtitle', 'external:known');
    await page.waitForFunction(() => po.calls.some(c => c.path === '/api/play/preferences' && c.body?.preferences?.subtitle?.selection?.kind === 'external'));
    const selection = await page.evaluate(() => po.calls.find(c => c.body?.preferences?.subtitle?.selection?.kind === 'external').body.preferences.subtitle.selection);
    assert(selection.label === '示例.srt' && !('id' in selection), 'External capability persisted instead of safe descriptor');
  });
  await test('hydrate换片清理旧在线结果、字幕关闭标记和队列偏好', async () => {
    await boot({ tracks: true }); await open('mode'); await click('mode', 'loop_single'); await open('subtitles'); await click('subtitle-off');
    await open('online'); await page.locator('[data-po-search] input').fill('旧电影'); await page.locator('[data-po-search] button').click(); await page.waitForSelector('[data-po-action="online-download"]');
    await page.evaluate(() => { po.panel.close(); po.play = { id: 'play-two', title: '下一部电影' }; document.querySelector('video').textTracks[0].mode = 'showing'; po.panel.hydrate({ qualities: [{ id: 'original', label: '原画' }], subtitles: [], preferences: { mode: 'sort_list', rate: 1, fit: 'contain', subtitle: { offset: 0, size: 100, color: '#FFFFFF', position: 90, language: '' } } }); });
    await open('online'); assert(await page.locator('[data-po-action="online-download"]').count() === 0, 'Old search capabilities survived hydrate'); assert(await page.locator('[data-po-search] input').inputValue() === '下一部电影', 'Old query survived hydrate');
    await open('subtitles'); assert(await page.locator('[data-po-action="subtitle-off"]').getAttribute('aria-pressed') !== 'true', 'Old subtitle-off state survived'); assert(await page.evaluate(() => po.panel.mode() === 'sort_list'), 'Old item play mode survived');
  });
  await test('在线搜索不会自动下载，删除必须再次明确确认', async () => {
    await boot({ tracks: true }); await open('subtitles'); await click('open', 'online'); await page.locator('[data-po-search] input').fill('Example'); await page.locator('[data-po-search] button').click(); await page.waitForSelector('[data-po-action="online-download"]');
    assert(await page.evaluate(() => !po.calls.some(c => c.body?.action === 'download')), 'Search triggered a download'); await click('online-download', 'result-one'); await page.waitForFunction(() => po.calls.some(c => c.body?.action === 'download'));
    await open('manage'); await click('confirm-delete', 'external:known'); assert(await page.evaluate(() => !po.calls.some(c => c.body?.action === 'delete')), 'Delete lacked confirmation'); await click('delete', 'external:known'); await page.waitForFunction(() => po.calls.some(c => c.body?.action === 'delete'));
  });
  await test('所有请求局限于约定播放 API 和当前播放 ID', async () => {
    const calls = await page.evaluate(() => po.calls); assert(calls.every(c => /^\/api\/play\/(options|quality|subtitle|preferences)(?:\?|$)/.test(c.path)), 'Unexpected endpoint'); assert(calls.filter(c => c.body).every(c => c.body.id === 'play-one'), 'Cross-play request');
  });
  await test('遥控确定与返回在弹窗内处理，不与播放器暂停键重复触发', async () => {
    await boot(); await open('settings');
    await page.evaluate(() => { const button = document.querySelector('[data-po-action="open"][data-po-value="rate"]'); button.focus(); const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }); po.handled = po.panel.key(event); });
    await page.waitForSelector('.player-options[data-page="rate"]'); assert(await page.evaluate(() => po.handled), 'Enter was not consumed');
    await page.evaluate(() => po.panel.key(new KeyboardEvent('keydown', { keyCode: 461, cancelable: true }))); await page.waitForSelector('.player-options[data-page="settings"]');
    const box = await page.locator('.player-options').boundingBox(); assert(box.x >= 0 && box.y >= 0 && box.y + box.height <= 1080, 'Panel exceeds the TV viewport');
    await page.screenshot({ path: 'output/playwright/player-options-settings.png' });
  });
  const report = { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, cases: results }; if (report.failed) throw new Error(JSON.stringify(report)); return report;
}
