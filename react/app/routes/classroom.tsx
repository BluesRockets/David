import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router";
import useWebSocket, { ReadyState } from "react-use-websocket";
import type { Route } from "./+types/classroom";

type UIState = "connecting" | "listening" | "speaking" | "waitingAnswer" | "recording" | "lessonComplete";

// 显示队列的事件类型
type DisplayItem =
  | { type: "new_bubble" }                          // 创建新的 AI 气泡
  | { type: "sentence"; text: string }              // 逐字打出一句话
  | { type: "state_change"; state: UIState };        // 切换 UI 状态

export function meta({}: Route.MetaArgs) {
  return [
    { title: "AI 智慧课堂" },
    { name: "description", content: "AI 课堂" },
  ];
}

export default function Classroom() {
  const navigate = useNavigate();
  const { courseId } = useParams();
  const clientId = useRef(Math.floor(Math.random() * 100000));
  const socketUrl = `ws://localhost:8000/ws/${clientId.current}`;

  const [uiState, setUIState] = useState<UIState>("connecting");
  const [subtitle, setSubtitle] = useState("");
  const [chatHistory, setChatHistory] = useState<{ role: "ai" | "user"; text: string }[]>([]);
  const [textInput, setTextInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const hasStartedRef = useRef(false);
  const uiStateRef = useRef<UIState>(uiState);
  const pendingUIStateRef = useRef<UIState | null>(null);

  // 跟踪未完成的音频解码数量，防止 sentence_audio_done 在解码前就触发
  const pendingDecodeCountRef = useRef(0);
  const pendingDecodeResolversRef = useRef<(() => void)[]>([]);

  // 统一显示队列
  const displayQueueRef = useRef<DisplayItem[]>([]);
  const isProcessingRef = useRef(false);       // 是否正在处理一个 item
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioReadyRef = useRef(true);           // 当前句音频是否已播完

  useEffect(() => { uiStateRef.current = uiState; }, [uiState]);

  // Parse course from session
  const courseData = (() => {
    try {
      const raw = sessionStorage.getItem("currentCourse");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    if (sessionStorage.getItem("authed") !== "true") {
      navigate("/");
    }
  }, [navigate]);

  // WebSocket
  const { sendMessage, readyState } = useWebSocket(socketUrl, {
    shouldReconnect: () => true,
    reconnectAttempts: 10,
    reconnectInterval: 3000,
    onMessage: (event) => handleWsMessage(event.data),
  });

  // Start lesson on connect
  useEffect(() => {
    if (readyState === ReadyState.OPEN && !hasStartedRef.current) {
      hasStartedRef.current = true;
      if (courseData?.plan) {
        sendMessage(JSON.stringify({ type: "start_lesson", plan: courseData.plan }));
      }
      setUIState("listening");
    }
  }, [readyState, sendMessage, courseData]);

  // Ensure AudioContext is created (must be after user gesture)
  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioContext();
      nextPlayTimeRef.current = 0;
    }
    if (audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  // Schedule a decoded audio buffer for seamless playback
  const scheduleAudioBuffer = useCallback((audioBuffer: AudioBuffer) => {
    const ctx = getAudioContext();
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(nextPlayTimeRef.current, now);
    source.start(startAt);
    nextPlayTimeRef.current = startAt + audioBuffer.duration;

    activeSourcesRef.current.add(source);
    source.onended = () => {
      activeSourcesRef.current.delete(source);
      // 检查是否所有排队音频都已播完，若有 pending 状态则结算
      const c = audioContextRef.current;
      if (pendingUIStateRef.current && c && c.currentTime >= nextPlayTimeRef.current - 0.1) {
        setUIState(pendingUIStateRef.current);
        pendingUIStateRef.current = null;
      }
    };
  }, [getAudioContext]);

  // Enqueue a binary audio frame: decode then schedule
  const enqueueAudio = useCallback(async (data: ArrayBuffer) => {
    pendingDecodeCountRef.current++;
    const ctx = getAudioContext();
    // Ensure context is running before scheduling (critical for first audio)
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    try {
      const decoded = await ctx.decodeAudioData(data.slice(0));
      scheduleAudioBuffer(decoded);
    } catch (err) {
      console.warn("decodeAudioData failed:", err);
    } finally {
      pendingDecodeCountRef.current--;
      if (pendingDecodeCountRef.current === 0) {
        for (const resolve of pendingDecodeResolversRef.current) resolve();
        pendingDecodeResolversRef.current = [];
      }
    }
  }, [getAudioContext, scheduleAudioBuffer]);

  // 等待所有未完成的音频解码
  const waitForPendingDecodes = useCallback(() => {
    if (pendingDecodeCountRef.current === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      pendingDecodeResolversRef.current.push(resolve);
    });
  }, []);

  // Stop all audio immediately (keep AudioContext alive to avoid resume race)
  const stopAudio = useCallback(() => {
    for (const source of activeSourcesRef.current) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    activeSourcesRef.current.clear();
    pendingUIStateRef.current = null;
    pendingDecodeCountRef.current = 0;
    pendingDecodeResolversRef.current = [];
    // Reset next play time to "now" so the next audio starts immediately
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    } else {
      nextPlayTimeRef.current = 0;
    }
  }, []);

  // ================================================================
  // 统一显示队列：消费者
  // ================================================================

  const TYPING_SPEED = 80;

  const processNext = useCallback(() => {
    if (isProcessingRef.current) return;
    if (displayQueueRef.current.length === 0) return;

    const item = displayQueueRef.current[0];

    if (item.type === "new_bubble") {
      // 立即执行，不阻塞
      displayQueueRef.current.shift();
      setSubtitle("");
      setChatHistory((prev) => [...prev, { role: "ai", text: "" }]);
      // 继续处理下一个
      processNext();

    } else if (item.type === "state_change") {
      // 状态切换也立即执行
      displayQueueRef.current.shift();
      // 延迟到音频播完再切
      const ctx = audioContextRef.current;
      if (ctx && nextPlayTimeRef.current > ctx.currentTime) {
        pendingUIStateRef.current = item.state;
      } else {
        setUIState(item.state);
      }
      processNext();

    } else if (item.type === "sentence") {
      // 需要等上一句音频播完才开始打字
      if (!audioReadyRef.current) return;

      isProcessingRef.current = true;
      audioReadyRef.current = false;
      displayQueueRef.current.shift();

      const text = item.text;
      let i = 0;

      const typeChar = () => {
        if (i < text.length) {
          const char = text[i];
          i++;
          setSubtitle((prev) => prev + char);
          setChatHistory((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === "ai") {
              updated[updated.length - 1] = { ...last, text: last.text + char };
            }
            return updated;
          });
          typingTimerRef.current = setTimeout(typeChar, TYPING_SPEED);
        } else {
          // 本句打字完成
          typingTimerRef.current = null;
          isProcessingRef.current = false;
          // 尝试处理下一个（如果音频也播完了）
          processNext();
        }
      };
      typeChar();
    }
  }, []);

  // 当一句音频播放完毕时调用
  const onSentenceAudioDone = useCallback(() => {
    audioReadyRef.current = true;
    processNext();
  }, [processNext]);

  // 向队列追加事件并尝试启动消费
  const enqueueDisplay = useCallback((item: DisplayItem) => {
    displayQueueRef.current.push(item);
    processNext();
  }, [processNext]);

  // 清空显示队列（用于打断 barge-in）
  const clearDisplayQueue = useCallback(() => {
    displayQueueRef.current = [];
    isProcessingRef.current = false;
    audioReadyRef.current = true;
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
  }, []);

  // ================================================================
  // Handle WebSocket messages
  // ================================================================

  const handleWsMessage = useCallback((data: any) => {
    // Binary frame -> audio
    if (data instanceof Blob) {
      data.arrayBuffer().then((buf) => enqueueAudio(buf));
      setUIState("speaking");
      return;
    }
    if (data instanceof ArrayBuffer) {
      enqueueAudio(data);
      setUIState("speaking");
      return;
    }

    // Text frame -> JSON
    try {
      const msg = JSON.parse(data);

      if (msg.type === "transcript_start") {
        console.log("Transcript start:");
        // 入队一个"新气泡"事件，由消费者在合适时机创建
        enqueueDisplay({ type: "new_bubble" });
        setUIState("speaking");

      } else if (msg.type === "sentence_start") {
        console.log("Sentence start:", msg.text);
        // 入队句子，由消费者按节奏逐字打出
        enqueueDisplay({ type: "sentence", text: msg.text });
        setUIState("speaking");

      } else if (msg.type === "sentence_audio_done") {
        console.log("Sentence audio done:");
        // 等待所有音频解码完成后，再计算实际播完的时间
        waitForPendingDecodes().then(() => {
          const ctx = audioContextRef.current;
          if (ctx && nextPlayTimeRef.current > ctx.currentTime) {
            const remaining = (nextPlayTimeRef.current - ctx.currentTime) * 1000;
            setTimeout(onSentenceAudioDone, remaining);
          } else {
            onSentenceAudioDone();
          }
        });

      } else if (msg.type === "transcript") {
        console.log("Transcript:", msg.mode);
        // 状态切换也入队，等前面的句子都播完再执行
        const targetState: UIState | null =
          msg.mode === "evaluate" ? "waitingAnswer" :
          msg.mode === "end" ? "lessonComplete" : null;
        if (targetState) {
          enqueueDisplay({ type: "state_change", state: targetState });
        }

      } else if (msg.type === "tts_done") {
        console.log("TTS done:");
        // 整轮 TTS 全部完成
        const ctx = audioContextRef.current;
        if (ctx && nextPlayTimeRef.current > ctx.currentTime) {
          const remaining = (nextPlayTimeRef.current - ctx.currentTime) * 1000;
          setTimeout(() => {
            setUIState((prev) => (prev === "speaking" ? "listening" : prev));
          }, remaining);
        } else {
          setUIState((prev) => (prev === "speaking" ? "listening" : prev));
        }

      } else if (msg.type === "tts_stop") {
        console.log("TTS stop:");
        clearDisplayQueue();
        stopAudio();

      } else if (msg.type === "lesson_complete") {
        setUIState("lessonComplete");
      }
    } catch {
      setSubtitle(data);
      setChatHistory((prev) => [...prev, { role: "ai", text: data }]);
    }
  }, [enqueueAudio, enqueueDisplay, onSentenceAudioDone, clearDisplayQueue, stopAudio, waitForPendingDecodes]);

  // Auto scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  // Send text answer/interrupt
  const handleSendText = () => {
    const text = textInput.trim();
    if (!text) return;

    if (uiState === "waitingAnswer") {
      sendMessage(JSON.stringify({ type: "answer", text }));
    } else {
      clearDisplayQueue();
      stopAudio();
      sendMessage(JSON.stringify({ type: "interrupt", text }));
    }
    setChatHistory((prev) => [...prev, { role: "user", text }]);
    setTextInput("");
    setUIState("listening");
  };

  // Recording
  const startRecording = useCallback(async () => {
    if (isRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const wasWaitingAnswer = uiStateRef.current === "waitingAnswer";
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(",")[1];
          if (wasWaitingAnswer) {
            sendMessage(JSON.stringify({ type: "answer", audio: base64 }));
          } else {
            clearDisplayQueue();
            stopAudio();
            sendMessage(JSON.stringify({ type: "interrupt", audio: base64 }));
          }
        };
        reader.readAsDataURL(blob);
        mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        setChatHistory((prev) => [...prev, { role: "user", text: "[语音消息]" }]);
        setUIState("listening");
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Mic error:", err);
    }
  }, [isRecording, sendMessage, stopAudio]);

  const stopRecording = useCallback(() => {
    if (!isRecording) return;
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }, [isRecording]);

  const handleBack = () => {
    stopAudio();
    navigate("/courses");
  };

  // Status display
  const statusConfig: Record<UIState, { label: string; color: string; pulse: boolean }> = {
    connecting: { label: "连接中...", color: "bg-yellow-400", pulse: true },
    listening: { label: "聆听中", color: "bg-emerald-400", pulse: false },
    speaking: { label: "老师讲解中", color: "bg-indigo-500", pulse: true },
    waitingAnswer: { label: "轮到你啦", color: "bg-amber-400", pulse: true },
    recording: { label: "录音中", color: "bg-red-500", pulse: true },
    lessonComplete: { label: "课程结束", color: "bg-purple-500", pulse: false },
  };

  const status = statusConfig[isRecording ? "recording" : uiState];

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-indigo-50">
      {/* Header */}
      <header className="shrink-0 bg-white/70 backdrop-blur-xl border-b border-gray-100 px-6 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={handleBack} className="p-2 -ml-2 rounded-xl hover:bg-gray-100 transition-colors cursor-pointer">
              <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
              </svg>
            </button>
            <div>
              <h1 className="text-sm font-semibold text-gray-900">{courseData?.title || "课堂"}</h1>
              <p className="text-xs text-gray-400">{courseData?.plan?.length || 0} 个知识点</p>
            </div>
          </div>

          {/* Status indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-50 border border-gray-100">
            <span className="relative flex h-2.5 w-2.5">
              {status.pulse && <span className={`absolute inline-flex h-full w-full rounded-full ${status.color} opacity-75 animate-ping`} />}
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${status.color}`} />
            </span>
            <span className="text-xs font-medium text-gray-600">{status.label}</span>
          </div>
        </div>
      </header>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {chatHistory.length === 0 && (
            <div className="text-center py-20 animate-[welcome-rise_700ms_ease_forwards]">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-indigo-200">
                <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-900 mb-1">课程即将开始...</h2>
              <p className="text-sm text-gray-400">AI 老师正在准备课程内容</p>
            </div>
          )}

          {chatHistory.map((msg, idx) => (
            <div
              key={idx}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-[welcome-fade_300ms_ease_forwards]`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-br-md"
                    : "bg-white border border-gray-100 text-gray-800 shadow-sm rounded-bl-md"
                }`}
              >
                {msg.role === "ai" && !msg.text ? (
                  <div className="flex items-center gap-1 py-1 px-1">
                    <span className="w-2 h-2 rounded-full bg-gray-400 animate-[typing-dot_1.4s_ease-in-out_infinite]" />
                    <span className="w-2 h-2 rounded-full bg-gray-400 animate-[typing-dot_1.4s_ease-in-out_0.2s_infinite]" />
                    <span className="w-2 h-2 rounded-full bg-gray-400 animate-[typing-dot_1.4s_ease-in-out_0.4s_infinite]" />
                  </div>
                ) : msg.text}
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Lesson Complete */}
      {uiState === "lessonComplete" && (
        <div className="shrink-0 bg-gradient-to-r from-purple-50 to-indigo-50 border-t border-purple-100 px-4 py-6">
          <div className="max-w-3xl mx-auto text-center">
            <p className="text-lg font-semibold text-purple-700 mb-3">课程结束！</p>
            <button
              onClick={handleBack}
              className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 text-white text-sm font-semibold shadow-lg shadow-indigo-200 hover:shadow-xl hover:-translate-y-0.5 transition-all cursor-pointer"
            >
              返回课程列表
            </button>
          </div>
        </div>
      )}

      {/* Input Area */}
      {uiState !== "lessonComplete" && (
        <div className="shrink-0 bg-white/80 backdrop-blur-xl border-t border-gray-100 px-4 py-4">
          <div className="max-w-3xl mx-auto flex items-center gap-3">
            {/* Voice button */}
            <button
              onPointerDown={startRecording}
              onPointerUp={stopRecording}
              onPointerLeave={stopRecording}
              onPointerCancel={stopRecording}
              disabled={readyState !== ReadyState.OPEN || uiState === "speaking"}
              className={`shrink-0 w-12 h-12 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                isRecording
                  ? "bg-red-500 text-white shadow-lg shadow-red-200 scale-110"
                  : uiState === "waitingAnswer"
                    ? "bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg shadow-amber-200 animate-pulse"
                    : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              } disabled:opacity-40 disabled:cursor-not-allowed disabled:animate-none`}
              title={isRecording ? "松开发送" : "按住录音"}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
              </svg>
            </button>

            {/* Text input */}
            <div className="flex-1 flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50/50 px-4 py-2.5">
              <input
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSendText()}
                placeholder={uiState === "waitingAnswer" ? "输入你的答案..." : "输入问题..."}
                className="flex-1 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
                disabled={readyState !== ReadyState.OPEN}
              />
              <button
                onClick={handleSendText}
                disabled={!textInput.trim() || readyState !== ReadyState.OPEN}
                className="shrink-0 w-8 h-8 rounded-full bg-gradient-to-r from-indigo-500 to-purple-600 text-white flex items-center justify-center hover:shadow-md transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
                </svg>
              </button>
            </div>
          </div>

          {uiState === "waitingAnswer" && (
            <p className="max-w-3xl mx-auto text-center text-xs text-amber-600 mt-2 animate-pulse">
              老师在等你的回答哦——说出来或者打字都可以！
            </p>
          )}
        </div>
      )}
    </div>
  );
}
