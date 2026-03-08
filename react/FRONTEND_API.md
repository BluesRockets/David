# 前端接入文档 — AI 语音教学 Agent

## 1. 连接

### WebSocket 地址

```
ws://<host>:8000/ws/{client_id}
```

- `client_id`：整数，客户端自行生成的唯一标识（如用户 ID、随机数）
- 连接建立后，服务端会**立即**用默认教学计划开始授课，无需额外触发

### 连接示例 (Dart / Flutter)

```dart
final channel = WebSocketChannel.connect(
  Uri.parse('ws://192.168.1.100:8000/ws/12345'),
);
```

---

## 2. 消息协议

所有 JSON 消息通过 **text frame** 传输，TTS 音频通过 **binary frame** 传输。

### 2.1 Client → Server（前端发送）

#### `start_lesson` — 开始新课程

发送后会**重置所有状态**，从第一个知识点开始教学。

```json
{
  "type": "start_lesson",
  "plan": ["什么是光合作用", "植物需要什么才能生长", "为什么树叶是绿色的"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 固定 `"start_lesson"` |
| `plan` | string[] | 否 | 知识点列表，按顺序教学。不传则使用默认计划 |

#### `interrupt` — 打断 (Barge-in)

孩子在 AI 说话过程中提出问题时发送。服务端会**立即停止**当前 TTS 推流。

```json
// 方式 A：发送音频（推荐，用于语音交互）
{
  "type": "interrupt",
  "audio": "UklGRiQAAABXQVZF..."
}

// 方式 B：发送文本（用于文字调试）
{
  "type": "interrupt",
  "text": "老师，为什么天空是蓝色的？"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 固定 `"interrupt"` |
| `audio` | string | 二选一 | Base64 编码的音频数据（webm 格式） |
| `text` | string | 二选一 | 纯文本（优先级高于 audio） |

#### `answer` — 回答问题

AI 提问后（收到 `mode: "evaluate"` 的 transcript），等待学生回答。

```json
// 方式 A：发送音频
{
  "type": "answer",
  "audio": "UklGRiQAAABXQVZF..."
}

// 方式 B：发送文本
{
  "type": "answer",
  "text": "八大行星"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 固定 `"answer"` |
| `audio` | string | 二选一 | Base64 编码的音频数据 |
| `text` | string | 二选一 | 纯文本 |

---

### 2.2 Server → Client（前端接收）

#### Text Frame — JSON 消息

**`transcript`** — AI 生成的文本（伴随音频流同时下发）

```json
{
  "type": "transcript",
  "content": "小朋友们好！今天我们来认识太阳系的八大行星...",
  "mode": "ask"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | string | AI 本轮输出的完整文本，可用于字幕显示 |
| `mode` | string | 当前教学状态机的**下一步模式**，详见下方状态说明 |

**`tts_done`** — 本轮 TTS 音频已全部发送完毕

```json
{ "type": "tts_done" }
```

**`tts_stop`** — TTS 被打断（收到 interrupt 后服务端发出）

```json
{ "type": "tts_stop" }
```

**`lesson_complete`** — 课程全部结束

```json
{ "type": "lesson_complete" }
```

#### Binary Frame — TTS 音频流

- 格式：**MP3**（edge-tts 默认输出）
- 以多个 binary frame 逐块推送，每块约几 KB
- 前端应使用流式音频播放器，收到即播放
- 收到 `tts_stop` 时**立即停止播放并清空缓冲区**

---

## 3. 教学状态机 (mode)

`transcript` 消息中的 `mode` 字段表示 AI **接下来要做什么**：

```
┌────────┐       ┌────────┐       ┌──────────┐
│ teach  │──────▶│  ask   │──────▶│ evaluate │
│ 讲解   │ 自动  │ 提问   │ 等待  │ 评估回答 │
└────────┘       └────────┘ 输入  └──────────┘
    ▲                                   │
    └────── current_segment++ ◀─────────┘

任意时刻 interrupt ──▶ qa(答疑) ──▶ 回到断点
```

| mode | 含义 | 前端行为 |
|------|------|----------|
| `teach` | 即将讲解下一个知识点 | 无需操作，等待音频 |
| `ask` | 即将提问 | 无需操作，等待音频 |
| `evaluate` | 等待学生回答 | **启用麦克风**，收集语音后发送 `answer` |
| `qa` | 答疑中（打断触发） | 无需操作，等待音频 |
| `end` | 课程结束 | 展示结课界面 |

**关键**：当 `mode` 为 `"evaluate"` 时，前端应切换为"录音等待"状态。

---

## 4. 完整交互时序

### 4.1 正常教学流程

```
Client                              Server
  │                                    │
  │◀─── transcript (mode=ask) ─────────│  ← AI 讲解内容的文本
  │◀─── binary (audio chunk) ──────────│  ← TTS 音频流
  │◀─── binary (audio chunk) ──────────│
  │◀─── binary (audio chunk) ──────────│
  │◀─── { "type": "tts_done" } ────────│  ← 讲解音频播完
  │         (0.6s 自动间隔)             │
  │◀─── transcript (mode=evaluate) ────│  ← AI 提出问题
  │◀─── binary (audio chunk) ──────────│
  │◀─── { "type": "tts_done" } ────────│  ← 问题音频播完
  │                                    │
  │  [前端：启用麦克风，等待学生回答]      │
  │                                    │
  │─── { "type":"answer", "audio":"" } │  → 学生回答
  │                                    │
  │◀─── transcript (mode=teach) ───────│  ← AI 评价回答
  │◀─── binary (audio chunk) ──────────│
  │◀─── { "type": "tts_done" } ────────│
  │         (自动进入下一个知识点)        │
  │◀─── transcript (mode=ask) ─────────│  ← 讲解下一个知识点...
```

### 4.2 打断 (Barge-in) 流程

```
Client                              Server
  │                                    │
  │◀─── transcript (mode=ask) ─────────│  ← AI 正在讲解
  │◀─── binary (audio chunk) ──────────│
  │◀─── binary (audio chunk) ──────────│
  │                                    │
  │  [孩子突然说话，前端检测到语音活动]    │
  │                                    │
  │─── { "type":"interrupt",           │
  │      "audio":"<base64>" } ─────────│  → 发送打断信号
  │                                    │
  │◀─── { "type": "tts_stop" } ────────│  ← 服务端确认停止
  │                                    │
  │  [前端：立即停止播放，清空音频缓冲]    │
  │                                    │
  │◀─── transcript (mode=ask) ─────────│  ← AI 回答问题 + "我们继续上课吧"
  │◀─── binary (audio chunk) ──────────│     (mode=ask 表示回来后继续提问)
  │◀─── binary (audio chunk) ──────────│
  │◀─── { "type": "tts_done" } ────────│
  │         (自动回到被打断的教学环节)     │
  │◀─── transcript ... ───────────────│  ← 恢复主线教学
```

### 4.3 开始新课程

```
Client                              Server
  │                                    │
  │─── { "type": "start_lesson",       │
  │      "plan": ["知识点A", "B"] } ───│  → 开始新课程
  │                                    │
  │  [服务端取消当前任务，重置状态]        │
  │                                    │
  │◀─── transcript (mode=ask) ─────────│  ← 从知识点A 开始教学
  │◀─── binary (audio chunk) ──────────│
  │  ...                               │
```

---

## 5. 前端实现要点

### 5.1 音频播放器

```
推荐架构：
  WebSocket binary frames → AudioBuffer 队列 → 流式播放器

要点：
  - 收到 binary frame 立即入队播放（低延迟）
  - 收到 "tts_stop" 时清空队列、停止播放
  - 收到 "tts_done" 时等队列播完即可
```

### 5.2 Barge-in 检测（语音活动检测 VAD）

```
推荐方案：
  1. AI 说话期间持续监听麦克风
  2. 检测到语音活动 (VAD) 时开始录音
  3. 语音结束后（静音超过阈值），将录音编码为 webm
  4. Base64 编码后通过 interrupt 消息发送

注意：
  - 发送 interrupt 后应立即停止本地音频播放，不必等 tts_stop
  - tts_stop 作为服务端确认，确保双方状态一致
```

### 5.3 状态管理建议

```dart
// Flutter 伪代码示例
enum UIState { listening, speaking, waitingAnswer, lessonComplete }

void onMessage(dynamic msg) {
  if (msg is List<int>) {
    // binary frame → 送入音频播放器
    audioPlayer.enqueue(msg);
    return;
  }

  final data = jsonDecode(msg);

  switch (data['type']) {
    case 'transcript':
      subtitleText = data['content'];       // 更新字幕
      final mode = data['mode'];
      if (mode == 'evaluate') {
        uiState = UIState.waitingAnswer;    // 准备录音
      } else {
        uiState = UIState.speaking;         // AI 说话中
      }
      break;

    case 'tts_done':
      if (uiState == UIState.waitingAnswer) {
        startRecording();                   // 开始录音
      }
      break;

    case 'tts_stop':
      audioPlayer.stop();                   // 立即停止播放
      audioPlayer.clearBuffer();
      break;

    case 'lesson_complete':
      uiState = UIState.lessonComplete;
      break;
  }
}
```

### 5.4 录音与发送

```dart
// 回答问题
void onAnswerRecorded(Uint8List audioBytes) {
  final b64 = base64Encode(audioBytes);
  channel.sink.add(jsonEncode({
    'type': 'answer',
    'audio': b64,
  }));
}

// 打断 (Barge-in)
void onBargeIn(Uint8List audioBytes) {
  // 1. 立即停止本地播放
  audioPlayer.stop();
  audioPlayer.clearBuffer();

  // 2. 发送打断信号
  final b64 = base64Encode(audioBytes);
  channel.sink.add(jsonEncode({
    'type': 'interrupt',
    'audio': b64,
  }));
}
```

---

## 6. 音频格式

| 方向 | 格式 | 说明 |
|------|------|------|
| Client → Server | **WebM (Opus)** | 浏览器/Flutter 录音默认格式，STT 支持 |
| Server → Client | **MP3** | edge-tts 默认输出，Flutter 可直接播放 |

---

## 7. 错误处理

服务端可能发送纯文本消息（非 JSON）表示错误：

```
缺少 OPENAI_API_KEY, GROQ_API_KEY，请先配置 .env。
```

前端应在解析 JSON 失败时，将 text frame 内容作为错误提示展示给用户。

---

## 8. 环境要求

后端 `.env` 文件需配置：

```env
OPENAI_API_KEY=sk-...          # 必填，LLM 推理
GROQ_API_KEY=gsk_...           # 语音输入时必填，STT
EDGE_TTS_VOICE=zh-CN-XiaoxiaoNeural  # 可选，TTS 音色
```

启动后端：

```bash
cd agent
pip install -r requirements.txt
python main.py
# 服务运行在 ws://0.0.0.0:8000
```
