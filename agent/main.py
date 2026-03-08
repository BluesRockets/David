"""
FastAPI WebSocket 层 — Barge-in 打断机制
========================================

核心思路：
  1. 每轮 "LangGraph 推理 + TTS 流式推送" 封装为一个 asyncio.Task
  2. 收到前端 interrupt 信号时 → task.cancel() 立即终止
  3. 将打断问题注入 State，切换 mode=qa，启动新 Task
  4. QA 结束后 mode 自动恢复为 resume_node，继续教学主线

WebSocket 消息协议（JSON）：
  ┌─────────────────────────────────────────────────────────┐
  │ Client → Server                                         │
  │   {"type": "start_lesson", "plan": ["知识点1", ...]}   │
  │   {"type": "interrupt", "audio": "<base64>"}            │
  │   {"type": "interrupt", "text": "为什么天是蓝色的？"}    │
  │   {"type": "answer",    "audio": "<base64>"}            │
  │   {"type": "answer",    "text":  "八大行星"}            │
  ├─────────────────────────────────────────────────────────┤
  │ Server → Client                                         │
  │   {"type": "transcript", "content": "...", "mode": ""} │
  │   {"type": "tts_done"}                                  │
  │   {"type": "tts_stop"}       ← 被打断时发送             │
  │   {"type": "lesson_complete"}                           │
  │   <binary frames>            ← TTS 音频流               │
  └─────────────────────────────────────────────────────────┘
"""

import os
import json
import asyncio
import base64
from dataclasses import dataclass, field
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage, AIMessageChunk

from connection_manager import manager
from agent_service import create_graph
from text_audio import audio2text, stream_synthesize


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ================================================================
# Session — 管理单个 WebSocket 连接的会话状态
# ================================================================

@dataclass
class Session:
    graph: object                                # compiled LangGraph
    state: dict                                  # TeachingState 快照
    current_task: Optional[asyncio.Task] = None  # 当前 "推理+TTS" 任务

    async def cancel_current(self):
        """安全取消正在运行的任务（Graph 推理 / TTS 推流）。"""
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
            try:
                await self.current_task            # 等待 CancelledError 传播完毕
            except asyncio.CancelledError:
                pass
            self.current_task = None


# ================================================================
# 核心协程：运行 Graph → 流式 TTS → 自动继续
# ================================================================

SENTENCE_ENDINGS = set("。！？.!?")


async def run_and_speak(session: Session, ws: WebSocket):
    """
    作为 asyncio.Task 运行，可随时被 cancel。

    使用生产者-消费者模型实现"边想边说"：
      - 生产者：流式获取 LLM token，发送 transcript_delta，按句断开后入队
      - 消费者：从队列取出完整句子，合成音频后立即发送给前端
    """
    tts_queue: asyncio.Queue[str | None] = asyncio.Queue()

    try:
        await ws.send_json({"type": "transcript_start"})

        final_state = None
        sentence_buffer = ""

        # ──────────────── 生产者：LLM 流式 → 断句入队 ────────────────
        async def llm_producer():
            nonlocal final_state, sentence_buffer

            async for stream_type, data in session.graph.astream(
                session.state, stream_mode=["messages", "values"]
            ):
                if stream_type == "messages":
                    msg, _metadata = data
                    if isinstance(msg, AIMessageChunk) and msg.content:
                        sentence_buffer += msg.content
                        while sentence_buffer:
                            earliest = -1
                            for ch in SENTENCE_ENDINGS:
                                idx = sentence_buffer.find(ch)
                                if idx != -1 and (earliest == -1 or idx < earliest):
                                    earliest = idx
                            if earliest == -1:
                                break
                            sentence = sentence_buffer[: earliest + 1].strip()
                            sentence_buffer = sentence_buffer[earliest + 1 :]
                            if sentence:
                                await tts_queue.put(sentence)
                elif stream_type == "values":
                    final_state = data

            # 刷新残余文本
            remaining = sentence_buffer.strip()
            if remaining:
                await tts_queue.put(remaining)
            sentence_buffer = ""

            # 哨兵：通知消费者结束
            await tts_queue.put(None)

        # ──────────────── 消费者：逐句 TTS → 发送文本+音频 ────────────────
        async def tts_consumer():
            sentence_id = 0
            while True:
                sentence = await tts_queue.get()
                if sentence is None:
                    break
                # 先告诉前端这句话的文本
                await ws.send_json({
                    "type": "sentence_start",
                    "text": sentence,
                    "id": sentence_id,
                })
                # 合成音频并发送
                chunks: list[bytes] = []
                async for chunk in stream_synthesize(sentence):
                    chunks.append(chunk)
                audio_data = b"".join(chunks)
                if audio_data:
                    await ws.send_bytes(audio_data)
                # 通知前端这句话的音频已全部发送
                await ws.send_json({
                    "type": "sentence_audio_done",
                    "id": sentence_id,
                })
                sentence_id += 1

        # 并发运行生产者和消费者
        await asyncio.gather(llm_producer(), tts_consumer())

        if final_state is None:
            return
        session.state = final_state

        text = final_state.get("response_text", "")
        if not text:
            return

        # 通知前端文本完成（含 mode 用于状态切换）
        await ws.send_json({
            "type": "transcript",
            "content": text,
            "mode": final_state.get("mode", ""),
        })

        await ws.send_json({"type": "tts_done"})

        # ──────────────── 决定是否自动继续 ────────────────
        mode = final_state.get("mode", "")

        if mode == "end":
            await ws.send_json({"type": "lesson_complete"})
            return

        if not final_state.get("await_input", False):
            await asyncio.sleep(0.6)
            session.current_task = asyncio.create_task(
                run_and_speak(session, ws)
            )
        # else: await_input=True → 等前端发来 "answer" 消息

    except asyncio.CancelledError:
        # 清理队列，防止消费者阻塞
        while not tts_queue.empty():
            try:
                tts_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        # 通知前端立刻停止音频播放
        try:
            await ws.send_json({"type": "tts_stop"})
        except Exception:
            pass
        raise  # 重新抛出，让 Task 正确标记为 cancelled


# ================================================================
# WebSocket 路由
# ================================================================

DEFAULT_PLAN = ["太阳系有哪些行星", "地球为什么有四季", "月亮为什么有阴晴圆缺"]

def make_initial_state(plan: list[str]) -> dict:
    return {
        "messages": [],
        "teaching_plan": plan,
        "current_segment": 0,
        "resume_node": None,
        "mode": "teach",
        "response_text": "",
        "await_input": False,
    }


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: int):
    await manager.connect(websocket)

    session = Session(
        graph=create_graph(),
        state=make_initial_state(DEFAULT_PLAN),
    )

    try:
        if not await ensure_env(websocket, ["OPENAI_API_KEY", "MINIMAX_API_KEY"]):
            return

        # 等待前端发送 start_lesson 再开始教学（不自动启动）

        # ──────────────── 主接收循环 ────────────────
        while True:
            raw = await websocket.receive()
            if raw.get("type") == "websocket.disconnect":
                break
            if "text" not in raw or raw["text"] is None:
                continue

            data = json.loads(raw["text"])
            msg_type = data.get("type", "")

            # ============ 打断 Barge-in ============
            if msg_type == "interrupt":
                # 1) 立即取消当前 "推理+TTS" 任务
                await session.cancel_current()

                # 2) 识别打断内容（支持音频或文本）
                text = await _extract_text(data)
                if not text:
                    # 没有有效内容 → 恢复原流程
                    session.current_task = asyncio.create_task(
                        run_and_speak(session, websocket)
                    )
                    continue

                # 3) 保存断点 & 切换到 QA 模式
                session.state["resume_node"] = session.state["mode"]
                session.state["mode"] = "qa"

                # 将打断问题追加到对话历史
                session.state["messages"] = (
                    list(session.state["messages"])
                    + [HumanMessage(content=text)]
                )

                # 4) 启动 QA 任务
                session.current_task = asyncio.create_task(
                    run_and_speak(session, websocket)
                )

            # ============ 学生回答问题 ============
            elif msg_type == "answer":
                text = await _extract_text(data)
                if not text:
                    continue

                # 注入学生回答 → 触发 evaluate_node
                session.state["messages"] = (
                    list(session.state["messages"])
                    + [HumanMessage(content=text)]
                )
                session.current_task = asyncio.create_task(
                    run_and_speak(session, websocket)
                )

            # ============ 开始新课程 ============
            elif msg_type == "start_lesson":
                await session.cancel_current()
                plan = data.get("plan", DEFAULT_PLAN)
                session.state = make_initial_state(plan)
                session.current_task = asyncio.create_task(
                    run_and_speak(session, websocket)
                )

    finally:
        await session.cancel_current()
        if websocket in manager.active_connections:
            manager.disconnect(websocket)
        print(f"user #{client_id} leave")


# ================================================================
# 工具函数
# ================================================================

async def _extract_text(data: dict) -> str:
    """从消息中提取文本：优先用 text 字段，否则对 audio 做 STT。"""
    if data.get("text"):
        return data["text"]
    audio_b64 = data.get("audio", "")
    if audio_b64:
        audio_bytes = base64.b64decode(audio_b64)
        return await asyncio.to_thread(audio2text, audio_bytes)
    return ""


async def ensure_env(websocket: WebSocket, keys: list[str]) -> bool:
    missing = [key for key in keys if not os.getenv(key)]
    if not missing:
        return True
    await manager.send_personal_message(
        f"缺少 {', '.join(missing)}，请先配置 .env。", websocket
    )
    try:
        await websocket.close()
    except Exception:
        pass
    return False


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
