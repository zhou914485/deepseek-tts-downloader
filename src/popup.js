/* DeepSeek 朗读下载器 —— 弹窗 */
(function () {
  'use strict';
  var statusEl = document.getElementById('status');

  function setStatus(text) { statusEl.textContent = text; }

  async function activeTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  async function ping(tab) {
    try {
      var res = await chrome.tabs.sendMessage(tab.id, { type: 'ds-tts-dl:status' });
      return res || null;
    } catch (e) { return null; }
  }

  async function send(type) {
    var tab = await activeTab();
    if (!tab || !/^https:\/\/chat\.deepseek\.com\//.test(tab.url || '')) {
      setStatus('请先切到 chat.deepseek.com 的对话页。');
      return;
    }
    try {
      if (type === 'ds-tts-dl:download-last') setStatus('正在合成，稍等…');
      var res = await chrome.tabs.sendMessage(tab.id, { type: type });
      if (type === 'ds-tts-dl:open-panel') { window.close(); return; }
      if (res && res.ok) setStatus('已保存 ' + Math.round(res.size / 1024) + ' KB（约 ' + Math.round(res.seconds) + ' 秒）。');
      else setStatus('失败：' + ((res && res.error) || '未知错误'));
    } catch (e) {
      setStatus('无法连接页面脚本，请刷新 chat.deepseek.com 后重试。');
    }
  }

  document.getElementById('open').addEventListener('click', function () { send('ds-tts-dl:open-panel'); });
  document.getElementById('last').addEventListener('click', function () { send('ds-tts-dl:download-last'); });

  (async function init() {
    var tab = await activeTab();
    if (!tab || !/^https:\/\/chat\.deepseek\.com\//.test(tab.url || '')) {
      setStatus('当前标签页不是 chat.deepseek.com。');
      return;
    }
    var res = await ping(tab);
    if (!res) { setStatus('页面脚本未就绪：刷新一次 chat.deepseek.com 即可。'); return; }
    if (!res.sessionId) { setStatus('已连接。打开一个具体对话后即可下载朗读。'); return; }
    if (!res.hasToken) { setStatus('已连接，但没读到登录态，请确认已登录。'); return; }
    setStatus('已连接，可以下载这条对话的朗读。');
  })();
})();
