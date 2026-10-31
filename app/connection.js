(() => {
  'use strict';
  window.createDirectLogin = ({ root, esc, store, bind, focus, connected, bridgeMode, back }) => {
    const C = { gateway: null, status: null, generation: 0, timer: null, active: false, subscription: null };
    const $ = s => root.querySelector(s);
    async function request(path, data) {
      if (!C.gateway) throw new Error('电视连接服务尚未准备好');
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 35000);
      try {
        const response = await fetch(C.gateway.server + '/api/direct/' + path, { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + C.gateway.token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined, signal: controller.signal });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || '连接失败'); return result;
      } catch (error) { if (error.name === 'AbortError') throw new Error('连接超时，请重试'); throw error; }
      finally { clearTimeout(timeout); }
    }
    function leave() {
      clearTimeout(C.timer); C.timer = null;
      if (C.active) { C.active = false; C.generation++; request('cancel', {}).catch(() => {}); }
      const password = $('#direct-password'); if (password) password.value = '';
    }
    function shell(body, tab = 'password') {
      root.innerHTML = `<main class="screen direct-login"><aside class="login-intro"><span class="login-brand"><img src="icon.png" alt="">云映</span><h1>你的影视与照片<br>在大屏上相见。</h1><p>通过 UGREENlink 连接绿联 NAS</p><span class="login-footnote">海报墙 · 继续观看 · 家庭相册</span></aside><section class="login-content"><h2>登录绿联 NAS</h2><div class="login-tabs"><button id="login-password-tab" aria-pressed="${tab === 'password'}">账号密码</button><button id="login-qr-tab" aria-pressed="${tab === 'qr'}">扫码登录</button></div>${body}<div class="login-footer">${C.status?.connected ? '<button id="direct-back">返回影视中心</button><button id="direct-logout">退出此账号</button>' : ''}<button id="legacy-mode">使用旧版 NAS 服务</button></div></section></main>`;
      bind(); $('#login-password-tab').onclick = () => show('password'); $('#login-qr-tab').onclick = () => show('qr');
      $('#legacy-mode').onclick = () => { leave(); bridgeMode(); };
      if ($('#direct-back')) $('#direct-back').onclick = () => { leave(); back(); };
      if ($('#direct-logout')) $('#direct-logout').onclick = async () => { try { await request('logout', {}); C.status = { connected: false }; show(); } catch (e) { $('#direct-message').textContent = e.message; } };
    }
    async function success(generation) {
      if (!C.active || generation !== C.generation) return;
      C.status = await request('status');
      if (!C.active || generation !== C.generation) return;
      store.set('connectionMode', 'direct'); leave(); connected(C.gateway, C.status);
    }
    async function show(tab = 'password') {
      leave(); C.active = true; const generation = ++C.generation;
      if (!C.gateway) { root.innerHTML = '<main class="setup"><h1>正在启动电视连接服务</h1><p>请稍候…</p></main>'; return; }
      if (tab === 'qr') {
        shell('<div class="qr-box" id="login-qr" aria-label="登录二维码"><span>正在生成二维码…</span></div><p class="login-help">打开手机「绿联云」App，扫描二维码，<br>选择 NAS 并确认登录。</p><p class="message" id="direct-message" role="status">等待扫码</p><div class="actions"><button class="action secondary" id="refresh-qr">刷新二维码</button><button class="action secondary" id="retry-qr" hidden>重试登录</button></div>', 'qr');
        $('#refresh-qr').onclick = () => show('qr'); focus($('#refresh-qr'));
        try {
          await request('cancel', {});
          if (generation !== C.generation) return;
          const qr = await request('qr/create', {});
          if (!C.active || generation !== C.generation) return;
          $('#login-qr').innerHTML = window.renderLoginQr(qr.url);
          const poll = async () => {
            if (!C.active || generation !== C.generation) return;
            if (Date.now() >= qr.expiresAt) { $('#direct-message').textContent = '二维码已过期，请刷新'; return; }
            try {
              const result = await request('qr/poll', {});
              if (!C.active || generation !== C.generation) return;
              if (result.state === 'connected') return await success(generation);
              if (result.state === 'expired') { $('#direct-message').textContent = '二维码已过期，请刷新'; return; }
              if (result.state === 'error') { $('#direct-message').textContent = result.error || '登录失败，请刷新二维码'; $('#retry-qr').hidden = false; return; }
              $('#direct-message').textContent = result.state === 'scanned' ? '已扫码，请在手机上确认登录' : '等待扫码'; C.timer = setTimeout(poll, qr.interval || 3000);
            } catch (e) { if (generation === C.generation && $('#direct-message')) $('#direct-message').textContent = e.message; }
          };
          $('#retry-qr').onclick = async () => { $('#retry-qr').hidden = true; try { await request('qr/retry', {}); C.timer = setTimeout(poll, 3000); } catch(e) { $('#direct-message').textContent = e.message; } };
          C.timer = setTimeout(poll, qr.interval || 3000);
        } catch (e) { if (generation === C.generation && $('#direct-message')) { $('#login-qr').textContent = '暂时无法生成二维码'; $('#direct-message').textContent = e.message; } }
        return;
      }
      shell(`<form class="form" id="direct-form"><label>UGREENlink ID<input id="direct-alias" value="${esc(C.status?.alias || '')}" placeholder="ID 或 https://ug.link/ID" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label>NAS 用户名<input id="direct-user" value="${esc(C.status?.username || '')}" placeholder="NAS 本地账号" autocomplete="username"></label><label>密码<input id="direct-password" type="password" placeholder="NAS 密码" autocomplete="current-password"></label><p class="message" id="direct-message" role="status"></p><button class="action" type="submit">登录</button></form><p class="login-help">NAS 需开启 UGREENlink 远程访问</p>`);
      const form = $('#direct-form'), password = $('#direct-password'), submit = form.querySelector('button[type="submit"]');
      form.onsubmit = async event => {
        event.preventDefault(); if (submit.disabled) return;
        submit.disabled = true; $('#direct-message').textContent = '正在通过 UGREENlink 连接…';
        try { await request('cancel', {}); if (generation !== C.generation) return; await request('login', { alias: $('#direct-alias').value.trim(), username: $('#direct-user').value.trim(), password: password.value }); await success(generation); }
        catch (e) { if (generation === C.generation && $('#direct-message')) $('#direct-message').textContent = e.message; }
        finally { password.value = ''; if (submit.isConnected) submit.disabled = false; }
      };
      focus($('#direct-alias'));
    }
    async function init() {
      if (!window.PalmServiceBridge) throw new Error('此安装包需要在 LG 电视上运行');
      if (!C.gateway) C.gateway = await new Promise((resolve, reject) => {
        const subscription = new window.PalmServiceBridge(); C.subscription = subscription;
        const timeout = setTimeout(() => { subscription.cancel(); reject(new Error('电视连接服务启动超时，请重新打开 App')); }, 35000);
        subscription.onservicecallback = raw => {
          clearTimeout(timeout);
          try { const data = JSON.parse(raw); if (!data.returnValue) throw new Error(data.errorText || '电视连接服务不可用'); const url = new URL(data.server); if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !data.token) throw new Error('电视连接服务返回了无效地址'); resolve({ server: url.origin, token: data.token }); }
          catch (error) { reject(error); }
        };
        subscription.call('luna://top.hrhome.nascinema.service/start', JSON.stringify({ subscribe: true }));
      });
      C.status = await request('status');
      if (C.status.connected) connected(C.gateway, C.status); else show();
    }
    window.addEventListener('beforeunload', () => { leave(); C.subscription?.cancel(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && C.active && $('#login-qr')) { const generation = C.generation; request('qr/poll', {}).then(result => { if (result.state === 'connected') success(generation); }).catch(() => {}); } });
    return { init, show, leave, back() { if (C.status?.connected) { leave(); back(); } else show(); }, available: Boolean(window.PalmServiceBridge) };
  };
})();
