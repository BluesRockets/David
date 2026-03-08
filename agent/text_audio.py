import os
from io import BytesIO
from groq import Groq
import edge_tts


def audio2text(data_bytes: bytes) -> str:
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    audio_file = BytesIO(data_bytes)
    audio_file.name = "audio.webm"
    model = os.getenv("GROQ_STT_MODEL", "whisper-large-v3")
    transcription = client.audio.transcriptions.create(
        file=audio_file,
        model=model,
        response_format="text",
        temperature=0,
    )
    if isinstance(transcription, str):
        return transcription.strip()
    text = getattr(transcription, "text", "") or ""
    return text.strip()


async def stream_synthesize(text: str):
    """流式 TTS：异步生成器，逐块 yield 音频 bytes。

    每次 yield 都是一个 asyncio 可取消点 (cancellation point)，
    当 Task 被 cancel 时会在 yield 处抛出 CancelledError，
    从而实现 barge-in 时立即停止音频生成。
    """
    voice = os.getenv("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
    communicate = edge_tts.Communicate(text, voice)
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio":
            data = chunk.get("data", b"")
            if data:
                yield data


async def text2audio(text: str) -> bytes:
    """非流式 TTS：一次性返回完整音频（保留向后兼容）。"""
    chunks = []
    async for chunk in stream_synthesize(text):
        chunks.append(chunk)
    return b"".join(chunks)
