import os
import json
from io import BytesIO
import httpx
from groq import Groq


def audio2text(data_bytes: bytes) -> str:
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    audio_file = BytesIO(data_bytes)
    audio_file.name = "audio.webm"
    model = os.getenv("GROQ_STT_MODEL", "whisper-large-v3")
    transcription = client.audio.transcriptions.create(
        file=audio_file,
        model=model,
        response_format="text",
    )
    if isinstance(transcription, str):
        return transcription.strip()
    text = getattr(transcription, "text", "") or ""
    return text.strip()


_http_client: httpx.AsyncClient | None = None

MINIMAX_TTS_URL = "https://api.minimax.io/v1/t2a_v2"


def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=60.0)
    return _http_client


async def stream_synthesize(text: str):
    """流式 TTS：使用 MiniMax T2A V2 API，逐块 yield 音频 bytes。

    每次 yield 都是一个 asyncio 可取消点 (cancellation point)，
    当 Task 被 cancel 时会在 yield 处抛出 CancelledError，
    从而实现 barge-in 时立即停止音频生成。
    """
    api_key = os.getenv("MINIMAX_API_KEY", "")
    model = os.getenv("MINIMAX_TTS_MODEL", "speech-2.8-turbo")
    voice_id = os.getenv("MINIMAX_TTS_VOICE", "Arrogant_Miss")

    payload = {
        "model": model,
        "text": text,
        "stream": True,
        "voice_setting": {
            "voice_id": voice_id,
            "speed": 1.0,
            "vol": 1.0,
            "pitch": 0,
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
            "channel": 1,
        },
        "output_format": "hex",
        "language_boost": "Chinese",
        "stream_options": {
            "exclude_aggregated_audio": True,
        },
    }

    client = _get_http_client()
    async with client.stream(
        "POST",
        MINIMAX_TTS_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        content=json.dumps(payload),
    ) as response:

        # 先读取完整响应体并打印
        full_body = ""
        async for chunk in response.aiter_text():
            full_body += chunk

        if response.status_code != 200:
            print(f"[MiniMax TTS] ERROR: non-200 status, aborting")
            return

        # 然后按 SSE 格式解析
        for line in full_body.split("\n"):
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if data_str == "[DONE]":
                return
            try:
                obj = json.loads(data_str)
                audio_hex = obj.get("data", {}).get("audio", "")
                if audio_hex:
                    yield bytes.fromhex(audio_hex)
            except (json.JSONDecodeError, ValueError):
                continue


async def text2audio(text: str) -> bytes:
    """非流式 TTS：一次性返回完整音频（保留向后兼容）。"""
    chunks = []
    async for chunk in stream_synthesize(text):
        chunks.append(chunk)
    return b"".join(chunks)
