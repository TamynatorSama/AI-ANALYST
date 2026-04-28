from typing import TypedDict, Annotated
from langgraph.graph import MessagesState, StateGraph, START, END
from langgraph.prebuilt import ToolNode
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage
from dotenv import load_dotenv
from e2b_code_interpreter import Sandbox
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import interrupt
import uuid
import sys
from prompt import UNDERSTANDING_MODEL_PROMPT, CODE_MODEL_PROMPT, SUMMARY_MODEL_PROMPT
import json

from IPython.display import display, Image

from langchain_core.tools import tool
from langchain.tools import ToolRuntime

import subprocess
import os
import io
import matplotlib.pyplot as plt
import matplotlib.image as mpimg


def show_graph(workflow):
    png_data = workflow.get_graph().draw_mermaid_png()

    img = mpimg.imread(io.BytesIO(png_data))


    plt.imshow(img)
    plt.axis('off') 
    plt.show()
    return None

load_dotenv()
class AppState(MessagesState):
    data_path: str
    user_id: str
    error: str
    analysis_round: int
    follow_up_request: str
    



@tool
async def get_data_snapshot(runtime:ToolRuntime)-> str:

    """
    This function is used to get basic information about the dataset, it persons basic statistical analysis of the dataset.and return the results in the form of a dictionary.
    Returns: str
    """


    if not os.path.exists(runtime.state["data_path"]):
        return {"error":f"Data {runtime.state["data_path"]} path does not exist."}
    
    code_import = """
try:
    import pandas as pd
    import json
    import os
except Exception as e:
    print(json.dumps({"error":f"Failed to import libraries: {e}"}))
"""
    code_header = f"""

path = r"{runtime.state['data_path']}"
"""
    code_body = """
def analyze(df):
    results = {}

    # --- Basic Info ---
    results["overview"] = {
        "rows": len(df),
        "columns": {col: str(dtype) for col, dtype in df.dtypes.items()},
        "missing_values": {k: v for k, v in df.isnull().sum().items() if v > 0},
        "duplicates": int(df.duplicated().sum()),
    }

    # --- Stats ---
    results["statistics"] = df.describe(include="all").to_dict()

    # --- Outliers (IQR method) ---
    outliers = {}
    for col in df.select_dtypes(include="number"):
        Q1 = df[col].quantile(0.25)
        Q3 = df[col].quantile(0.75)
        IQR = Q3 - Q1
        count = int(((df[col] < Q1 - 1.5*IQR) | (df[col] > Q3 + 1.5*IQR)).sum())
        if count > 0:
            outliers[col] = count
    results["outliers"] = outliers

    # --- Top Correlations ---
    numeric = df.select_dtypes(include="number")
    if len(numeric.columns) > 1:
        corr = numeric.corr()
        pairs = []
        for i in range(len(corr.columns)):
            for j in range(i+1, len(corr.columns)):
                pairs.append({
                    "col1": corr.columns[i],
                    "col2": corr.columns[j],
                    "correlation": round(corr.iloc[i, j], 3)
                })
        pairs.sort(key=lambda x: abs(x["correlation"]), reverse=True)
        results["top_correlations"] = pairs[:10]

    # --- Distribution Info ---
    distributions = {}
    for col in numeric.columns:
        distributions[col] = {
            "mean": round(df[col].mean(), 3),
            "median": round(df[col].median(), 3),
            "std": round(df[col].std(), 3),
            "skew": round(df[col].skew(), 3),
        }
    results["distributions"] = distributions

    # --- Category Breakdowns ---
    categories = {}
    for col in df.select_dtypes(include="object"):
        vc = df[col].value_counts()
        categories[col] = {
            "unique": int(vc.count()),
            "top_values": vc.head(5).to_dict(),
        }
    results["categories"] = categories

    import math
    def clean_nans(obj):
        if isinstance(obj, dict):
            return {k: clean_nans(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [clean_nans(v) for v in obj]
        elif isinstance(obj, float):
            if math.isnan(obj) or math.isinf(obj):
                return None
        return obj

    print(json.dumps(clean_nans(results), default=str))

_, ext = os.path.splitext(path)

try:
    if ext == ".csv":
        try:
            df = pd.read_csv(path, encoding="utf-8")
        except UnicodeDecodeError:
            try:
                df = pd.read_csv(path, encoding="latin-1")
            except Exception:
                df = pd.read_csv(path, encoding="cp1252")
        analyze(df)
    elif ext == ".json":
        df = pd.read_json(path)
        analyze(df)
    elif ext in (".xlsx", ".xls"):
        df = pd.read_excel(path)
        analyze(df)
    else:
        print(json.dumps({"error":f"Unsupported file format: {ext}"}))
except Exception as e:
    print(json.dumps({"error":f"Failed to read file: {e}"}))
"""
    code = code_import + code_header + code_body


    user_dir = f"./data/{runtime.state['user_id']}"
    os.makedirs(user_dir, exist_ok=True)
    script_path = f"{user_dir}/snapshot.py"

    with open(script_path, "w") as f:
        f.write(code)
    
    result = subprocess.run([sys.executable, script_path], capture_output=True, text=True)
    
    if result.returncode != 0:
        print(f"Subprocess Error:\n{result.stderr}")
        return {"error": result.stderr}
    
    # return result.stdout
    print(result.stdout)
    if isinstance(result.stdout, str):
        return result.stdout
    else:
        return json.dumps(result.stdout)

@tool
async def write_to_file(text: str, runtime: ToolRuntime)-> None:
    """
    This function is used to write what the user wants to get from the data, including hypothesis and questions.
    Returns: None
    """
    user_dir = f"./data/{runtime.state['user_id']}"
    os.makedirs(user_dir, exist_ok=True)
    with open(f"{user_dir}/output.txt", "a") as f:
        f.write(text)
    return None

@tool
def ask_user(question:str)->str:
    """
    This function is used to ask the user questions.
    Returns: str
    """
    return input(question)

@tool
async def execute_code(code: str, runtime: ToolRuntime) -> str:
    """
    Execute Python analysis code in a subprocess. The code will have DATA_PATH, OUTPUT_DIR,
    pandas, numpy, matplotlib, and seaborn pre-imported. Save all figures to OUTPUT_DIR.
    Args:
        code: Python code to execute. Do NOT re-import pandas/matplotlib/seaborn or redefine DATA_PATH/OUTPUT_DIR.
    Returns: Execution output including stdout, stderr, and list of saved image files.
    """
    user_id = runtime.state["user_id"]
    data_path = runtime.state["data_path"]
    round_num = runtime.state.get("analysis_round", 1) or 1
    user_dir = f"./data/{user_id}"
    output_dir = os.path.abspath(f"{user_dir}/outputs/round_{round_num}")
    os.makedirs(output_dir, exist_ok=True)

    setup_code = f'''import os
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns
import json
import warnings
warnings.filterwarnings('ignore')

DATA_PATH = r"{os.path.abspath(data_path)}"
OUTPUT_DIR = r"{output_dir}"
os.makedirs(OUTPUT_DIR, exist_ok=True)
'''

    full_code = setup_code + "\n" + code
    script_path = f"./data/{user_id}/analysis.py"

    with open(script_path, "w") as f:
        f.write(full_code)

    try:
        result = subprocess.run(
            [sys.executable, script_path],
            capture_output=True, text=True,
            timeout=120
        )
    except subprocess.TimeoutExpired:
        return "ERROR: Code execution timed out after 120 seconds."

    # Collect saved images
    images = []
    if os.path.exists(output_dir):
        for fname in sorted(os.listdir(output_dir)):
            if fname.lower().endswith(('.png', '.jpg', '.jpeg', '.svg')):
                images.append(os.path.join(output_dir, fname))

    output_parts = []
    if result.stdout.strip():
        output_parts.append(f"STDOUT:\n{result.stdout.strip()}")
    if result.stderr.strip():
        output_parts.append(f"STDERR:\n{result.stderr.strip()}")

    if result.returncode != 0:
        output_parts.append(f"\nEXECUTION FAILED (exit code {result.returncode})")
    else:
        output_parts.append(f"\nEXECUTION SUCCESS")

    if images:
        output_parts.append(f"\nSAVED IMAGES ({len(images)}):\n" + "\n".join(f"  - {img}" for img in images))

    return "\n".join(output_parts)


llm = ChatGoogleGenerativeAI(model="gemini-2.5-flash").bind_tools([get_data_snapshot, write_to_file, ask_user])
code_llm_base = ChatGoogleGenerativeAI(model="gemini-3.1-pro-preview")
code_llm = code_llm_base.bind_tools([execute_code])
code_llm_forced = code_llm_base.bind_tools([execute_code], tool_choice="any")

async def understand_data_model(state: AppState):
    messages = state.get("messages", [])
    if not messages:
        human_msg = HumanMessage(content="Hello, please start analyzing the data.")
        response = await llm.ainvoke([SystemMessage(content=UNDERSTANDING_MODEL_PROMPT), human_msg])
        return {"messages": [human_msg, response]}
    
    response = await llm.ainvoke([SystemMessage(content=UNDERSTANDING_MODEL_PROMPT)] + messages)
    return {"messages": [response]}

def has_understanding(state: AppState)->str:
    last_message = state["messages"][-1]

    # 2. Check if it's an AIMessage and if it contains tool_calls
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tools"
    else:
        return END

tools = ToolNode([get_data_snapshot, write_to_file, ask_user])

async def tool_node(state: AppState):
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        tool_call = last_message.tool_calls[0]
        if tool_call["name"] == "ask_user":
            question_to_ask = tool_call["args"]["question"]
            
            # Pause the graph and surface the question
            user_answer = interrupt({"question": question_to_ask})
            
            # Create a ToolMessage containing the user response
            tool_message = ToolMessage(
                content=str(user_answer),
                tool_call_id=tool_call["id"],
                name=tool_call["name"]
            )
            return {"messages": [tool_message]}
        else:
            return await tools.ainvoke(state)
    else:
        return {"messages": []}
        



# ── Code Model Node ──────────────────────────────────────────────────────────

async def code_model_node(state: AppState):
    messages = state.get("messages", [])
    follow_up = state.get("follow_up_request", "")

    # Read the analytical plan written by the understanding model
    plan = ""
    user_dir = f"./data/{state.get('user_id', '')}"
    plan_path = f"{user_dir}/output.txt"
    if os.path.exists(plan_path):
        with open(plan_path, "r") as f:
            plan = f.read()

    system_content = CODE_MODEL_PROMPT + f"\n\n--- ANALYTICAL PLAN ---\n{plan}\n--- END PLAN ---"

    # Determine which code-phase messages to pass
    code_start_idx = None
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if isinstance(m, HumanMessage) and ("understanding phase is complete" in (m.content or "") or "follow-up analysis" in (m.content or "")):
            code_start_idx = i
            break

    # Case 1: Follow-up round — inject new kickoff
    if follow_up and follow_up != "__summary__":
        round_num = state.get("analysis_round", 1) or 1
        kickoff = HumanMessage(content=f"The user has requested a follow-up analysis (Round {round_num}).\n\nUser request: {follow_up}\n\nPlease implement this specific analysis. Use the analytical plan above for dataset context (column names, data types, file path).")
        # Include recent code history for context, but not too much
        context_msgs = messages[code_start_idx:] if code_start_idx is not None else []
        context_msgs = context_msgs[-10:]  # last 10 messages max for context
        response = await code_llm_forced.ainvoke([SystemMessage(content=system_content)] + context_msgs + [kickoff])
        return {"messages": [kickoff, response], "follow_up_request": ""}

    # Case 2: Continuing within a round (after execute_code returned)
    elif code_start_idx is not None:
        code_messages = messages[code_start_idx:]
        response = await code_llm.ainvoke([SystemMessage(content=system_content)] + code_messages)
        return {"messages": [response]}

    # Case 3: First call ever
    else:
        kickoff = HumanMessage(content="The understanding phase is complete. Please read the analytical plan above and implement all requested analyses now.")
        response = await code_llm_forced.ainvoke([SystemMessage(content=system_content), kickoff])
        return {"messages": [kickoff, response]}


def route_code_model(state: AppState) -> str:
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "code_tools"
    return "FollowUp"  # go to FollowUp instead of END


code_tools = ToolNode([execute_code])


# ── FollowUp Node ────────────────────────────────────────────────────────────

async def followup_node(state: AppState):
    current_round = state.get("analysis_round", 1) or 1
    user_id = state.get("user_id", "")
    output_dir = f"./data/{user_id}/outputs/round_{current_round}"

    images = []
    if os.path.exists(output_dir):
        for fname in sorted(os.listdir(output_dir)):
            if fname.lower().endswith(('.png', '.jpg', '.jpeg', '.svg')):
                images.append(fname)

    # Interrupt — the server sends round_complete to the frontend
    user_response = interrupt({
        "type": "round_complete",
        "round": current_round,
        "images": images,
        "image_count": len(images)
    })

    # When resumed: set next round and the follow-up request
    return {
        "analysis_round": current_round + 1,
        "follow_up_request": str(user_response)
    }


def route_followup(state: AppState) -> str:
    request = state.get("follow_up_request", "")
    if request == "__summary__":
        return "SummaryModel"
    return "CodeModel"


# ── Summary Model Node ───────────────────────────────────────────────────────

summary_llm = ChatGoogleGenerativeAI(model="gemini-2.5-flash")


async def summary_model_node(state: AppState):
    user_id = state.get("user_id", "")
    user_dir = f"./data/{user_id}"

    # Read the analytical plan
    plan = ""
    plan_path = f"{user_dir}/output.txt"
    if os.path.exists(plan_path):
        with open(plan_path, "r") as f:
            plan = f.read()

    # Collect all images across all rounds
    all_images = []
    max_round = state.get("analysis_round", 2) or 2
    for r in range(1, max_round):
        rd = f"{user_dir}/outputs/round_{r}"
        if os.path.exists(rd):
            for fname in sorted(os.listdir(rd)):
                if fname.lower().endswith(('.png', '.jpg', '.jpeg', '.svg')):
                    all_images.append({"round": r, "filename": fname})

    # Collect code execution results from messages
    code_results = []
    for m in state.get("messages", []):
        if isinstance(m, ToolMessage) and getattr(m, "name", "") == "execute_code":
            content = m.content or ""
            if "STDOUT" in content:
                code_results.append(content)

    context = f"""--- ANALYSIS PLAN ---
{plan}
--- END PLAN ---

--- GENERATED CHARTS ({len(all_images)} total) ---
{json.dumps(all_images, indent=2)}
--- END CHARTS ---

--- CODE EXECUTION RESULTS ---
{chr(10).join(code_results[:20])}
--- END RESULTS ---
"""

    response = await summary_llm.ainvoke([
        SystemMessage(content=SUMMARY_MODEL_PROMPT),
        HumanMessage(content=context)
    ])

    summary_text = response.content if isinstance(response.content, str) else str(response.content)

    # Save the summary
    summary_path = f"{user_dir}/executive_summary.md"
    os.makedirs(user_dir, exist_ok=True)
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(summary_text)

    return {"messages": [response]}


# ── Graph Construction ───────────────────────────────────────────────────────

graph = StateGraph(AppState)

graph.add_node("UnderstadingModel", understand_data_model)
graph.add_node("tools", tool_node)
graph.add_node("CodeModel", code_model_node)
graph.add_node("code_tools", code_tools)
graph.add_node("FollowUp", followup_node)
graph.add_node("SummaryModel", summary_model_node)

# Understanding phase
graph.add_edge(START, "UnderstadingModel")
graph.add_edge("tools", "UnderstadingModel")

graph.add_conditional_edges(
    "UnderstadingModel",
    has_understanding,
    {
        "tools": "tools",
        END: "CodeModel"
    }
)

# Code generation phase
graph.add_edge("code_tools", "CodeModel")

graph.add_conditional_edges(
    "CodeModel",
    route_code_model,
    {
        "code_tools": "code_tools",
        "FollowUp": "FollowUp"
    }
)

# Follow-up decision
graph.add_conditional_edges(
    "FollowUp",
    route_followup,
    {
        "CodeModel": "CodeModel",
        "SummaryModel": "SummaryModel"
    }
)

# Summary ends the graph
graph.add_edge("SummaryModel", END)


memory = MemorySaver()
workflow = graph.compile(checkpointer=memory)


if __name__ == "__main__":
    import asyncio

    show_graph(workflow)

    configuration = {
        "configurable": {
            "thread_id": "1"
        }
    }

    async def dict_stream(stream):
        async for event in stream:
            for node, event_state in event.items():
                print(f"\n[{node}]")
                if "messages" in event_state:
                    for msg in event_state["messages"]:
                        msg.pretty_print()
                else:
                    print(event_state)

    async def main():
        await dict_stream(
            workflow.astream(
                {"data_path":"./data/Warehouse_and_Retail_Sales.csv", "user_id": str(uuid.uuid4())},
                config=configuration
            )
        )

        state = await workflow.aget_state(configuration)
        while state.next:
            tasks = state.tasks
            if tasks and tasks[0].interrupts:
                question = tasks[0].interrupts[0].value.get("question", "Please provide input:")

                print(f"\n--- AI QUESTION ---")
                user_input = input(f"{question}\n> ")

                from langgraph.types import Command
                await dict_stream(
                    workflow.astream(Command(resume=str(user_input)), config=configuration)
                )

                state = await workflow.aget_state(configuration)
            else:
                break

    asyncio.run(main())







