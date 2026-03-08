import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router";
import useWebSocket, { ReadyState } from "react-use-websocket";
import type { Route } from "./+types/classroom";

type UIState = "connecting" | "listening" | "speaking" | "waitingAnswer" | "recording" | "lessonComplete";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "AI Smart Classroom" },
    { name: "description", content: "AI Classroom Session" },
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

  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const hasStartedRef = useRef(false);

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
  const { sendMessage, lastMessage, readyState } = useWebSocket(socketUrl, {
    shouldReconnect: () => true,
    reconnectAttempts: 10,
    reconnectInterval: 3000,
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

  // Audio context
  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  // Play next audio chunk from queue
  const playNextChunk = useCallback(async () => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;
    const chunk = audioQueueRef.current.shift()!;
    try {
      const ctx = getAudioContext();
      const audioBuffer = await ctx.decodeAudioData(chunk.slice(0));
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      currentSourceRef.current = source;
      source.onended = () => {
        currentSourceRef.current = null;
        playNextChunk();
      };
      source.start();
    } catch {
      // If decode fails (partial chunk), skip and continue
      playNextChunk();
    }
  }, [getAudioContext]);

  // Enqueue audio
  const enqueueAudio = useCallback((data: ArrayBuffer) => {
    audioQueueRef.current.push(data);
    if (!isPlayingRef.current) {
      playNextChunk();
    }
  }, [playNextChunk]);

  // Stop audio
  const stopAudio = useCallback(() => {
    audioQueueRef.current = [];
    if (currentSourceRef.current) {
      try { currentSourceRef.current.stop(); } catch {}
      currentSourceRef.current = null;
    }
    isPlayingRef.current = false;
  }, []);

  // Handle WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    const { data } = lastMessage;

    // Binary frame → audio
    if (data instanceof Blob) {
      data.arrayBuffer().then(enqueueAudio);
      setUIState("speaking");
      return;
    }
    if (data instanceof ArrayBuffer) {
      enqueueAudio(data);
      setUIState("speaking");
      return;
    }

    // Text frame → JSON
    try {
      const msg = JSON.parse(data);

      if (msg.type === "transcript") {
        setSubtitle(msg.content);
        setChatHistory((prev) => [...prev, { role: "ai", text: msg.content }]);

        if (msg.mode === "evaluate") {
          setUIState("waitingAnswer");
        } else if (msg.mode === "end") {
          setUIState("lessonComplete");
        } else {
          setUIState("speaking");
        }
      } else if (msg.type === "tts_done") {
        if (uiState === "waitingAnswer") {
          // stay in waitingAnswer
        } else {
          setUIState("listening");
        }
      } else if (msg.type === "tts_stop") {
        stopAudio();
      } else if (msg.type === "lesson_complete") {
        setUIState("lessonComplete");
      }
    } catch {
      // Non-JSON text = error message
      setSubtitle(data);
      setChatHistory((prev) => [...prev, { role: "ai", text: data }]);
    }
  }, [lastMessage]);

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
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(",")[1];
          if (uiState === "waitingAnswer") {
            sendMessage(JSON.stringify({ type: "answer", audio: base64 }));
          } else {
            stopAudio();
            sendMessage(JSON.stringify({ type: "interrupt", audio: base64 }));
          }
        };
        reader.readAsDataURL(blob);
        mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        setChatHistory((prev) => [...prev, { role: "user", text: "[Voice message]" }]);
        setUIState("listening");
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Mic error:", err);
    }
  }, [isRecording, uiState, sendMessage, stopAudio]);

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
    connecting: { label: "Connecting...", color: "bg-yellow-400", pulse: true },
    listening: { label: "Listening", color: "bg-emerald-400", pulse: false },
    speaking: { label: "AI Speaking", color: "bg-indigo-500", pulse: true },
    waitingAnswer: { label: "Your Turn", color: "bg-amber-400", pulse: true },
    recording: { label: "Recording", color: "bg-red-500", pulse: true },
    lessonComplete: { label: "Lesson Complete", color: "bg-purple-500", pulse: false },
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
              <h1 className="text-sm font-semibold text-gray-900">{courseData?.title || "Classroom"}</h1>
              <p className="text-xs text-gray-400">{courseData?.plan?.length || 0} topics</p>
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
              <h2 className="text-lg font-semibold text-gray-900 mb-1">Lesson Starting...</h2>
              <p className="text-sm text-gray-400">The AI teacher is preparing your lesson</p>
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
                {msg.text}
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Subtitle bar */}
      {subtitle && uiState === "speaking" && (
        <div className="shrink-0 bg-indigo-50 border-t border-indigo-100 px-4 py-3">
          <p className="max-w-3xl mx-auto text-sm text-indigo-700 text-center">{subtitle}</p>
        </div>
      )}

      {/* Lesson Complete */}
      {uiState === "lessonComplete" && (
        <div className="shrink-0 bg-gradient-to-r from-purple-50 to-indigo-50 border-t border-purple-100 px-4 py-6">
          <div className="max-w-3xl mx-auto text-center">
            <p className="text-lg font-semibold text-purple-700 mb-3">Lesson Complete!</p>
            <button
              onClick={handleBack}
              className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 text-white text-sm font-semibold shadow-lg shadow-indigo-200 hover:shadow-xl hover:-translate-y-0.5 transition-all cursor-pointer"
            >
              Back to Courses
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
              title={isRecording ? "Release to send" : "Hold to record"}
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
                placeholder={uiState === "waitingAnswer" ? "Type your answer..." : "Type to ask a question..."}
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
              The teacher is waiting for your answer - speak or type!
            </p>
          )}
        </div>
      )}
    </div>
  );
}
