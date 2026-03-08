# Google Calendar Agent
这是一个通过语音控制Google Calendar的AI agent，在不使用Google Calendar API 的前提下，自动在用户的 Google 日历中添加日程。

## 项目功能概述
- 语音/文字双通道：文字通过 `/ws`，语音通过 `/ws-audio`，互不干扰。
- 语音链路：前端录音（WebM）→ Groq STT 转文字 → Agent 处理 → Edge-TTS 合成音频 → 前端播放。
- 日程操作：通过 Playwright 驱动浏览器操作 Google Calendar（查询冲突、创建日程）。
- 语音交互：首次回复固定问候语，引导用户描述日程。

## 环境依赖与安装步骤
### 后端（Python）
1. 进入后端目录并创建虚拟环境（可选）(python 3.14版本安装依赖会有问题，尽量选择3.13以下版本)：
   - `cd agent`
   - `python -m venv venv`
   - `source venv/bin/activate`
2. 安装依赖：
   - `pip install -r agent/requirements.txt`
   - `playwright install` 安装playwright的浏览器依赖
3. 配置环境变量（新建文件 `.env` 放在项目根目录）：
   - `OPENAI_API_KEY`：openai api key
   - `GROQ_API_KEY`：groq api key

### 前端（React）
1. 安装依赖：
   - `cd react`
   - `npm install`
2. 启动开发服务器：
   - `npm run dev`

## 如何运行（包括第一次登录 Google 账号）
1. 启动后端：
   - `cd agent`
   - `python main.py`
2. 启动前端：
   - `cd react`
   - `npm run dev`
3. 打开页面：`http://localhost:5173`
4. 首次登录 Google 账号：
   - 第一次触发日程操作时，Playwright 会启动一个可见的 Chrome 窗口。
   - 在打开的窗口里完成 Google 登录（可能需要二步验证）。
   - 登录完成后，后端会继续执行日程操作。
   - 浏览器登录状态会保存在 `agent/.calendar_profile/`，后续无需重复登录。

## 已知问题或限制
- 需要本机安装 Chrome 浏览器；Playwright 使用持久化用户目录，不能同时被多个实例占用。
- 需要按住按钮说话，没有做录音暂停检测
- 当前会话记录仅保存在内存中，连接断开会清空上下文。
