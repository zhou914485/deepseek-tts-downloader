# DeepSeek 朗读下载器

把 **chat.deepseek.com** 官方「朗读 / TTS」的语音保存成本地 **WAV** 文件。朗读、以及灰测里那个「让 DeepSeek 唱歌」的彩蛋，走的是同一条官方合成接口，所以都能下载。

- 不破解、不代理：用你自己账号的登录态调用官方接口，请求格式与网页播放器完全一致，只是把 `format=opus` 换成了官方同样支持的 `format=pcm`（24kHz 单声道 s16le），再包一层 WAV 头。
- 不发任何外部请求，不收集数据，只有 `chat.deepseek.com` 一个站点权限。

## 一、安装（Chrome / Edge）

1. 打开扩展管理页：Chrome 地址栏输入 `chrome://extensions`，Edge 输入 `edge://extensions`。
2. 打开右上角 / 右下角的 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选中本文件夹 `deepseek-tts-downloader`。
4. 回到 `chat.deepseek.com`，**刷新一次页面**（内容脚本只在页面加载时注入）。

要求 Chrome / Edge 102 及以上。

## 二、怎么用

装好后有两种下载方式：

**方式 1：页面内的下载按钮（最顺手）**

每条 AI 回答右下角原本就有个「朗读」小喇叭，现在它右边会多一个 **下载箭头** 图标。点一下，插件会把这条回答朗读的音频合成好并直接存成 WAV。

**方式 2：右下角的「下载朗读」面板**

页面右下角有一个蓝色悬浮按钮，点开后面板会列出当前对话里所有可朗读的回答：

- **下载 WAV**：合成并保存这条回答的朗读。
- **试听**：直接在页面里播放，不存文件。
- **音色**：下拉框切换官方音色（贝壳 / 白浪 / 海星 / 暗潮）。切换后缓存会清空，之后再下载用的就是新音色。
- 右上角 ⟳ 刷新会话消息。

工具栏上的插件图标里还有一个「下载最后一条回答的朗读」的快捷入口。

## 三、说明与边界

- **文件格式**：24kHz 单声道 16-bit WAV，无损。体积约 **48 KB/秒**（3 分钟的回答约 8.6 MB）。想要更小体积可以自己转成 mp3/ogg。
- **会消耗朗读额度**：每次点「下载」都会走一次官方 TTS 合成，和你在网页上点一次朗读一样，计入每日朗读额度。同一句话重复点会重复消耗；插件对同一条消息做了内存缓存，同一次页面会话内重复点不会重复请求。
- **只能下载已有消息**：官方接口只接受 `chat_session_id + message_id`，正文由服务端从你的会话里取。所以不能让它读一段你临时粘贴的文字——想下载某段文字，得先让它成为会话里的一条消息。
- **唱歌彩蛋**：只要那条回答里有 `♪` 歌词，下载到的就是带旋律的那一版。
- **失败提示**：额度用完、语言不支持、音色不支持该语言、内容被拦截等，都会以中文提示显示在面板里。
- 这是灰测功能的接口，官方随时可能改协议；届时插件可能需要更新。

## 四、原理（想知道它在干什么）

网页播放器实际走的是 WebSocket，不是 HTTP：

| 步骤 | 接口 |
| --- | --- |
| 取一次性票据 | `POST /api/v0/auth/ticket` `{"scope":"tts"}` → `biz_data.ticket`（600 秒有效、只能用一次） |
| 列音色 / 切音色 | `GET /api/v0/chat/tts/voices`、`POST /api/v0/chat/tts/voice` `{"voice_id":"..."}` |
| 读会话消息 | `GET /api/v0/chat/history_messages?chat_session_id=...`（拿到 `message_id`） |
| 合成音频 | `wss://chat.deepseek.com/api/v0/chat/tts/?chat_session_id=..&message_id=..&ticket=..&mode=manual&format=pcm` |

WebSocket 二进制帧格式：前 4 字节大端是帧序号 `seq`，其后是音频负载；客户端每收一帧回一条 `{"event":"ack","received_seq":n,"played_seq":n}`。服务端 `{"event":"ready"}` 表示开始、`{"event":"finish"}` 表示结束。按 `seq` 排序拼接所有负载就是完整的 PCM，加 44 字节 WAV 头即可播放。

## 五、隐私

插件读取页面 `localStorage.userToken`（你本来就在页面上下文里的登录令牌）用于调用官方接口，除此之外不读取、不存储、不外发任何数据。所有请求都发往 `chat.deepseek.com`。

## 六、卸载

扩展管理页里移除即可。插件不写任何本地存储，不需要清理。

## 七、文件结构

```
deepseek-tts-downloader/
├── manifest.json        # MV3 清单
├── icons/               # 图标
├── src/
│   ├── content.js       # 面板、页面内按钮、接口调用、PCM→WAV
│   ├── popup.html
│   └── popup.js
└── README.md
```
