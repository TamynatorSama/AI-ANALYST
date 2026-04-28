# 📊 DATAAN — AI Data Analysis

DATAAN is an intelligent, multi-agent AI data analysis dashboard. It allows you to upload datasets and automatically processes, analyzes, and visualizes the data using a LangGraph-orchestrated workflow powered by Google's Gemini models. Talk to your data, ask follow-up questions, and generate comprehensive executive summaries with just a few clicks.

![DATAAN Overview](https://img.shields.io/badge/Status-Active-success) ![Python](https://img.shields.io/badge/Python-3.10+-blue) ![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-009688) ![LangGraph](https://img.shields.io/badge/LangGraph-Agentic-orange)

## ✨ Features

- **🧠 Multi-Agent Workflow:** Powered by LangGraph, DATAAN separates concerns into understanding the data, generating execution code, and summarizing results.
- **📂 Automated Profiling:** Simply upload a `.csv`, `.json`, or `.xlsx` file, and the agent will automatically parse it to understand schema, outliers, and correlations.
- **💬 Conversational UI:** A real-time WebSocket chat interface to interact with the analysis agent. Ask it to generate specific plots or dive deeper into metrics.
- **📈 Auto-Generated Visualizations:** Python code executed securely in a subprocess generates Matplotlib/Seaborn charts that are instantly served to the frontend.
- **📝 Executive Summary Export:** Automatically compile all findings, insights, and charts into a polished `.docx` Executive Summary ready for presentation.

## 🛠️ Tech Stack

- **Backend:** FastAPI, Uvicorn, WebSockets
- **AI Framework:** LangGraph, LangChain, Google Generative AI (Gemini 2.5 Flash & 3.1 Pro)
- **Data Engine:** Pandas, NumPy, Matplotlib, Seaborn
- **Frontend:** HTML5, CSS3, Vanilla JavaScript (Zero-dependency frontend)

## 🚀 Getting Started

### 1. Prerequisites
Ensure you have Python 3.10+ installed.

### 2. Installation
Clone the repository and install the dependencies:
```bash
pip install -r requirements.txt
```
*(Make sure `fastapi`, `uvicorn`, `langgraph`, `langchain-google-genai`, `pandas`, `matplotlib`, `seaborn`, `python-docx` are installed).*

### 3. Environment Variables
Create a `.env` file in the root directory and add your Google Gemini API Key:
```env
GOOGLE_API_KEY=your_gemini_api_key_here
```

### 4. Run the Server
Start the development server using the provided runner script:
```bash
python run.py
```
The application will be available at `http://127.0.0.1:8000`.

## 🧠 How it Works

DATAAN utilizes a state machine built with **LangGraph**:
1. **Understanding Phase:** The initial model profiles the dataset, computing basic stats and generating an analytical plan.
2. **Code Generation Phase:** A dedicated coding model writes Python scripts to execute the plan and generate visualizations.
3. **Execution Phase:** The generated script runs in a secure, isolated subprocess to generate outputs and charts safely.
4. **Follow-Up & Summarization:** The user can iterate via chat or request a final executive summary, compiled by the AI into an exportable document.

## 📁 Project Structure

- `server.py` - FastAPI backend, WebSocket handler, and session management.
- `agent.py` - LangGraph state machine, tool definitions, and LLM integrations.
- `run.py` - Uvicorn entry point.
- `static/` - Frontend assets (`index.html`, `app.js`, `styles.css`).
- `data/` - Session storage, uploaded datasets, and generated outputs.

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.
