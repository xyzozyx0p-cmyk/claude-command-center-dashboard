import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Cloud,
  Command,
  Cpu,
  Download,
  File,
  Folder,
  LogOut,
  Menu,
  Paperclip,
  Play,
  RefreshCw,
  RotateCw,
  Send,
  Server,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  Upload,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { cn } from "@/lib/utils";

type View = "overview" | "tasks" | "terminal" | "files";
type Status = { ok: boolean; sessions: string[]; workspace: string; default_project: string; claude_installed: boolean };
type ModelsResponse = { ok: boolean; current: string | null; models: Array<{ alias: string; provider: string; protocol: string; wildcard?: boolean; discovered?: boolean }> };
type FileEntry = { name: string; path: string; type: "directory" | "file"; size: number | null };
type FilesResponse = { ok: boolean; path: string; entries: FileEntry[] };
type InfraResponse = { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
type Message = { id: string; role: "operator" | "system"; text: string; time: string; state?: "accepted" | "error" };
type Attachment = { name: string; path: string; size: number; type: string };
type CommandSuggestion = { name: string; source: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init });
  const text = await response.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }
  if (!response.ok) {
    const detail = typeof payload === "object" && payload && "error" in payload ? String(payload.error) : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
}

function jsonInit(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function formatBytes(value: number | null) {
  if (value === null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function timeLabel(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("status-pill", ok ? "status-pill--ok" : "status-pill--bad")}>
      <span className="status-dot" /> {label}
    </span>
  );
}

function SectionTitle({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {action}
    </div>
  );
}

export default function Home() {
  const auth = useAuth();
  const [view, setView] = useState<View>("overview");
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [infra, setInfra] = useState<InfraResponse | null>(null);
  const [output, setOutput] = useState("");
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filePath, setFilePath] = useState("instabox-24-7-agent");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState("Terminal session is not connected. Start it to attach to tmux.\n");
  const [terminalConnected, setTerminalConnected] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [commandSuggestions, setCommandSuggestions] = useState<CommandSuggestion[]>([]);
  const [commandSuggestionIndex, setCommandSuggestionIndex] = useState(0);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const terminalRef = useRef<WebSocket | null>(null);
  const outputStreamRef = useRef<WebSocket | null>(null);
  const outputStreamConnecting = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);

  const connectOutputStream = useCallback(async () => {
    const current = outputStreamRef.current;
    if (outputStreamConnecting.current || (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING))) return;
    outputStreamConnecting.current = true;
    try {
      const ticket = await api<{ ticket: string }>("/api/control/ws-ticket", jsonInit({ session: "claude" }));
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${window.location.host}/api/control/sessions/claude/ws?ticket=${encodeURIComponent(ticket.ticket)}`);
      outputStreamRef.current = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        setOutput(currentOutput => currentOutput || "[live stream connected]\n");
      };
      socket.onmessage = async event => {
        const value = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer());
        setOutput(currentOutput => `${currentOutput}${value}`.slice(-24000));
      };
      socket.onclose = () => {
        if (outputStreamRef.current === socket) outputStreamRef.current = null;
      };
      socket.onerror = () => socket.close();
    } catch {
      // The Claude tmux session may not exist yet; the next status refresh retries.
    } finally {
      outputStreamConnecting.current = false;
    }
  }, []);

  const refreshCore = useCallback(async () => {
    const results = await Promise.allSettled([
      api<Status>("/api/control/status"),
      api<ModelsResponse>("/api/control/models"),
      api<InfraResponse>("/api/control/infrastructure"),
    ]);
    const [statusResult, modelsResult, infraResult] = results;
    if (statusResult.status === "fulfilled") {
      setStatus(statusResult.value);
      if (statusResult.value.sessions.includes("claude")) {
        void connectOutputStream();
      } else {
        outputStreamRef.current?.close();
        setOutput("Ожидание вывода persistent-сессии… Запустите Claude, чтобы начать работу.");
      }
    }
    if (modelsResult.status === "fulfilled") setModels(modelsResult.value);
    if (infraResult.status === "fulfilled") setInfra(infraResult.value);
    const failedResult = results.find(result => result.status === "rejected");
    if (failedResult && failedResult.status === "rejected") {
      const message = failedResult.reason instanceof Error ? failedResult.reason.message : "Control Plane unavailable";
      if (message !== "HTTP 404") setNotice(message);
    }
  }, [connectOutputStream]);

  const refreshFiles = useCallback(async (path = filePath) => {
    setFilesLoading(true);
    try {
      const result = await api<FilesResponse>(`/api/control/files?path=${encodeURIComponent(path)}`);
      setFiles(result.entries);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to read files");
    } finally {
      setFilesLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    if (!auth.isAuthenticated) return;
    void refreshCore();
    const timer = window.setInterval(() => void refreshCore(), 5000);
    return () => window.clearInterval(timer);
  }, [auth.isAuthenticated, refreshCore]);

  useEffect(() => {
    if (!auth.isAuthenticated || view !== "files") return;
    void refreshFiles();
  }, [auth.isAuthenticated, view, refreshFiles]);

  useEffect(() => () => {
    terminalRef.current?.close();
    outputStreamRef.current?.close();
  }, []);

  useEffect(() => {
    const match = message.match(/^\/(\S*)$/);
    if (!auth.isAuthenticated || !match) {
      setCommandSuggestions([]);
      setCommandsLoading(false);
      return;
    }
    let cancelled = false;
    setCommandsLoading(true);
    const timer = window.setTimeout(() => {
      void api<{ commands: CommandSuggestion[] }>(`/api/control/claude/commands?q=${encodeURIComponent(match[1])}`)
        .then(result => { if (!cancelled) { setCommandSuggestions(result.commands); setCommandSuggestionIndex(0); } })
        .catch(() => { if (!cancelled) setCommandSuggestions([]); })
        .finally(() => { if (!cancelled) setCommandsLoading(false); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [auth.isAuthenticated, message]);

  const sendMessage = async () => {
    const value = message.trim();
    if ((!value && attachments.length === 0) || busy) return;
    setBusy("message");
    setMessage("");
    setCommandSuggestions([]);
    const attachmentNote = attachments.length ? `\n\nПрикреплённые файлы (прочитай их из workspace):\n${attachments.map(item => `- ${item.path}`).join("\n")}` : "";
    const outbound = `${value}${attachmentNote}`.trim();
    const entry: Message = { id: crypto.randomUUID(), role: "operator", text: outbound, time: timeLabel() };
    setMessages(current => [...current, entry]);
    try {
      await api("/api/control/claude/message", jsonInit({ message: outbound, session: "claude" }));
      setMessages(current => current.map(item => item.id === entry.id ? { ...item, state: "accepted" } : item));
      setNotice("Задание принято persistent-сессией Claude");
      setAttachments([]);
      setTimeout(() => void refreshCore(), 700);
    } catch (error) {
      setMessages(current => current.map(item => item.id === entry.id ? { ...item, state: "error" } : item));
      setNotice(error instanceof Error ? error.message : "Message failed");
    } finally {
      setBusy(null);
    }
  };

  const uploadAttachments = async (filesToUpload: File[]) => {
    if (!filesToUpload.length || busy) return;
    setBusy("attachment");
    try {
      const uploaded: Attachment[] = [];
      for (const file of filesToUpload) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-160) || "attachment";
        const path = `instabox-24-7-agent/.claude-dashboard-attachments/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
        const form = new FormData();
        form.append("path", path);
        form.append("file", file);
        await api(`/api/control/files/upload?path=${encodeURIComponent(path)}`, { method: "POST", body: form });
        uploaded.push({ name: file.name, path, size: file.size, type: file.type || "application/octet-stream" });
      }
      setAttachments(current => [...current, ...uploaded]);
      setNotice(`${uploaded.length} файл(а) прикреплено`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось прикрепить файл");
    } finally {
      setBusy(null);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  };

  const chooseCommand = (name: string) => {
    setMessage(`${name} `);
    setCommandSuggestions([]);
    window.setTimeout(() => messageInputRef.current?.focus(), 0);
  };

  const handleMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (commandSuggestions.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setCommandSuggestionIndex(index => (index + 1) % commandSuggestions.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setCommandSuggestionIndex(index => (index - 1 + commandSuggestions.length) % commandSuggestions.length); return; }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey)) { event.preventDefault(); chooseCommand(commandSuggestions[commandSuggestionIndex].name); return; }
      if (event.key === "Escape") { event.preventDefault(); setCommandSuggestions([]); return; }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void sendMessage();
  };

  const startClaude = async () => {
    setBusy("start");
    try {
      await api("/api/control/claude/start", jsonInit({ session: "claude" }));
      setNotice("Claude session is online");
      await refreshCore();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to start Claude");
    } finally {
      setBusy(null);
    }
  };

  const sendCommand = async () => {
    const value = command.trim();
    if (!value || busy) return;
    setBusy("command");
    setCommand("");
    try {
      await api("/api/control/command", jsonInit({ command: value, session: "claude" }));
      setNotice("Command sent to tmux session");
      setTimeout(() => void refreshCore(), 500);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Command failed");
    } finally {
      setBusy(null);
    }
  };

  const selectModel = async (model: string) => {
    setBusy("model");
    try {
      await api("/api/control/models/select", jsonInit({ model }));
      setNotice("Model saved. Start a new Claude session to apply it.");
      await refreshCore();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Model selection failed");
    } finally {
      setBusy(null);
    }
  };

  const connectTerminal = async () => {
    if (terminalRef.current) {
      terminalRef.current.close();
      terminalRef.current = null;
      setTerminalConnected(false);
      return;
    }
    setBusy("terminal");
    try {
      await api("/api/control/sessions", jsonInit({ session: "terminal" }));
      const ticket = await api<{ ticket: string }>("/api/control/ws-ticket", jsonInit({ session: "terminal" }));
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${window.location.host}/api/control/sessions/terminal/ws?ticket=${encodeURIComponent(ticket.ticket)}`);
      terminalRef.current = socket;
      socket.onopen = () => {
        setTerminalConnected(true);
        setTerminalOutput(current => `${current}\n[connected to terminal]\n`);
      };
      socket.onmessage = async event => {
        const value = typeof event.data === "string" ? event.data : await event.data.text();
        setTerminalOutput(current => `${current}${value}`.slice(-24000));
      };
      socket.onclose = () => {
        setTerminalConnected(false);
        terminalRef.current = null;
      };
      socket.onerror = () => setNotice("Interactive terminal connection failed");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Terminal failed");
    } finally {
      setBusy(null);
    }
  };

  const sendTerminalInput = () => {
    if (!terminalInput || terminalRef.current?.readyState !== WebSocket.OPEN) return;
    terminalRef.current.send(`${terminalInput}\n`);
    setTerminalInput("");
  };

  const uploadFile = async (file: File) => {
    setBusy("upload");
    const path = `${filePath.replace(/\/$/, "")}/${file.name}`;
    const form = new FormData();
    form.append("path", path);
    form.append("file", file);
    try {
      await api(`/api/control/files/upload?path=${encodeURIComponent(path)}`, { method: "POST", body: form });
      setNotice(`Uploaded ${file.name}`);
      await refreshFiles();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const downloadFile = async (path: string) => {
    try {
      const response = await fetch(`/api/control/files/download?path=${encodeURIComponent(path)}`, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = path.split("/").pop() || "download";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Download failed");
    }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError(null);
    try {
      await api("/api/auth/login", jsonInit({ username: loginUsername, password: loginPassword }));
      setLoginPassword("");
      await auth.refresh();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Не удалось войти");
    } finally {
      setLoginBusy(false);
    }
  };

  const nav = useMemo(() => [
    { id: "overview" as const, label: "Обзор", icon: Activity },
    { id: "tasks" as const, label: "Задания", icon: Bot },
    { id: "terminal" as const, label: "Терминал", icon: SquareTerminal },
    { id: "files" as const, label: "Файлы", icon: Folder },
  ], []);

  if (auth.loading) return <div className="boot-screen"><div className="brand-mark">CC</div><span>Синхронизация с командным центром…</span></div>;
  if (!auth.isAuthenticated) return <main className="boot-screen"><form className="login-card" onSubmit={login}><div className="brand-mark">CC</div><h1>Claude Command Center</h1><p>Введите логин и пароль оператора, чтобы открыть защищённую панель.</p>{loginError && <div className="login-error">{loginError}</div>}<div className="login-form"><label>Логин<input autoComplete="username" value={loginUsername} onChange={event => setLoginUsername(event.target.value)} required /></label><label>Пароль<input type="password" autoComplete="current-password" value={loginPassword} onChange={event => setLoginPassword(event.target.value)} required minLength={12} /></label><button className="primary-button" type="submit" disabled={loginBusy}>{loginBusy ? "Проверка…" : "Войти"}</button></div></form></main>;

  const sessionOnline = Boolean(status?.sessions?.includes("claude"));
  const working = Boolean(busy);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark">CC</div><div><strong>CLAUDE</strong><span>CONTROL CENTER</span></div></div>
        <div className="sidebar-label">Workspace</div>
        <div className="workspace-switch"><span className="workspace-dot" /><div><strong>instabox-24-7-agent</strong><span>production workspace</span></div><ChevronRight size={15} /></div>
        <nav className="nav-list" aria-label="Main navigation">
          {nav.map(item => {
            const Icon = item.icon;
            return <button key={item.id} className={cn("nav-item", view === item.id && "nav-item--active")} onClick={() => setView(item.id)}><Icon size={17} /><span>{item.label}</span>{item.id === "tasks" && messages.length > 0 && <b>{messages.length}</b>}</button>;
          })}
        </nav>
        <div className="sidebar-footer"><div className="secure-note"><ShieldCheck size={16} /><span>Server proxy active<br /><small>Control token stays private</small></span></div><button className="logout-button" onClick={() => void auth.logout()}><LogOut size={16} /> Выйти</button></div>
      </aside>

      <main className="main-stage">
        <header className="topbar"><div className="mobile-brand"><button className="icon-button" onClick={() => setView("overview")}><Menu size={18} /></button><span>CLAUDE / CONTROL</span></div><div className="topbar-meta"><span className="live-indicator"><span /> {working ? "working" : "live"}</span><span className="topbar-time">{timeLabel()}</span><button className="icon-button" onClick={() => void refreshCore()} title="Refresh"><RefreshCw size={16} /></button><div className="avatar">{(auth.user?.name || "O").slice(0, 1).toUpperCase()}</div></div></header>

        {notice && <div className="notice-bar"><Zap size={15} /><span>{notice}</span><button onClick={() => setNotice(null)}><X size={15} /></button></div>}

        <div className="content-wrap">
          {view === "overview" && <>
            <SectionTitle eyebrow="OPERATIONAL OVERVIEW" title="Командный центр" detail="Один экран для состояния инфраструктуры, задач Claude и текущего вывода." action={<button className="secondary-button" onClick={() => void refreshCore()}><RefreshCw size={14} /> Обновить</button>} />
            <div className="metric-grid">
              <div className="metric-card metric-card--accent"><div className="metric-icon"><Activity size={18} /></div><div><span>Control Plane</span><strong>{status?.ok ? "ONLINE" : "CHECKING"}</strong><small>{status?.workspace || "Connecting to workspace"}</small></div><StatusPill ok={Boolean(status?.ok)} label={status?.ok ? "ready" : "pending"} /></div>
              <div className="metric-card"><div className="metric-icon"><Bot size={18} /></div><div><span>Claude session</span><strong>{sessionOnline ? "ATTACHED" : "OFFLINE"}</strong><small>tmux / claude</small></div><StatusPill ok={sessionOnline} label={sessionOnline ? "live" : "stopped"} /></div>
              <div className="metric-card"><div className="metric-icon"><Cloud size={18} /></div><div><span>Render watchdog</span><strong>{infra?.checks.find(item => item.name === "Render watchdog")?.ok ? "REACHABLE" : "CHECKING"}</strong><small>instabox watchdog</small></div><StatusPill ok={Boolean(infra?.checks.find(item => item.name === "Render watchdog")?.ok)} label="monitor" /></div>
              <div className="metric-card"><div className="metric-icon"><Wifi size={18} /></div><div><span>Cloudflare layer</span><strong>{infra?.checks.find(item => item.name === "Cloudflare watchdog")?.ok ? "REACHABLE" : "CHECKING"}</strong><small>third control layer</small></div><StatusPill ok={Boolean(infra?.checks.find(item => item.name === "Cloudflare watchdog")?.ok)} label="monitor" /></div>
            </div>
            <div className="work-grid">
              <section className="panel composer-panel"><div className="panel-heading"><div><div className="eyebrow">TASK DISPATCH</div><h3>Новое задание</h3></div><span className="kbd">claude</span></div><div className="message-editor"><textarea ref={messageInputRef} value={message} onChange={event => setMessage(event.target.value)} onKeyDown={handleMessageKeyDown} placeholder="Опишите, что нужно сделать… Введите / для актуальных команд Claude" rows={6} />{(commandSuggestions.length > 0 || commandsLoading) && <div className="command-suggestions"><div className="suggestion-caption">Команды из текущего workspace {commandsLoading && "· обновление…"}</div>{commandSuggestions.map((item, index) => <button type="button" className={cn("command-suggestion", index === commandSuggestionIndex && "command-suggestion--active")} key={`${item.source}-${item.name}`} onMouseDown={event => { event.preventDefault(); chooseCommand(item.name); }}><strong>{item.name}</strong><span>{item.source}</span></button>)}</div>}</div>{attachments.length > 0 && <div className="attachment-list">{attachments.map(item => <div className="attachment-chip" key={item.path}><Paperclip size={13} /><span title={item.path}>{item.name}</span><button type="button" onClick={() => setAttachments(current => current.filter(file => file.path !== item.path))}><X size={13} /></button></div>)}</div>}<div className="composer-footer"><span><Command size={14} /> Ctrl / ⌘ + Enter · Tab выбирает команду</span><div className="composer-actions"><input ref={attachmentInputRef} type="file" hidden multiple accept="image/*,.pdf,.txt,.md,.json,.csv,.zip,.tar,.gz" onChange={event => void uploadAttachments(Array.from(event.target.files || []))} /><button className="secondary-button" type="button" onClick={() => attachmentInputRef.current?.click()} disabled={Boolean(busy)}><Paperclip size={14} /> Файл или изображение</button><button className="primary-button" onClick={() => void sendMessage()} disabled={(!message.trim() && attachments.length === 0) || Boolean(busy)}><Send size={15} /> {busy === "attachment" ? "Загрузка…" : busy === "message" ? "Отправка…" : "Отправить"}</button></div></div><div className="quick-actions"><button onClick={() => void startClaude()} disabled={Boolean(busy)}><Play size={14} /> Запустить Claude</button><button onClick={() => setView("terminal")}><Terminal size={14} /> Открыть терминал</button></div></section>
              <section className="panel model-panel"><div className="panel-heading"><div><div className="eyebrow">MODEL ROUTING</div><h3>Активная модель</h3></div><Cpu size={18} className="muted-icon" /></div><div className="model-current"><span className="model-pulse" /><strong>{models?.current || "not selected"}</strong></div><label className="field-label">Выбрать модель</label><select value={models?.current || ""} onChange={event => void selectModel(event.target.value)} disabled={!models?.models?.length || Boolean(busy)}><option value="" disabled>Модели загрузятся через proxy</option>{models?.models?.map(model => <option key={model.alias} value={model.alias}>{model.alias}</option>)}</select><div className="model-footer"><span>{models?.models?.length || 0} моделей доступно</span><button className="text-button" onClick={() => void refreshCore()}>Синхронизировать <RotateCw size={13} /></button></div></section>
            </div>
            <section className="panel output-panel"><div className="panel-heading"><div><div className="eyebrow">LIVE OUTPUT</div><h3>Вывод Claude</h3></div><div className="panel-actions"><span className="streaming-badge"><span /> polling 5s</span><button className="icon-button" onClick={() => setOutput("")} title="Clear"><X size={14} /></button></div></div><pre className="terminal-output">{output || "Ожидание вывода persistent-сессии…"}</pre></section>
          </>}

          {view === "tasks" && <><SectionTitle eyebrow="EXECUTION QUEUE" title="Задания и история" detail="Сообщения отправляются в Claude Code через защищённый server proxy." /><div className="tasks-layout"><section className="panel task-history"><div className="panel-heading"><div><div className="eyebrow">CURRENT RUN</div><h3>История панели</h3></div><span className="count-badge">{messages.length}</span></div>{messages.length === 0 ? <div className="empty-state"><Bot size={24} /><span>Здесь появятся отправленные задания.</span></div> : <div className="message-list">{messages.map(item => <div className={cn("message-row", item.role === "operator" ? "message-row--operator" : "message-row--system")} key={item.id}><div className="message-avatar">{item.role === "operator" ? "OP" : "CC"}</div><div><div className="message-meta"><strong>{item.role === "operator" ? "Оператор" : "System"}</strong><span>{item.time}</span>{item.state && <span className={item.state === "accepted" ? "accepted" : "failed"}>{item.state}</span>}</div><p>{item.text}</p></div></div>)}</div>}</section><section className="panel output-panel"><div className="panel-heading"><div><div className="eyebrow">PROCESS STREAM</div><h3>Live вывод</h3></div><CircleDot size={17} className="amber-icon" /></div><pre className="terminal-output terminal-output--tall">{output || "Нет вывода."}</pre></section></div></>}

          {view === "terminal" && <><SectionTitle eyebrow="REMOTE SHELL" title="Интерактивный терминал" detail="Подключение идёт через одноразовый WebSocket ticket; Control Plane token не попадает в браузер." action={<button className={cn("primary-button", terminalConnected && "danger-button")} onClick={() => void connectTerminal()}><SquareTerminal size={15} /> {terminalConnected ? "Отключить" : "Подключиться"}</button>} /><section className="panel terminal-panel"><div className="terminal-toolbar"><span><span className={cn("terminal-led", terminalConnected && "terminal-led--on")} /> tmux / terminal</span><span>session: terminal</span></div><pre className="interactive-terminal">{terminalOutput}</pre><div className="terminal-input-row"><span className="prompt">$</span><input value={terminalInput} onChange={event => setTerminalInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") sendTerminalInput(); }} placeholder={terminalConnected ? "Введите команду…" : "Сначала подключите терминал"} disabled={!terminalConnected} /><button className="icon-button" onClick={sendTerminalInput} disabled={!terminalConnected}><Send size={15} /></button></div></section><div className="terminal-note"><ShieldCheck size={16} /><span>Сессия ограничена workspace Control Plane. Для каждого подключения используется короткоживущий ticket.</span></div></>}

          {view === "files" && <><SectionTitle eyebrow="WORKSPACE STORAGE" title="Файлы проекта" detail="Загрузка и скачивание идут через серверный proxy и ограничены workspace основной машины." action={<><input ref={fileInputRef} type="file" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void uploadFile(file); }} /><button className="primary-button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(busy)}><Upload size={15} /> Загрузить файл</button></>} /><section className="panel files-panel"><div className="file-breadcrumb"><Folder size={15} /><span>/data/workspace/</span><strong>{filePath}</strong><button className="icon-button" onClick={() => void refreshFiles()}><RefreshCw size={14} /></button></div><div className="file-table-head"><span>NAME</span><span>TYPE</span><span>SIZE</span><span>ACTION</span></div>{filesLoading ? <div className="empty-state"><RefreshCw className="spin" size={22} /> Читаю workspace…</div> : files.length === 0 ? <div className="empty-state"><File size={22} /> В этой директории пока нет файлов.</div> : <div>{files.map(entry => <div className="file-row" key={entry.path}><div className="file-name">{entry.type === "directory" ? <Folder size={16} /> : <File size={16} />}<span>{entry.name}</span></div><span className="file-type">{entry.type}</span><span className="file-size">{formatBytes(entry.size)}</span><span>{entry.type === "file" ? <button className="text-button" onClick={() => void downloadFile(entry.path)}><Download size={14} /> Download</button> : <button className="text-button" onClick={() => { setFilePath(entry.path); void refreshFiles(entry.path); }}><ChevronRight size={14} /> Open</button>}</span></div>)}</div>}</section></>}
        </div>
      </main>
    </div>
  );
}
