/* ════════════════════════════════════════════════════════════════════
   DATAAN — Client-side Application
   ════════════════════════════════════════════════════════════════════ */

const API = "";
const WS_BASE = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

// ── State ────────────────────────────────────────────────────────────
const state = {
    sessions: [],
    activeSessionId: null,
    ws: null,
    theme: localStorage.getItem("dataan-theme") || "light",
    sessionImages: JSON.parse(localStorage.getItem("dataan-images") || "{}"),
    sessionMessages: JSON.parse(localStorage.getItem("dataan-messages") || "{}"),
    waitingForInput: false,
    roundComplete: false,
    summaryData: null,
};

// ── DOM refs ────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const sessionListEl = $("#sessionList");
const sessionTitleEl = $("#sessionTitle");
const welcomeStateEl = $("#welcomeState");
const chatAreaEl = $("#chatArea");
const messagesEl = $("#messages");
const inputAreaEl = $("#inputArea");
const userInputEl = $("#userInput");
const sendBtnEl = $("#sendBtn");
const summaryBtnEl = $("#summaryBtn");
const viewResultsBtnEl = $("#viewResultsBtn");
const newAnalysisBtnEl = $("#newAnalysisBtn");
const themeToggleEl = $("#themeToggle");
const overlayBackdropEl = $("#overlayBackdrop");
const analysisOverlayEl = $("#analysisOverlay");
const overlayTitleEl = $("#overlayTitle");
const overlayContentEl = $("#overlayContent");
const closeOverlayEl = $("#closeOverlay");
const downloadSummaryEl = $("#downloadSummary");
const uploadZoneEl = $("#uploadZone");
const fileInputEl = $("#fileInput");
const sidebarEl = $("#sidebar");
const sidebarToggleEl = $("#sidebarToggle");

// ── Theme ───────────────────────────────────────────────────────────
function applyTheme(t) {
    state.theme = t;
    document.body.setAttribute("data-theme", t);
    localStorage.setItem("dataan-theme", t);
}
applyTheme(state.theme);

themeToggleEl.addEventListener("click", () => {
    applyTheme(state.theme === "light" ? "dark" : "light");
});

// ── Sidebar toggle (mobile) ─────────────────────────────────────────
sidebarToggleEl.addEventListener("click", () => {
    sidebarEl.classList.toggle("collapsed");
});

// ── Session CRUD ────────────────────────────────────────────────────
async function fetchSessions() {
    const res = await fetch(`${API}/api/sessions`);
    state.sessions = await res.json();
    renderSessionList();
}

async function createSession() {
    const res = await fetch(`${API}/api/sessions`, { method: "POST" });
    const s = await res.json();
    state.sessions.unshift(s);
    state.sessionMessages[s.id] = [];
    switchToSession(s.id);
    renderSessionList();
}

async function deleteSession(id, ev) {
    ev.stopPropagation();
    await fetch(`${API}/api/sessions/${id}`, { method: "DELETE" });
    state.sessions = state.sessions.filter((s) => s.id !== id);
    delete state.sessionMessages[id];
    delete state.sessionImages[id];
    _persist();
    if (state.activeSessionId === id) {
        state.activeSessionId = null;
        disconnectWs();
        showWelcome();
    }
    renderSessionList();
}

function renderSessionList() {
    sessionListEl.innerHTML = state.sessions
        .map((s) => {
            const active = s.id === state.activeSessionId ? "active" : "";
            const statusClass = s.status || "idle";
            const time = s.created_at ? timeAgo(s.created_at) : "";
            return `
            <div class="session-item ${active}" data-id="${s.id}">
                <span class="session-dot ${statusClass}"></span>
                <div class="session-info">
                    <div class="session-name">${esc(s.name)}</div>
                    <div class="session-time">${time}</div>
                </div>
                <button class="session-delete" data-id="${s.id}" title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>`;
        })
        .join("");

    sessionListEl.querySelectorAll(".session-item").forEach((el) => {
        el.addEventListener("click", () => switchToSession(el.dataset.id));
    });
    sessionListEl.querySelectorAll(".session-delete").forEach((el) => {
        el.addEventListener("click", (e) => deleteSession(el.dataset.id, e));
    });
}

async function switchToSession(id) {
    state.activeSessionId = id;
    const s = state.sessions.find((x) => x.id === id);
    sessionTitleEl.textContent = s ? s.name : "Dashboard";
    state.roundComplete = false;
    state.waitingForInput = false;

    renderSessionList();

    // Load chat history from server if we don't have it locally
    if (!state.sessionMessages[id] || state.sessionMessages[id].length === 0) {
        try {
            const res = await fetch(`${API}/api/sessions/${id}/chat`);
            const serverMsgs = await res.json();
            if (serverMsgs.length > 0) {
                state.sessionMessages[id] = _convertServerMessages(serverMsgs);
                _persist();
            }
        } catch (e) {
            console.warn("Failed to load chat history from server:", e);
        }
    }

    if (!state.sessionMessages[id]) state.sessionMessages[id] = [];
    restoreMessages(id);

    if (s && s.data_path) {
        showChat();
        if (s.status === "complete") {
            viewResultsBtnEl.style.display = "flex";
        }
    } else {
        showUpload();
    }

    connectWs(id);
}

/**
 * Convert server chat_log events into frontend message objects.
 */
function _convertServerMessages(serverMsgs) {
    const msgs = [];
    for (const ev of serverMsgs) {
        switch (ev.type) {
            case "user":
                msgs.push({ type: "user", content: ev.content || "" });
                break;
            case "message":
                if (ev.role === "ai" && ev.node !== "tools" && ev.node !== "code_tools") {
                    msgs.push({ type: "ai", content: ev.content || "" });
                }
                break;
            case "tool_call": {
                // Deduplicate consecutive same-name tool calls
                const prev = msgs[msgs.length - 1];
                if (prev && prev.type === "tool_call" && prev.content === (ev.name || "")) break;
                msgs.push({ type: "tool_call", content: ev.name || "" });
                break;
            }
            case "question":
                msgs.push({ type: "question", content: ev.text || "" });
                break;
            case "round_complete":
                msgs.push({
                    type: "round_complete",
                    content: "",
                    extra: {
                        round: ev.round || 1,
                        imageCount: ev.image_count || (ev.images || []).length,
                        images: ev.images || []
                    }
                });
                // Also restore images into state
                if (!state.sessionImages[state.activeSessionId]) state.sessionImages[state.activeSessionId] = {};
                state.sessionImages[state.activeSessionId][`round_${ev.round || 1}`] = ev.images || [];
                break;
            case "summary_ready":
                state.summaryData = { markdown: ev.markdown || "", images: ev.images || [] };
                msgs.push({ type: "summary_ready", content: "" });
                break;
            case "error":
                msgs.push({ type: "error", content: ev.detail || "" });
                break;
            // Skip status messages on restore — they're transient
        }
    }
    return msgs;
}

// ── Views ───────────────────────────────────────────────────────────
function showWelcome() {
    sessionTitleEl.textContent = "Dashboard";
    welcomeStateEl.style.display = "flex";
    chatAreaEl.style.display = "none";
    inputAreaEl.style.display = "none";
    viewResultsBtnEl.style.display = "none";
    summaryBtnEl.style.display = "none";
}

function showUpload() {
    welcomeStateEl.style.display = "flex";
    chatAreaEl.style.display = "none";
    inputAreaEl.style.display = "none";
    viewResultsBtnEl.style.display = "none";
    summaryBtnEl.style.display = "none";
}

function showChat() {
    welcomeStateEl.style.display = "none";
    chatAreaEl.style.display = "flex";
    inputAreaEl.style.display = "block";
    scrollToBottom();
}

function showInputForFollowup() {
    inputAreaEl.style.display = "block";
    userInputEl.placeholder = "Ask for more analysis, or generate summary...";
    summaryBtnEl.style.display = "inline-flex";
    userInputEl.focus();
    state.waitingForInput = true;
    state.roundComplete = true;
}

function showInputForQuestion() {
    inputAreaEl.style.display = "block";
    userInputEl.placeholder = "Type your answer...";
    summaryBtnEl.style.display = "none";
    userInputEl.focus();
    state.waitingForInput = true;
    state.roundComplete = false;
}

function hideInput() {
    inputAreaEl.style.display = "none";
    summaryBtnEl.style.display = "none";
    state.waitingForInput = false;
}

// ── Message Rendering ───────────────────────────────────────────────
function addMessage(type, content, extra) {
    const id = state.activeSessionId;
    if (!id) return;
    if (!state.sessionMessages[id]) state.sessionMessages[id] = [];
    const msgObj = { type, content, extra };
    state.sessionMessages[id].push(msgObj);
    appendMessageToDOM(msgObj);
    scrollToBottom();
    _persist();
}

function restoreMessages(sessionId) {
    messagesEl.innerHTML = "";
    const msgs = state.sessionMessages[sessionId] || [];
    msgs.forEach((m) => appendMessageToDOM(m));
    scrollToBottom();
}

function _persist() {
    try {
        localStorage.setItem("dataan-messages", JSON.stringify(state.sessionMessages));
        localStorage.setItem("dataan-images", JSON.stringify(state.sessionImages));
    } catch (e) {
        // localStorage full — trim oldest sessions
        const keys = Object.keys(state.sessionMessages);
        if (keys.length > 5) {
            delete state.sessionMessages[keys[0]];
            delete state.sessionImages[keys[0]];
            _persist();
        }
    }
}

function appendMessageToDOM(msgObj) {
    const div = document.createElement("div");
    const { type, content, extra } = msgObj;

    switch (type) {
        case "user":
            div.className = "msg user";
            div.textContent = content;
            break;

        case "ai":
            div.className = "msg ai";
            div.innerHTML = formatContent(content);
            break;

        case "status":
            div.className = "msg status";
            div.innerHTML = `<span class="status-dot"></span>${esc(content)}`;
            break;

        case "tool_call":
            div.className = "msg tool-call";
            const toolLabel = {
                get_data_snapshot: "Analyzing dataset",
                write_to_file: "Writing plan",
                execute_code: "Running analysis",
                ask_user: "Asking you",
            }[content] || content;
            div.innerHTML = `
                <span class="tool-icon"><svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="var(--accent)"/></svg></span>
                ${esc(toolLabel)}`;
            break;

        case "question":
            div.className = "msg question";
            div.innerHTML = formatContent(content);
            break;

        case "round_complete": {
            div.className = "msg round-card";
            const round = extra?.round || 1;
            const count = extra?.imageCount || 0;
            const roundImages = extra?.images || [];
            div.innerHTML = `
                <div class="round-badge">Round ${round}</div>
                <h3>Analysis Complete</h3>
                <p>${count} visualization${count !== 1 ? "s" : ""} generated</p>
                <button class="view-btn" data-round="${round}">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>
                    View Charts
                </button>`;
            // Attach event listener after appending
            setTimeout(() => {
                const btn = div.querySelector(".view-btn");
                if (btn) btn.addEventListener("click", () => openRoundOverlay(round));
            }, 0);
            break;
        }

        case "summary_ready":
            div.className = "msg summary-card";
            div.innerHTML = `
                <div class="round-badge summary">Executive Summary</div>
                <h3>Summary Ready</h3>
                <p>Your comprehensive analysis report is ready</p>
                <button class="view-btn summary-view-btn">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    View Summary
                </button>`;
            setTimeout(() => {
                const btn = div.querySelector(".summary-view-btn");
                if (btn) btn.addEventListener("click", () => openSummaryOverlay());
            }, 0);
            break;

        case "error":
            div.className = "msg ai";
            div.style.borderColor = "#EF4444";
            div.textContent = `Error: ${content}`;
            break;

        default:
            return;
    }

    messagesEl.appendChild(div);
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
    });
}

// ── WebSocket ───────────────────────────────────────────────────────
function connectWs(sessionId) {
    disconnectWs();
    const url = `${WS_BASE}/ws/${sessionId}`;
    state.ws = new WebSocket(url);

    state.ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        handleWsEvent(data);
    };

    state.ws.onerror = () => {
        addMessage("error", "WebSocket connection error");
    };
}

function disconnectWs() {
    if (state.ws) {
        state.ws.close();
        state.ws = null;
    }
}

function wsSend(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(obj));
    }
}

function handleWsEvent(data) {
    switch (data.type) {
        case "status":
            removeLastStatus();
            addMessage("status", data.detail);
            updateSessionStatus(state.activeSessionId, "running");
            break;

        case "message":
            if (data.role === "ai" && data.node !== "tools" && data.node !== "code_tools") {
                addMessage("ai", data.content);
            }
            break;

        case "tool_call": {
            // Skip if the last message is the same tool_call (avoid "Running analysis" x7)
            const id = state.activeSessionId;
            const msgs = state.sessionMessages[id] || [];
            const last = msgs[msgs.length - 1];
            if (last && last.type === "tool_call" && last.content === data.name) break;
            addMessage("tool_call", data.name);
            break;
        }

        case "tool_result":
            break;

        case "question":
            removeLastStatus();
            addMessage("question", data.text);
            showInputForQuestion();
            break;

        case "round_complete": {
            removeLastStatus();
            const round = data.round || 1;
            const imgs = data.images || [];
            if (!state.sessionImages[state.activeSessionId]) state.sessionImages[state.activeSessionId] = {};
            state.sessionImages[state.activeSessionId][`round_${round}`] = imgs;
            addMessage("round_complete", "", { round, imageCount: imgs.length, images: imgs });
            showInputForFollowup();
            updateSessionStatus(state.activeSessionId, "running");
            _persist();
            break;
        }

        case "summary_ready": {
            removeLastStatus();
            state.summaryData = { markdown: data.markdown, images: data.images || [] };
            addMessage("summary_ready", "");
            hideInput();
            viewResultsBtnEl.style.display = "flex";
            viewResultsBtnEl.textContent = "View Summary";
            updateSessionStatus(state.activeSessionId, "complete");
            _persist();
            break;
        }

        case "complete":
            removeLastStatus();
            const imgs2 = data.images || [];
            addMessage("round_complete", "", { round: 1, imageCount: imgs2.length, images: imgs2 });
            hideInput();
            updateSessionStatus(state.activeSessionId, "complete");
            break;

        case "error":
            removeLastStatus();
            addMessage("error", data.detail);
            break;
    }
}

function removeLastStatus() {
    const statusMsgs = messagesEl.querySelectorAll(".msg.status");
    if (statusMsgs.length) statusMsgs[statusMsgs.length - 1].remove();
    const id = state.activeSessionId;
    if (id && state.sessionMessages[id]) {
        const arr = state.sessionMessages[id];
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].type === "status") { arr.splice(i, 1); break; }
        }
    }
}

function updateSessionStatus(id, status) {
    const s = state.sessions.find((x) => x.id === id);
    if (s) s.status = status;
    renderSessionList();
}

// ── File Upload ─────────────────────────────────────────────────────
uploadZoneEl.addEventListener("click", () => fileInputEl.click());

uploadZoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadZoneEl.classList.add("drag-over");
});
uploadZoneEl.addEventListener("dragleave", () => {
    uploadZoneEl.classList.remove("drag-over");
});
uploadZoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadZoneEl.classList.remove("drag-over");
    if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});

fileInputEl.addEventListener("change", () => {
    if (fileInputEl.files.length) uploadFile(fileInputEl.files[0]);
});

async function uploadFile(file) {
    let id = state.activeSessionId;
    if (!id) {
        const res = await fetch(`${API}/api/sessions`, { method: "POST" });
        const s = await res.json();
        state.sessions.unshift(s);
        id = s.id;
        state.sessionMessages[id] = [];
        state.activeSessionId = id;
        renderSessionList();
        connectWs(id);
    }

    const fd = new FormData();
    fd.append("file", file);

    try {
        const res = await fetch(`${API}/api/sessions/${id}/upload`, { method: "POST", body: fd });
        const data = await res.json();

        const s = state.sessions.find((x) => x.id === id);
        if (s) s.name = data.filename;
        sessionTitleEl.textContent = data.filename;
        renderSessionList();

        showChat();
        addMessage("user", `Uploaded ${data.filename}`);
        addMessage("status", "Starting analysis...");

        // Hide input until round completes
        summaryBtnEl.style.display = "none";

        wsSend({ type: "start" });
    } catch (err) {
        addMessage("error", "Failed to upload file");
    }
}

// ── Send User Input ─────────────────────────────────────────────────
function sendUserInput() {
    const text = userInputEl.value.trim();
    if (!text) return;
    userInputEl.value = "";
    summaryBtnEl.style.display = "none";

    addMessage("user", text);

    if (state.roundComplete) {
        // This is a follow-up request — send as answer to resume from FollowUp interrupt
        addMessage("status", "Preparing follow-up analysis...");
        wsSend({ type: "answer", text });
    } else {
        // This is an answer to a question
        wsSend({ type: "answer", text });
    }

    state.waitingForInput = false;
    state.roundComplete = false;
}

sendBtnEl.addEventListener("click", sendUserInput);
userInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendUserInput();
});

// ── Generate Summary ────────────────────────────────────────────────
summaryBtnEl.addEventListener("click", () => {
    summaryBtnEl.style.display = "none";
    addMessage("status", "Generating executive summary...");
    wsSend({ type: "generate_summary" });
    state.waitingForInput = false;
    state.roundComplete = false;
});

// ── New Analysis ────────────────────────────────────────────────────
newAnalysisBtnEl.addEventListener("click", createSession);

// ── Overlay: Round Charts ───────────────────────────────────────────
function openRoundOverlay(round) {
    const id = state.activeSessionId;
    const imgs = state.sessionImages[id]?.[`round_${round}`] || [];

    overlayTitleEl.textContent = `Analysis — Round ${round}`;

    overlayContentEl.innerHTML = imgs.length
        ? imgs
            .map((img) => {
                const caption = img.filename.replace(/\.\w+$/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                return `
                <div class="chart-card">
                    <img src="${img.url}" alt="${esc(caption)}" loading="lazy">
                    <div class="chart-caption">${esc(caption)}</div>
                </div>`;
            })
            .join("")
        : '<p style="text-align:center;color:var(--text-muted);padding:40px">No visualizations for this round.</p>';

    downloadSummaryEl.style.display = "none";
    analysisOverlayEl.classList.add("open");
    overlayBackdropEl.classList.add("open");
}

// ── Overlay: Executive Summary ──────────────────────────────────────
async function openSummaryOverlay() {
    const id = state.activeSessionId;
    if (!id) return;

    // Fetch from server if we don't have it cached (e.g. after page refresh)
    if (!state.summaryData) {
        try {
            const res = await fetch(`${API}/api/sessions/${id}/summary`);
            if (!res.ok) {
                addMessage("error", "No summary available yet");
                return;
            }
            state.summaryData = await res.json();
        } catch (e) {
            addMessage("error", "Failed to load summary");
            return;
        }
    }

    overlayTitleEl.textContent = "Executive Summary";

    const md = state.summaryData.markdown || "";
    const images = state.summaryData.images || [];

    // Render markdown
    let html = renderMarkdown(md);

    // Try to replace [See: filename.png] references with inline images
    const matched = new Set();
    for (const img of images) {
        // Match both [See: filename.png] and **[See: filename.png]**
        const patterns = [
            new RegExp(`(<strong>)?\\[See:\\s*${escapeRegex(img.filename)}\\](</strong>)?`, "gi"),
            new RegExp(`(<strong>)?\\[See:\\s*${escapeRegex(img.filename.replace(/\.\w+$/, ""))}[^\\]]*\\](</strong>)?`, "gi"),
        ];
        const imgHtml = `<div class="chart-card embedded-chart"><img src="${img.url}" alt="${esc(img.filename)}" loading="lazy"><div class="chart-caption">${img.filename.replace(/\.\w+$/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} (Round ${img.round})</div></div>`;
        for (const pattern of patterns) {
            if (pattern.test(html)) {
                html = html.replace(pattern, imgHtml);
                matched.add(img.filename);
                break;
            }
        }
    }

    // Append ALL charts at the end (in a collapsible gallery)
    if (images.length > 0) {
        html += `<hr><h3 class="md-h2">All Visualizations</h3>`;
        for (const img of images) {
            const caption = img.filename.replace(/\.\w+$/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
            html += `<div class="chart-card embedded-chart"><img src="${img.url}" alt="${esc(caption)}" loading="lazy"><div class="chart-caption">${esc(caption)} (Round ${img.round})</div></div>`;
        }
    }

    overlayContentEl.innerHTML = `<div class="summary-content">${html}</div>`;
    downloadSummaryEl.style.display = "flex";
    analysisOverlayEl.classList.add("open");
    overlayBackdropEl.classList.add("open");
}

function closeOverlayFn() {
    analysisOverlayEl.classList.remove("open");
    overlayBackdropEl.classList.remove("open");
}

viewResultsBtnEl.addEventListener("click", () => {
    openSummaryOverlay();

});
closeOverlayEl.addEventListener("click", closeOverlayFn);
overlayBackdropEl.addEventListener("click", closeOverlayFn);

// ── Download Summary ────────────────────────────────────────────────
downloadSummaryEl.addEventListener("click", () => {
    const id = state.activeSessionId;
    if (!id) return;
    window.open(`${API}/api/sessions/${id}/summary/download`, "_blank");
});

// ── Utilities ───────────────────────────────────────────────────────
function esc(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatContent(text) {
    let h = esc(text);
    h = h.replace(/\n/g, "<br>");
    h = h.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/`(.*?)`/g, '<code style="background:var(--bg-inset);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>');
    return h;
}

function renderMarkdown(md) {
    // Simple markdown → HTML renderer
    let html = esc(md);

    // Headers (process from h4 down to h1 to avoid conflicts)
    html = html.replace(/^#### (.+)$/gm, '<h5 class="md-h4">$1</h5>');
    html = html.replace(/^### (.+)$/gm, '<h4 class="md-h3">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 class="md-h2">$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2 class="md-h1">$1</h2>');

    // Bold & italic
    html = html.replace(/\*\*\*(.*?)\*\*\*/g, "<strong><em>$1</em></strong>");
    html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");

    // Inline code
    html = html.replace(/`(.*?)`/g, '<code>$1</code>');

    // Bullet lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Numbered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Paragraphs (double newlines)
    html = html.replace(/\n\n/g, "</p><p>");
    html = "<p>" + html + "</p>";

    // Single newlines within paragraphs
    html = html.replace(/\n/g, "<br>");

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, "");

    // Horizontal rules
    html = html.replace(/<p>---<\/p>/g, "<hr>");

    return html;
}

function timeAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

// ── Init ─────────────────────────────────────────────────────────────
fetchSessions();
showWelcome();
