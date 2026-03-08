"""
LangGraph 教学状态机
===================

┌───────────────────────────────────────────────────────────┐
│                        主线流程                            │
│   teach_node ──▶ ask_node ──▶ (等学生回答) ──▶ evaluate   │
│       ▲                                          │        │
│       └──────── current_segment++ ◀──────────────┘        │
│                                                           │
│                        支线流程                            │
│   任意节点被 barge-in ──▶ qa_node ──▶ 回到 resume_node    │
└───────────────────────────────────────────────────────────┘

设计要点：
  - 每个节点执行完毕后都 → END，将控制权交还给 FastAPI 层。
    这是因为每个节点产出的文本都需要经 TTS 流式播报给前端，
    而 barge-in 打断只能发生在 TTS 推流阶段（FastAPI 层）。
  - State 中的 `mode` 字段决定下一次 invoke 进入哪个节点。
  - State 中的 `resume_node` 记录打断发生前的 mode（断点），
    qa_node 结束后将 mode 还原到该值，实现"偏离 → 拉回"。
  - `await_input` 标记是否需要等待学生输入（如回答问题），
    为 False 时 FastAPI 会自动触发下一个节点。
"""

from typing import TypedDict, Optional, Annotated
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage


llm = ChatOpenAI(model="gpt-5-mini", temperature=1)

# ================================================================
# State 定义
# ================================================================

class TeachingState(TypedDict):
    messages: Annotated[list, add_messages]  # 完整对话历史（自动追加）
    teaching_plan: list[str]                 # 教学大纲：有序知识点列表
    current_segment: int                     # 当前讲到第几个知识点（0-based）
    resume_node: Optional[str]               # barge-in 断点：QA 结束后回到这里
    mode: str                                # 路由标识: teach | ask | qa | evaluate
    response_text: str                       # 本轮 AI 输出文本（供 TTS 朗读）
    await_input: bool                        # True → 等待学生输入; False → 自动继续


# ================================================================
# System Prompt — 面向 6-12 岁儿童
# ================================================================

SYSTEM_PROMPT = (
    "你是一位面向6-12岁儿童的AI教学老师，名叫'小智'。\n"
    "语气要亲切、有趣、富有鼓励性。用简单易懂的语言讲解知识。\n"
    "每次只讲一个小知识点，控制在3-4句话以内。\n"
    "重要：只在课程最开始时做一次自我介绍，之后不要再重复介绍自己。\n"
    "如果对话历史中你已经说过话了，直接继续讲课即可。\n"
)


# ================================================================
# Router — 根据 state.mode 决定进入哪个节点
# ================================================================

def router(state: TeachingState) -> str:
    """入口路由：将 mode 映射到对应的节点名。"""
    return state.get("mode", "teach")


# ================================================================
# 主线节点
# ================================================================

async def teach_node(state: TeachingState) -> dict:
    """讲解节点：取出当前知识点，让 LLM 生成生动的讲解内容。"""
    plan = state.get("teaching_plan", [])
    idx = state.get("current_segment", 0)

    # 全部讲完 → 结课
    if idx >= len(plan):
        return {
            "response_text": "今天的课程全部讲完啦！你表现得非常棒，给自己鼓个掌吧！",
            "mode": "end",
            "await_input": False,
        }

    topic = plan[idx]
    if idx == 0:
        prompt = f"请用3-4句话，生动有趣地向小朋友讲解以下知识点：{topic}"
    else:
        prompt = f"继续讲解下一个知识点：{topic}。直接讲内容，不要重复自我介绍。"
    messages = [
        SystemMessage(content=SYSTEM_PROMPT),
        *state.get("messages", []),
        HumanMessage(content=prompt),
    ]
    full_content = ""
    async for chunk in llm.astream(messages):
        full_content += chunk.content

    return {
        "messages": [AIMessage(content=full_content)],
        "response_text": full_content,
        "mode": "ask",          # ➡️ 下一步：提问
        "await_input": False,   # 讲完自动进入提问环节
    }


async def ask_node(state: TeachingState) -> dict:
    """提问节点：针对刚才讲解的内容，提出一个适龄的小问题。"""
    plan = state.get("teaching_plan", [])
    idx = state.get("current_segment", 0)
    topic = plan[idx] if idx < len(plan) else "刚才的内容"

    messages = [
        SystemMessage(content=SYSTEM_PROMPT),
        *state.get("messages", []),
        HumanMessage(content=(
            f"你刚刚讲解了「{topic}」，现在请提一个简单有趣的问题，"
            f"检查小朋友是否理解了。问题要简短，适合口头回答。"
        )),
    ]
    full_content = ""
    async for chunk in llm.astream(messages):
        full_content += chunk.content

    return {
        "messages": [AIMessage(content=full_content)],
        "response_text": full_content,
        "mode": "evaluate",     # ➡️ 下一步：评估学生回答
        "await_input": True,    # ⏸ 等待学生回答
    }


async def evaluate_node(state: TeachingState) -> dict:
    """评估节点：评价学生的回答，鼓励或温柔纠正，然后推进到下一个知识点。"""
    messages = [
        SystemMessage(content=(
            SYSTEM_PROMPT + "\n\n"
            "请评价小朋友的回答：如果答对了就热情夸奖；"
            "如果答错了就温柔地纠正并给出正确答案。"
            "你可以选择追问一个相关的小问题来加深理解，"
            "也可以用一句过渡语引出下一个知识点。"
        )),
        *state.get("messages", []),
    ]
    full_content = ""
    async for chunk in llm.astream(messages):
        full_content += chunk.content

    # 动态判断：回复末尾有问号 → 追问了新问题，需要等学生回答
    has_question = full_content.rstrip().endswith(("？", "?"))

    return {
        "messages": [AIMessage(content=full_content)],
        "response_text": full_content,
        "current_segment": state.get("current_segment", 0) + (0 if has_question else 1),
        "mode": "evaluate" if has_question else "teach",
        "await_input": has_question,
    }


# ================================================================
# 支线节点 — 答疑（处理 Barge-in）
# ================================================================

async def qa_node(state: TeachingState) -> dict:
    """
    答疑节点：处理学生的突发提问。

    关键逻辑：
      - state.resume_node 记录了打断前的 mode（由 FastAPI 层在打断时写入）
      - 回答完毕后，将 mode 恢复为 resume_node，实现"拉回主线"
    """
    resume = state.get("resume_node", "teach")

    messages = [
        SystemMessage(content=(
            SYSTEM_PROMPT + "\n\n"
            "【特殊情况】学生在上课过程中突然提了一个问题。\n"
            "请耐心、简短地回答（2-3句话），"
            "回答完后自然地说'好啦，我们继续上课吧！'来过渡回课堂。"
        )),
        *state.get("messages", []),
    ]
    full_content = ""
    async for chunk in llm.astream(messages):
        full_content += chunk.content

    return {
        "messages": [AIMessage(content=full_content)],
        "response_text": full_content,
        "mode": resume,         # ✅ 拉回到被打断前的节点
        "resume_node": None,    # 清除断点标记
        "await_input": False,   # QA 结束后自动回到主线
    }


# ================================================================
# 构建 Graph
# ================================================================

def create_graph():
    builder = StateGraph(TeachingState)

    # 注册节点
    builder.add_node("teach", teach_node)
    builder.add_node("ask", ask_node)
    builder.add_node("qa", qa_node)
    builder.add_node("evaluate", evaluate_node)

    # 入口条件路由：根据 state.mode 分发到对应节点
    builder.add_conditional_edges(START, router, {
        "teach": "teach",
        "ask": "ask",
        "qa": "qa",
        "evaluate": "evaluate",
    })

    # 每个节点执行完 → END（控制权交还 FastAPI，由其决定是否继续）
    for node in ("teach", "ask", "qa", "evaluate"):
        builder.add_edge(node, END)

    return builder.compile()
