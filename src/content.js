/* DeepSeek 朗读下载器 —— 内容脚本
 * 走官方 TTS 接口（WebSocket + format=pcm），把某条回答的朗读音频合成为 24kHz 单声道 WAV。
 */
(function () {
  'use strict';
  if (window.__dsTtsDownloaderLoaded) return;
  window.__dsTtsDownloaderLoaded = true;

  var SAMPLE_RATE = 24000;
  var API = '/api/v0';
  var SYNTH_TIMEOUT_MS = 120000;
  var HISTORY_TTL_MS = 15000;

  var BIZ_ERRORS = {
    1: '服务内部错误，请稍后再试',
    2: '请求参数有误',
    3: '朗读服务暂不可用',
    4: '朗读已达今日额度上限',
    5: '操作过于频繁，请稍后再试',
    6: '这条消息没有可朗读的正文',
    7: '当前语言暂不支持朗读',
    8: '当前音色不支持该语言，换「贝壳」或「白浪」试试',
    9: '账号暂未开放朗读功能',
    10: '续传票据已过期，请重试',
    11: '没有权限朗读这条消息',
    12: '内容被安全策略拦截'
  };
  function bizError(code) {
    return BIZ_ERRORS[code] || ('朗读失败（错误码 ' + code + '）');
  }

  /* ---------- 工具 ---------- */
  function getToken() {
    try {
      var raw = localStorage.getItem('userToken');
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (v && typeof v === 'object') return v.value || null;
      return typeof v === 'string' ? v : null;
    } catch (e) { return null; }
  }
  function getSessionId() {
    var m = location.pathname.match(/\/a\/chat\/s\/([0-9a-fA-F-]{8,})/);
    return m ? m[1] : null;
  }
  function convTitle() {
    var t = (document.title || '').replace(/\s*[-—|]\s*DeepSeek.*$/, '').trim();
    return t || 'DeepSeek朗读';
  }
  function safeName(s) {
    return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'audio';
  }
  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtDur(sec) {
    var s = Math.round(sec);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function preview(text) {
    var s = String(text).replace(/\s+/g, ' ').trim();
    return s.length > 96 ? s.slice(0, 96) + '…' : s;
  }
  function charCount(text) { return String(text).replace(/\s+/g, '').length; }

  /* ---------- 官方接口 ---------- */
  function apiFetch(path, init) {
    var token = getToken();
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (init && init.headers) { for (var k in init.headers) headers[k] = init.headers[k]; }
    var opts = { method: (init && init.method) || 'GET', headers: headers, credentials: 'include' };
    if (init && init.body != null) opts.body = init.body;
    return fetch(path, opts).then(function (res) {
      if (!res.ok) throw new Error('接口 ' + path + ' 返回 HTTP ' + res.status);
      return res.json();
    });
  }

  function getVoices() {
    return apiFetch(API + '/chat/tts/voices').then(function (r) {
      var biz = (r && r.data && r.data.biz_data) || {};
      return {
        voices: Array.isArray(biz.voices) ? biz.voices : [],
        currentVoiceId: biz.current_voice_id || null
      };
    });
  }
  function setVoice(voiceId) {
    return apiFetch(API + '/chat/tts/voice', { method: 'POST', body: JSON.stringify({ voice_id: voiceId }) })
      .then(function (r) {
        var code = r && r.data ? r.data.biz_code : undefined;
        if (code !== 0) throw new Error(code === 1 ? '该音色已下线' : '切换音色失败');
        return true;
      });
  }
  function issueTicket() {
    return apiFetch(API + '/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) })
      .then(function (r) {
        var code = r && r.data ? r.data.biz_code : undefined;
        if (r && r.code === 0 && code === 0 && r.data && r.data.biz_data && r.data.biz_data.ticket) {
          return r.data.biz_data.ticket;
        }
        throw new Error(bizError(code));
      });
  }

  var historyCache = { sessionId: null, at: 0, messages: [] };
  function getHistory(sessionId, force) {
    var now = Date.now();
    if (!force && historyCache.sessionId === sessionId && (now - historyCache.at) < HISTORY_TTL_MS) {
      return Promise.resolve(historyCache.messages);
    }
    function parse(r) {
      var biz = (r && r.data && r.data.biz_data) || (r && r.biz_data) || {};
      var list = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
      var messages = list.map(function (m) {
        var frags = Array.isArray(m.fragments) ? m.fragments : [];
        var text = frags.filter(function (x) { return x && x.type === 'RESPONSE'; })
          .map(function (x) { return x.content || ''; }).join('\n');
        if (!text && typeof m.content === 'string') text = m.content;
        var hasTemplate = frags.some(function (x) { return x && x.type === 'TEMPLATE_RESPONSE'; });
        var hasResponse = frags.some(function (x) {
          return x && x.type === 'RESPONSE' && String(x.content || '').trim() !== '';
        });
        if (!frags.length && text) hasResponse = true;   // 兼容旧版 content 结构
        return {
          id: (m.message_id != null ? m.message_id : m.id),
          role: String(m.role || '').toUpperCase(),
          content: text,
          readable: !hasTemplate && hasResponse
        };
      }).filter(function (m) { return m.id != null; });
      return { messages: messages, cacheControl: biz.cache_control || '', rawCount: list.length };
    }
    function request(suffix) {
      return apiFetch(API + '/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId) + (suffix || ''))
        .then(parse);
    }
    return request('').then(function (res) {
      // 服务端对带缓存的请求会回 MERGE + 空 delta；换成“无缓存”参数再取一次全量
      if (!res.rawCount && res.cacheControl !== 'REPLACE') {
        return request('&cache_version=&cache_reset_at=').then(function (res2) {
          return res2.rawCount ? res2 : res;
        });
      }
      return res;
    }).then(function (res) {
      historyCache = {
        sessionId: sessionId, at: now, messages: res.messages,
        cacheControl: res.cacheControl, rawCount: res.rawCount
      };
      return res.messages;
    });
  }

  /* ---------- 合成 PCM ---------- */
  function synthesizePCM(sessionId, messageId, onProgress) {
    if (!getToken()) return Promise.reject(new Error('未登录：找不到 userToken，请先登录 chat.deepseek.com'));
    return issueTicket().then(function (ticket) {
      var qs = 'chat_session_id=' + encodeURIComponent(sessionId)
        + '&message_id=' + encodeURIComponent(messageId)
        + '&ticket=' + encodeURIComponent(ticket)
        + '&mode=manual&format=pcm';
      var url = 'wss://' + location.host + API + '/chat/tts/?' + qs;
      return new Promise(function (resolve, reject) {
        var frames = new Map();
        var realFormat = 'pcm';
        var settled = false;
        var ws = null;
        var timer = setTimeout(function () { done(new Error('超时：长时间没有收到音频数据')); }, SYNTH_TIMEOUT_MS);

        function ack(seq) {
          try { ws.send(JSON.stringify({ event: 'ack', received_seq: seq, played_seq: seq })); } catch (e) {}
        }
        function done(err, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { if (ws) ws.close(); } catch (e) {}
          if (err) reject(err); else resolve(value);
        }
        function assemble() {
          var seqs = Array.from(frames.keys()).sort(function (a, b) { return a - b; });
          var total = 0, i;
          for (i = 0; i < seqs.length; i++) total += frames.get(seqs[i]).length;
          if (!total) return null;
          if (realFormat !== 'pcm') throw new Error('服务端返回的格式是 ' + realFormat + '，暂不支持');
          var out = new Uint8Array(total), off = 0;
          for (i = 0; i < seqs.length; i++) { var f = frames.get(seqs[i]); out.set(f, off); off += f.length; }
          return out;
        }

        try { ws = new WebSocket(url); } catch (e) { clearTimeout(timer); reject(new Error('无法建立朗读连接')); return; }
        ws.binaryType = 'arraybuffer';
        ws.onopen = function () { if (onProgress) onProgress('已连接，正在合成…'); };
        ws.onmessage = function (ev) {
          if (typeof ev.data === 'string') {
            var m;
            try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.event === 'ready') {
              realFormat = m.format || realFormat;
              if (onProgress) onProgress('正在合成…');
              ack(0);
            } else if (m.event === 'finish') {
              if (m.code !== undefined && m.code !== 0) { done(new Error(bizError(m.code))); return; }
              var data = assemble();
              if (!data) { done(new Error('服务端没有返回音频数据')); return; }
              done(null, data);
            } else if (m.event === 'error') {
              done(new Error(m.msg || '朗读失败'));
            }
          } else {
            if (ev.data.byteLength < 4) return;
            var dv = new DataView(ev.data);
            var seq = dv.getUint32(0, false);
            frames.set(seq, new Uint8Array(ev.data, 4));
            ack(seq);
            if (onProgress) onProgress('已接收 ' + frames.size + ' 帧…');
          }
        };
        ws.onerror = function () {
          var data = null;
          try { data = assemble(); } catch (e) { done(e); return; }
          if (data) done(null, data); else done(new Error('朗读连接出错（票据失效或网络问题）'));
        };
        ws.onclose = function (e) {
          if (settled) return;
          var data = null;
          try { data = assemble(); } catch (err) { done(err); return; }
          if (data) done(null, data);
          else done(new Error('朗读连接被关闭（code ' + e.code + '），请重试'));
        };
      });
    });
  }

  /* ---------- WAV / 保存 / 试听 ---------- */
  function pcmToWav(pcm) {
    var header = new ArrayBuffer(44);
    var dv = new DataView(header);
    function str(off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, SAMPLE_RATE, true); dv.setUint32(28, SAMPLE_RATE * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, pcm.length, true);
    return new Blob([header, pcm], { type: 'audio/wav' });
  }
  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { a.remove(); } catch (e) {} URL.revokeObjectURL(url); }, 60000);
  }

  var player = { el: null, url: null };
  function stopAudio() {
    if (player.el) { try { player.el.pause(); } catch (e) {} }
    if (player.url) { try { URL.revokeObjectURL(player.url); } catch (e) {} }
    player.el = null; player.url = null;
  }
  function playBlob(blob) {
    stopAudio();
    var url = URL.createObjectURL(blob);
    var el = new Audio(url);
    player.url = url; player.el = el;
    el.onended = el.onerror = function () { if (player.el === el) stopAudio(); };
    try { el.play().catch(function () {}); } catch (e) {}
  }

  /* ---------- 版本暂存（IndexedDB） ---------- */
  var DB_NAME = 'ds-tts-downloader';
  var DB_VERSION = 1;
  var MAX_TAKES = 10;

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('takes')) {
          var store = db.createObjectStore('takes', { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbAllTakes() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('takes', 'readonly').objectStore('takes').getAll();
        req.onsuccess = function () { db.close(); resolve(req.result || []); };
        req.onerror = function () { db.close(); reject(req.error); };
      });
    });
  }
  function idbPutTake(rec) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('takes', 'readwrite');
        tx.objectStore('takes').put(rec);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }
  function idbDeleteTake(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('takes', 'readwrite');
        tx.objectStore('takes').delete(id);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }
  function idbClearTakes(sessionId) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('takes', 'readwrite');
        var req = tx.objectStore('takes').index('sessionId').openCursor(IDBKeyRange.only(sessionId));
        req.onsuccess = function () {
          var cur = req.result;
          if (cur) { cur.delete(); cur.continue(); }
        };
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  /* ---------- 面板 ---------- */
  var state = {
    open: false, loading: false, loadError: '', messages: [],
    rows: {}, voices: [], currentVoiceId: null, voicesError: '',
    takes: new Map()
  };
  var ui = {};

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      var v = attrs[k];
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
    if (children) {
      [].concat(children).forEach(function (c) {
        if (c == null || c === false) return;
        el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return el;
  }

  var ICON_HEADPHONE = '<svg viewBox="0 0 16 16" fill="none"><path d="M2.5 8.2V7.5a5.5 5.5 0 0 1 11 0v.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><rect x="1.6" y="8" width="3.4" height="5" rx="1.5" stroke="currentColor" stroke-width="1.4"/><rect x="11" y="8" width="3.4" height="5" rx="1.5" stroke="currentColor" stroke-width="1.4"/></svg>';
  var ICON_DOWNLOAD = '<svg viewBox="0 0 16 16" fill="none"><path d="M8 1.8v7.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.2 6.7 8 9.5l2.8-2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.6 11.1v1.2c0 .8.6 1.4 1.4 1.4h8c.8 0 1.4-.6 1.4-1.4v-1.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    '.fab{position:fixed;right:22px;bottom:22px;display:flex;align-items:center;gap:7px;height:40px;padding:0 15px;border:0;border-radius:20px;background:#4d6bfe;color:#fff;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(77,107,254,.38);z-index:2147483647}',
    '.fab:hover{background:#3f5be8}',
    '.fab-icon{display:flex;width:16px;height:16px}',
    '.fab-icon svg{width:16px;height:16px;display:block}',
    '.panel{position:fixed;right:22px;bottom:72px;width:392px;max-width:calc(100vw - 44px);max-height:min(72vh,580px);display:none;flex-direction:column;background:#fff;color:#1b1b1f;border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.22);border:1px solid rgba(0,0,0,.08);overflow:hidden;z-index:2147483647}',
    '.panel.open{display:flex}',
    '.head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px 10px;border-bottom:1px solid rgba(0,0,0,.07)}',
    '.title{font-size:14px;font-weight:700}',
    '.head-actions{display:flex;align-items:center;gap:6px}',
    '.icon-btn{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:8px;background:transparent;color:#6b6b6b;cursor:pointer}',
    '.icon-btn:hover{background:rgba(127,127,127,.15);color:#1b1b1f}',
    '.icon-btn svg{width:15px;height:15px}',
    '.voicebar{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid rgba(0,0,0,.07);font-size:12px;color:#6b6b6b}',
    '.voicebar select{flex:1;height:28px;border:1px solid rgba(0,0,0,.14);border-radius:8px;background:#fff;color:#1b1b1f;font-size:12px;padding:0 6px}',
    '.list{overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:8px;flex:1;min-height:80px}',
    '.row{border:1px solid rgba(0,0,0,.09);border-radius:11px;padding:9px 10px;display:flex;flex-direction:column;gap:7px;background:#fafaff}',
    '.row-head{display:flex;gap:7px;align-items:flex-start}',
    '.badge{flex:none;font-size:11px;font-weight:700;color:#4d6bfe;background:rgba(77,107,254,.12);border-radius:6px;padding:1px 6px;margin-top:1px}',
    '.preview{font-size:12.5px;line-height:1.5;color:#33333a;word-break:break-word}',
    '.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.btn{height:27px;padding:0 11px;border:1px solid rgba(0,0,0,.14);border-radius:8px;background:#fff;color:#33333a;font-size:12px;cursor:pointer}',
    '.btn:hover{background:#f2f2f7}',
    '.btn.primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}',
    '.btn.primary:hover{background:#3f5be8}',
    '.btn:disabled{opacity:.45;cursor:not-allowed}',
    '.status{font-size:11.5px;color:#6b6b6b;flex:1;min-width:0;word-break:break-word}',
    '.status[data-phase="error"]{color:#d33a3a}',
    '.status[data-phase="done"]{color:#1a9c5b}',
    '.hint{padding:16px 12px;font-size:12.5px;line-height:1.6;color:#6b6b6b;text-align:center}',
    '.foot{padding:8px 14px 10px;border-top:1px solid rgba(0,0,0,.07);font-size:11px;line-height:1.5;color:#8a8a93}',
    '.foot-row{margin-top:6px}',
    '.foot-btn{font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer}',
    '.foot-btn:hover{background:rgba(127,127,127,.16)}',
    '.takes{display:flex;flex-wrap:wrap;gap:6px}',
    '.take{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;border:1px solid rgba(0,0,0,.12);border-radius:999px;padding:1px 4px 1px 8px;background:rgba(127,127,127,.06)}',
    '.take-play{cursor:pointer;font-weight:700;color:#4d6bfe}',
    '.take-play:hover{text-decoration:underline}',
    '.take-dur{color:#6b6b6b}',
    '.take-act{cursor:pointer;padding:0 3px;border-radius:5px;color:#6b6b6b}',
    '.take-act:hover{background:rgba(127,127,127,.18);color:#1b1b1f}',
    '.take-act.del:hover{color:#d33a3a}',
    '.take-empty{font-size:11.5px;color:#9a9aa3}',
    '.toast{position:fixed;left:50%;bottom:86px;transform:translate(-50%,10px);max-width:min(80vw,420px);padding:9px 14px;border-radius:10px;background:rgba(28,28,32,.94);color:#fff;font-size:12.5px;line-height:1.5;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;z-index:2147483647}',
    '.toast.show{opacity:1;transform:translate(-50%,0)}',
    '.toast.error{background:rgba(178,42,42,.95)}',
    '@media (prefers-color-scheme: dark){',
    '.panel{background:#1f2023;color:#e9e9ec;border-color:rgba(255,255,255,.1)}',
    '.head,.voicebar,.foot{border-color:rgba(255,255,255,.1)}',
    '.row{background:#26272b;border-color:rgba(255,255,255,.1)}',
    '.preview{color:#d8d8dd}',
    '.btn{background:#2e2f34;border-color:rgba(255,255,255,.14);color:#e9e9ec}',
    '.btn:hover{background:#3a3b41}',
    '.btn.primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}',
    '.voicebar select{background:#2e2f34;border-color:rgba(255,255,255,.14);color:#e9e9ec}',
    '.icon-btn{color:#a9a9b2}',
    '.icon-btn:hover{background:rgba(255,255,255,.12);color:#fff}',
    '.hint,.foot,.status{color:#9a9aa3}',
    '.take{border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.05)}',
    '.take-dur{color:#9a9aa3}',
    '.take-act{color:#9a9aa3}',
    '.take-act:hover{background:rgba(255,255,255,.14);color:#fff}',
    '.take-empty{color:#7d7d86}',
    '.status[data-phase="done"]{color:#4ecb8b}',
    '.status[data-phase="error"]{color:#ff8a8a}',
    '}'
  ].join('\n');

  function ensureUI() {
    if (ui.host) return;
    var host = document.createElement('div');
    host.id = 'ds-tts-dl-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:0;bottom:0;width:0;height:0;';
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    var fab = h('button', { class: 'fab', title: '下载这条对话的朗读音频', onclick: togglePanel }, [
      h('span', { class: 'fab-icon', html: ICON_HEADPHONE }),
      h('span', {}, '下载朗读')
    ]);

    var voiceSelect = h('select', { title: '朗读音色', onchange: onVoiceChange });
    var voicebar = h('div', { class: 'voicebar' }, [h('span', {}, '音色'), voiceSelect]);
    var head = h('div', { class: 'head' }, [
      h('div', { class: 'title' }, '朗读下载'),
      h('div', { class: 'head-actions' }, [
        h('button', { class: 'icon-btn', title: '刷新会话消息', html: ICON_REFRESH, onclick: function () { refresh(true); } }),
        h('button', { class: 'icon-btn', title: '关闭', html: ICON_CLOSE, onclick: closePanel })
      ])
    ]);
    var list = h('div', { class: 'list' });
    var foot = h('div', { class: 'foot' }, [
      h('div', {}, '每点一次「出新版本」都会重新合成一条（消耗一次朗读额度）。版本先暂存在本机，试听后挑最好的再保存。'),
      h('div', { class: 'foot-row' }, [
        h('button', { class: 'foot-btn', onclick: function () { clearSessionTakes(); } }, '清空本会话暂存')
      ])
    ]);
    var panel = h('div', { class: 'panel' }, [head, voicebar, list, foot]);

    shadow.appendChild(fab);
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);
    ui = { host: host, shadow: shadow, fab: fab, panel: panel, list: list, voiceSelect: voiceSelect, foot: foot };
  }

  var ICON_REFRESH = '<svg viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13.7 2.4v3h-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  function openPanel() { ensureUI(); ui.panel.classList.add('open'); state.open = true; refresh(false); }
  function closePanel() { if (ui.panel) ui.panel.classList.remove('open'); state.open = false; }
  function togglePanel() { ensureUI(); if (state.open) closePanel(); else openPanel(); }

  function refresh(force) {
    ensureUI();
    var sessionId = getSessionId();
    if (!sessionId) {
      state.messages = []; state.loading = false;
      state.loadError = '先打开一个具体对话（地址形如 /a/chat/s/…），再回来点这里。';
      renderList(); return;
    }
    state.loading = true; state.loadError = ''; renderList();
    getVoices().then(function (v) {
      state.voices = v.voices; state.currentVoiceId = v.currentVoiceId; state.voicesError = '';
      renderVoices();
    }).catch(function (e) { state.voicesError = e.message; renderVoices(); });
    ensureTakes(sessionId).then(function () { return getHistory(sessionId, force); }).then(function (msgs) {
      state.messages = msgs; state.loading = false; renderList();
    }).catch(function (e) {
      state.loading = false;
      state.loadError = '读取会话消息失败：' + e.message + '（登录失效时刷新页面即可）';
      renderList();
    });
  }

  function voiceLabel(v) {
    var n = v.name_i18n || {};
    return n.zh || n.en || v.voice_id;
  }
  function renderVoices() {
    if (!ui.voiceSelect) return;
    var sel = ui.voiceSelect;
    sel.textContent = '';
    if (state.voicesError) {
      sel.appendChild(h('option', { value: '' }, '音色列表不可用'));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    state.voices.forEach(function (v) {
      var opt = h('option', { value: v.voice_id }, voiceLabel(v) + (v.gender === 'FEMALE' ? '（女）' : v.gender === 'MALE' ? '（男）' : ''));
      if (v.voice_id === state.currentVoiceId) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  function onVoiceChange(e) {
    var id = e.target.value;
    if (!id) return;
    setVoice(id).then(function () {
      state.currentVoiceId = id;
      toast('已切换到「' + (state.voices.filter(function (v) { return v.voice_id === id; }).map(voiceLabel)[0] || id) + '」，之后的新版本用这个音色（已暂存的版本保留）');
    }).catch(function (err) { toast(err.message, 'error'); renderVoices(); });
  }

  function assistantMessages() {
    return state.messages.filter(function (m) { return m.readable && m.content; });
  }

  function renderList() {
    if (!ui.list) return;
    var list = ui.list;
    list.textContent = '';
    state.rows = {};
    if (state.loadError) { list.appendChild(h('div', { class: 'hint' }, state.loadError)); return; }
    if (state.loading) { list.appendChild(h('div', { class: 'hint' }, '正在读取会话消息…')); return; }
    var items = assistantMessages().reverse();
    if (!items.length) {
      var diag;
      if (state.messages.length) diag = '（会话有 ' + state.messages.length + ' 条消息，但都不含可朗读正文）';
      else if (historyCache.rawCount) diag = '（服务端返回 ' + historyCache.rawCount + ' 条消息，均无 RESPONSE 分片）';
      else diag = '（服务端返回 0 条消息' + (historyCache.cacheControl ? '，cache_control=' + historyCache.cacheControl : '') + '）';
      list.appendChild(h('div', { class: 'hint' }, '这个会话里还没有可朗读的回答。' + diag));
      return;
    }
    items.forEach(function (m, i) {
      m._label = items.length - i;
      list.appendChild(buildRow(m));
    });
  }

  function buildRow(m) {
    var gen = h('button', { class: 'btn primary', onclick: function () { makeTake(m); } }, '出新版本');
    var status = h('span', { class: 'status' }, charCount(m.content) + ' 字');
    var takes = h('div', { class: 'takes' });
    var row = h('div', { class: 'row' }, [
      h('div', { class: 'row-head' }, [
        h('span', { class: 'badge' }, '#' + m._label),
        h('span', { class: 'preview' }, preview(m.content))
      ]),
      h('div', { class: 'actions' }, [gen, status]),
      takes
    ]);
    state.rows[m.id] = { gen: gen, status: status, takes: takes };
    renderTakes(m);
    return row;
  }

  function renderTakes(m) {
    var r = state.rows[m.id];
    if (!r) return;
    var list = state.takes.get(m.id) || [];
    r.takes.textContent = '';
    if (!list.length) {
      r.takes.appendChild(h('span', { class: 'take-empty' }, '还没有版本 —— 点「出新版本」生成一条'));
      return;
    }
    list.forEach(function (t) {
      r.takes.appendChild(h('span', { class: 'take' }, [
        h('span', { class: 'take-play', title: '试听这一版', onclick: function () { playBlob(t.blob); } }, 'v' + t.index),
        h('span', { class: 'take-dur' }, fmtDur(t.seconds)),
        h('span', { class: 'take-act', title: '保存这一版', onclick: function () { saveBlob(t.blob, takeFileName(m, t)); } }, '↓'),
        h('span', { class: 'take-act del', title: '删除这一版', onclick: function () { deleteTake(m, t); } }, '×')
      ]));
    });
  }

  function setRow(id, phase, text) {
    var r = state.rows[id];
    if (!r) return;
    r.status.textContent = text || '';
    r.status.setAttribute('data-phase', phase || '');
    r.gen.disabled = (phase === 'working');
  }

  var takesLoadedFor = null;
  function ensureTakes(sessionId) {
    if (takesLoadedFor === sessionId) return Promise.resolve();
    takesLoadedFor = sessionId;
    return idbAllTakes().then(function (rows) {
      var map = new Map();
      rows.filter(function (r) { return r && r.sessionId === sessionId; }).forEach(function (r) {
        var arr = map.get(r.messageId);
        if (!arr) { arr = []; map.set(r.messageId, arr); }
        arr.push(r);
      });
      map.forEach(function (arr) { arr.sort(function (a, b) { return a.index - b.index; }); });
      state.takes = map;
    }).catch(function () { takesLoadedFor = null; });
  }

  function createTake(m, onProgress) {
    var sessionId = getSessionId();
    if (!sessionId) return Promise.reject(new Error('请先打开一个具体对话'));
    return ensureTakes(sessionId).then(function () {
      return synthesizePCM(sessionId, m.id, onProgress);
    }).then(function (pcm) {
      var blob = pcmToWav(pcm);
      var arr = state.takes.get(m.id) || [];
      var maxIndex = 0;
      arr.forEach(function (t) { if (t.index > maxIndex) maxIndex = t.index; });
      var take = {
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        sessionId: sessionId,
        messageId: m.id,
        index: maxIndex + 1,
        createdAt: Date.now(),
        bytes: blob.size,
        seconds: pcm.length / 2 / SAMPLE_RATE,
        blob: blob
      };
      return idbPutTake(take).then(function () {
        arr.push(take);
        state.takes.set(m.id, arr);
        return pruneTakes(m.id).then(function () { return take; });
      });
    });
  }

  function makeTake(m) {
    var r = state.rows[m.id];
    if (r && r.gen.disabled) return;
    if (r) { r.gen.disabled = true; r.status.textContent = '准备中…'; r.status.setAttribute('data-phase', 'working'); }
    createTake(m, function (text) { if (r) r.status.textContent = text; }).then(function (take) {
      if (r) {
        r.status.textContent = '已暂存 v' + take.index + ' · ' + fmtDur(take.seconds);
        r.status.setAttribute('data-phase', 'done');
        renderTakes(m);
      }
    }).catch(function (e) {
      if (r) { r.status.textContent = e.message; r.status.setAttribute('data-phase', 'error'); }
      else toast(e.message, 'error');
    }).then(function () { if (r) r.gen.disabled = false; });
  }

  function pruneTakes(messageId) {
    var arr = state.takes.get(messageId) || [];
    var victims = [];
    while (arr.length > MAX_TAKES) victims.push(arr.shift().id);
    state.takes.set(messageId, arr);
    var chain = Promise.resolve();
    victims.forEach(function (id) { chain = chain.then(function () { return idbDeleteTake(id); }); });
    return chain;
  }

  function deleteTake(m, t) {
    idbDeleteTake(t.id).catch(function () {}).then(function () {
      var arr = (state.takes.get(m.id) || []).filter(function (x) { return x.id !== t.id; });
      state.takes.set(m.id, arr);
      renderTakes(m);
    });
  }

  function takeFileName(m, t) {
    return safeName(convTitle()) + '_' + (m._label != null ? m._label : m.id) + '_v' + t.index + '_' + stamp() + '.wav';
  }

  function clearSessionTakes() {
    var sessionId = getSessionId();
    if (!sessionId) return;
    idbClearTakes(sessionId).catch(function () {}).then(function () {
      state.takes = new Map();
      renderList();
      toast('已清空本会话的暂存版本');
    });
  }

  /* ---------- 提示条 ---------- */
  var toastEl = null, toastTimer = null;
  function toast(msg, kind) {
    ensureUI();
    if (!toastEl) { toastEl = h('div', { class: 'toast' }); ui.shadow.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (kind === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 4200);
  }

  /* ---------- 页面内「下载」按钮 ---------- */
  function normText(s) { return String(s || '').replace(/[^\p{L}\p{N}]+/gu, ''); }
  function shingles(s, k) {
    var set = new Set();
    for (var i = 0; i + k <= s.length; i++) set.add(s.slice(i, i + k));
    return set;
  }
  function matchMessage(domText, messages) {
    var target = normText(domText);
    if (target.length < 10) return null;
    var tset = shingles(target, 10);
    var best = null, bestScore = 0;
    messages.forEach(function (m) {
      if (!m.readable || !m.content) return;
      var c = normText(m.content);
      if (c.length < 10) return;
      var cs = shingles(c, 10), hits = 0;
      cs.forEach(function (g) { if (tset.has(g)) hits++; });
      var score = hits / cs.size;
      if (hits >= 3 && score > bestScore) { bestScore = score; best = m; }
    });
    return best;
  }
  function resolveMessageByText(sessionId, domText) {
    return getHistory(sessionId).then(function (msgs) {
      var hit = matchMessage(domText, msgs);
      if (hit) return hit;
      return getHistory(sessionId, true).then(function (fresh) { return matchMessage(domText, fresh); });
    });
  }

  var INLINE_CSS = [
    '.ds-tts-dl-inline{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;margin:0 2px;border-radius:50%;color:var(--dsw-alias-text-secondary,#6b6b6b);cursor:pointer;flex:none;transition:background-color .15s ease,color .15s ease}',
    '.ds-tts-dl-inline:hover{background-color:rgba(127,127,127,.16);color:var(--dsw-alias-brand-primary,#4d6bfe)}',
    '.ds-tts-dl-inline[data-busy="1"]{pointer-events:none;opacity:.45}',
    '.ds-tts-dl-inline-icon{display:flex;width:16px;height:16px}',
    '.ds-tts-dl-inline-icon svg{width:16px;height:16px;display:block}'
  ].join('\n');

  function injectInlineStyle() {
    if (document.getElementById('ds-tts-dl-inline-style')) return;
    var st = document.createElement('style');
    st.id = 'ds-tts-dl-inline-style';
    st.textContent = INLINE_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function setInline(btn, busy) {
    if (busy) btn.setAttribute('data-busy', '1'); else btn.removeAttribute('data-busy');
  }

  function onInlineDownload(readBtn, mine) {
    if (mine.getAttribute('data-busy')) return;
    var sessionId = getSessionId();
    if (!sessionId) { toast('请先打开一个具体对话', 'error'); return; }
    var container = readBtn.closest('[data-virtual-list-item-key]') || readBtn.closest('.ds-message');
    var domText = container ? (container.innerText || container.textContent || '') : '';
    setInline(mine, true);
    resolveMessageByText(sessionId, domText).then(function (m) {
      if (!m) throw new Error('没能定位这条消息，请用右下角「下载朗读」面板手动选择');
      return createTake(m, null).then(function (take) {
        openPanel();
        toast('已暂存第 ' + take.index + ' 版 · ' + fmtDur(take.seconds) + '，在面板里挑最好的那条');
      });
    }).catch(function (e) { toast(e.message, 'error'); })
      .then(function () { setInline(mine, false); });
  }

  function scanInlineButtons() {
    var nodes = document.querySelectorAll('[aria-label="朗读"]');
    Array.prototype.forEach.call(nodes, function (btn) {
      if (btn.getAttribute('data-ds-tts-dl')) return;
      btn.setAttribute('data-ds-tts-dl', '1');
      var mine = h('div', {
        class: 'ds-tts-dl-inline', role: 'button', tabindex: '0',
        'aria-label': '下载朗读音频', title: '下载这条回答的朗读音频（WAV）'
      }, [h('span', { class: 'ds-tts-dl-inline-icon', html: ICON_DOWNLOAD })]);
      mine.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        onInlineDownload(btn, mine);
      }, false);
      if (btn.parentNode) btn.parentNode.insertBefore(mine, btn.nextSibling);
    });
  }

  var scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      try { scanInlineButtons(); } catch (e) {}
    }, 400);
  }

  /* ---------- 供 popup 调用 ---------- */
  function downloadLast() {
    var sessionId = getSessionId();
    if (!sessionId) return Promise.reject(new Error('请先打开一个具体对话'));
    return getHistory(sessionId, true).then(function (msgs) {
      var list = msgs.filter(function (m) { return m.readable && m.content; });
      if (!list.length) throw new Error('这个会话里还没有可朗读的回答');
      var m = list[list.length - 1];
      m._label = list.length;
      return createTake(m, null).then(function (take) {
        saveBlob(take.blob, takeFileName(m, take));
        return { ok: true, size: take.bytes, seconds: take.seconds };
      });
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ds-tts-dl:open-panel') { openPanel(); sendResponse({ ok: true }); return; }
      if (msg.type === 'ds-tts-dl:status') {
        sendResponse({ ok: true, sessionId: getSessionId(), hasToken: !!getToken() });
        return;
      }
      if (msg.type === 'ds-tts-dl:download-last') {
        downloadLast().then(
          function (r) { sendResponse(r); },
          function (e) { sendResponse({ ok: false, error: e.message }); }
        );
        return true;
      }
    });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    try { injectInlineStyle(); } catch (e) {}
    try { scanInlineButtons(); } catch (e) {}
    try {
      var mo = new MutationObserver(scheduleScan);
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
