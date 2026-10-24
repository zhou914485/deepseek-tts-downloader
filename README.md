# DeepSeek 朗读下载器

把 **chat.deepseek.com** 官方「朗读 / TTS」的语音保存成本地 **WAV** 文件。朗读、以及灰测里那个「让 DeepSeek 唱歌」的彩蛋，走的是同一条官方合成接口，所以都能下载。

- 不破解、不代理：用你自己账号的登录态调用官方接口，请求格式与网页播放器完全一致，只是把 `format=opus` 换成了官方同样支持的 `format=pcm`（24kHz 单声道 s16le），再包一层 WAV 头。
- 不发任何外部请求，不收集数据，只有 `chat.deepseek.com` 一个站点权限。

## 一、安装（Chrome / Edge）

0. 拿到代码：`git clone https://github.com/zhou914485/deepseek-tts-downloader.git`（或直接下载 ZIP 解压）。
1. 打开扩展管理页：Chrome 地址栏输入 `chrome://extensions`，Edge 输入 `edge://extensions`。
2. 打开右上角 / 右下角的 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选中本文件夹 `deepseek-tts-downloader`。
4. 回到 `chat.deepseek.com`，**刷新一次页面**（内容脚本只在页面加载时注入）。

要求 Chrome / Edge 102 及以上。改过代码后要在扩展管理页点一次刷新，再刷新页面。

## 二、怎么用：每点一次就是新的一版

官方每次朗读都是重新合成的，同一句话每次语气、断句、重音都不一样。所以插件不缓存「这条消息的音频」，而是**把每一次合成结果都当成一个版本暂存下来**，你抽几版再挑最好的那条：

```
#3  这条回答的预览…
[出新版本]  已暂存 v3 · 12.3s
v1 11.8s ↓ ×   v2 12.1s ↓ ×   v3 12.3s ↓ ×
```

- 点 **出新版本** → 合成一条新版本，自动存进浏览器 IndexedDB
- 点 **v1 / v2 / v3** → 直接试听这一版（不再花额度）
- 点 **↓** → 只保存这一版；点 **×** → 删掉这一版
- 刷新页面、关掉浏览器再回来，暂存的版本还在
- 每条消息最多 10 版，超出自动丢最旧的；面板底部有「清空本会话暂存」
- **音色**下拉框切换官方音色（贝壳 / 白浪 / 海星 / 暗潮），已暂存的版本保留，只有之后的新版本用新音色

两个入口：每条回答「朗读」小喇叭右边的 **下载箭头**（生成一版并打开面板），以及右下角蓝色的 **「下载朗读」** 悬浮按钮（列出整段对话，每条下面就是它自己的版本列表）。工具栏图标里还有「下载最后一条回答的朗读」，会生成一版并直接保存。

## 三、说明与边界

- **文件格式**：24kHz 单声道 16-bit WAV，无损。体积约 **48 KB/秒**（3 分钟的回答约 8.6 MB）。想要更小体积可以自己转成 mp3/ogg。
- **会消耗朗读额度**：只有「出新版本」会走一次官方 TTS 合成，和你在网页上点一次朗读一样，计入每日朗读额度；试听和保存都不花额度。
- **只能下载已有消息**：官方接口只接受 `chat_session_id + message_id`，正文由服务端从你的会话里取。所以不能让它读一段你临时粘贴的文字——想下载某段文字，得先让它成为会话里的一条消息。
- **唱歌彩蛋**：只要那条回答里有 `♪` 歌词，下载到的就是带旋律的那一版。
- **失败提示**：额度用完、语言不支持、音色不支持该语言、内容被拦截等，都会以中文提示显示在对应行里。
- 这是灰测功能的接口，官方随时可能改协议；届时插件可能需要更新。

## 四、原理（想知道它在干什么）

网页播放器实际走的是 WebSocket，不是 HTTP：

| 步骤 | 接口 |
| --- | --- |
| 取一次性票据 | `POST /api/v0/auth/ticket` `{"scope":"tts"}` → `biz_data.ticket`（600 秒有效、只能用一次） |
| 列音色 / 切音色 | `GET /api/v0/chat/tts/voices`、`POST /api/v0/chat/tts/voice` `{"voice_id":"..."}` |
| 读会话消息 | `GET /api/v0/chat/history_messages?chat_session_id=...`（拿到 `message_id`；正文在 `fragments` 里 `type === "RESPONSE"` 的分片，不是顶层 `content`） |
| 合成音频 | `wss://chat.deepseek.com/api/v0/chat/tts/?chat_session_id=..&message_id=..&ticket=..&mode=manual&format=pcm` |

WebSocket 二进制帧格式：前 4 字节大端是帧序号 `seq`，其后是音频负载；客户端每收一帧回一条 `{"event":"ack","received_seq":n,"played_seq":n}`。服务端 `{"event":"ready"}` 表示开始、`{"event":"finish"}` 表示结束。按 `seq` 排序拼接所有负载就是完整的 PCM，加 44 字节 WAV 头即可播放。

## 五、隐私

插件读取页面 `localStorage.userToken`（你本来就在页面上下文里的登录令牌）用于调用官方接口，除此之外不读取、不存储、不外发任何数据。所有请求都发往 `chat.deepseek.com`；暂存的音频只存在本机浏览器的 IndexedDB 里。

## 六、卸载

扩展管理页里移除即可。想顺手清掉暂存的音频，先点面板底部的「清空本会话暂存」，或在浏览器站点数据里清掉 `chat.deepseek.com`。

## 七、文件结构

```
deepseek-tts-downloader/
├── manifest.json        # MV3 清单
├── icons/               # 图标
├── src/
│   ├── content.js       # 面板、页面内按钮、接口调用、PCM→WAV、版本暂存
│   ├── popup.html
│   └── popup.js
└── README.md
```
