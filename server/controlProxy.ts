import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import { sdk } from "./_core/sdk";
import WebSocket, { WebSocketServer } from "ws";

const RENDER_WATCHDOG_URL = "https://instabox-24-7-watchdog.onrender.com";
const CLOUDFLARE_WATCHDOG_URL = "https://instabox-third-watchdog.null0null0xyz.workers.dev/healthz";
const tickets = new Map<string, { session: string; expiresAt: number }>();

function config() {
  return {
    base: (process.env.CONTROL_PLANE_URL || "").replace(/\/+$/, ""),
    token: process.env.CONTROL_PLANE_TOKEN || "",
  };
}

async function requireUser(req: Request, res: Response): Promise<boolean> {
  try {
    await sdk.authenticateRequest(req);
    const { base, token } = config();
    if (!base || !token) {
      res.status(503).json({ ok: false, error: "control_plane_not_configured" });
      return false;
    }
    return true;
  } catch {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
}

function upstreamUrl(path: string) {
  const { base } = config();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

async function upstream(path: string, init: RequestInit = {}) {
  const { token } = config();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  return fetch(upstreamUrl(path), { ...init, headers });
}

async function relayJson(response: globalThis.Response, res: Response) {
  const text = await response.text();
  res.status(response.status);
  res.type("application/json");
  res.send(text || JSON.stringify({ ok: response.ok }));
}

async function forwardJson(req: Request, res: Response, path: string, method: string) {
  if (!(await requireUser(req, res))) return;
  const body = method === "GET" || method === "HEAD" ? undefined : JSON.stringify(req.body ?? {});
  const response = await upstream(path, {
    method,
    body,
    headers: body ? { "Content-Type": "application/json" } : undefined,
  });
  await relayJson(response, res);
}

function cleanPath(value: unknown) {
  return typeof value === "string" ? value.replace(/^\/+/, "") : "";
}

export function registerControlProxy(app: Express, server: import("node:http").Server) {
  app.get("/api/control/status", (req, res) => forwardJson(req, res, "/v1/status", "GET").catch(() => res.status(502).json({ ok: false, error: "control_plane_unreachable" })));
  app.get("/api/control/models", (req, res) => forwardJson(req, res, "/v1/models", "GET").catch(() => res.status(502).json({ ok: false, error: "control_plane_unreachable" })));
  app.post("/api/control/models/select", (req, res) => forwardJson(req, res, "/v1/models/select", "POST").catch(() => res.status(502).json({ ok: false, error: "control_plane_unreachable" })));
  app.post("/api/control/claude/start", (req, res) => forwardJson(req, res, "/v1/claude/start", "POST").catch(() => res.status(502).json({ ok: false, error: "control_plane_unreachable" })));
  app.post("/api/control/claude/message", (req, res) => forwardJson(req, res, "/v1/claude/message", "POST").catch(() => res.status(502).json({ ok: false, error: "control_plane_unreachable" })));
  app.get("/api/control/claude/commands", async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    let native: globalThis.Response | null = null;
    try {
      native = await upstream(`/v1/claude/commands?q=${encodeURIComponent(query)}`, { method: "GET" });
    } catch {
      native = null;
    }
    if (native && native.status !== 404) {
      await relayJson(native, res);
      return;
    }

    // Older Control Plane versions do not expose a commands endpoint yet.
    // Discover project commands and skills from the live workspace instead of
    // maintaining a stale hard-coded command list in the dashboard.
    const roots = [
      "instabox-24-7-agent/.claude/commands",
      "instabox-24-7-agent/.claude/skills",
    ];
    const commands = new Map<string, { name: string; source: string }>();
    for (const root of roots) {
      try {
        const response = await upstream(`/v1/files?path=${encodeURIComponent(root)}`, { method: "GET" });
        if (!response.ok) continue;
        const payload = await response.json() as { entries?: Array<{ name?: string; type?: string }> };
        for (const entry of payload.entries || []) {
          if (!entry.name || !entry.type) continue;
          const base = entry.name.replace(/\.md$/i, "");
          if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(base)) continue;
          if (root.endsWith("/commands") && entry.type !== "file") continue;
          if (root.endsWith("/skills") && entry.type !== "directory") continue;
          const command = `/${base}`;
          if (!query || command.toLowerCase().includes(query) || base.toLowerCase().includes(query)) {
            commands.set(command, { name: command, source: root.endsWith("/skills") ? "skill" : "project" });
          }
        }
      } catch {
        // A missing optional discovery directory should not break messaging.
      }
    }
    res.json({ ok: true, commands: Array.from(commands.values()).sort((a, b) => a.name.localeCompare(b.name)) });
  });
  app.get("/api/control/claude/output", (req, res) => {
    const session = encodeURIComponent(String(req.query.session || "claude"));
    const lines = encodeURIComponent(String(req.query.lines || "240"));
    return forwardJson(req, res, `/v1/claude/output?session=${session}&lines=${lines}`, "GET").catch(() => res.status(502).json({ ok: false, error: "control_plane_unreachable" }));
  });
  app.post("/api/control/command", (req, res) => forwardJson(req, res, "/v1/command", "POST").catch(() => res.status(502).json({ ok: false, error: "control_plane_unreachable" })));
  app.post("/api/control/sessions", (req, res) => forwardJson(req, res, "/v1/sessions", "POST").catch(() => res.status(502).json({ ok: false, error: "control_plane_unreachable" })));

  app.get("/api/control/files", (req, res) => {
    const path = encodeURIComponent(cleanPath(req.query.path));
    return forwardJson(req, res, `/v1/files?path=${path}`, "GET").catch(() => res.status(502).json({ ok: false, error: "control_plane_unreachable" }));
  });

  app.post("/api/control/files/upload", async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const path = cleanPath(req.query.path || req.headers["x-file-path"]);
    if (!path || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ ok: false, error: "multipart_file_required" });
      return;
    }
    const response = await upstream(`/v1/files/upload`, {
      method: "POST",
      body: new Uint8Array(req.body as Buffer),
      headers: {
        "Content-Type": String(req.headers["content-type"] || "application/octet-stream"),
        "Content-Length": String(req.body.length),
        "X-File-Path": path,
      },
    });
    await relayJson(response, res);
  });

  app.get("/api/control/files/download", async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const path = cleanPath(req.query.path);
    if (!path) {
      res.status(400).json({ ok: false, error: "file_path_required" });
      return;
    }
    const response = await upstream(`/v1/files/download?path=${encodeURIComponent(path)}`, { method: "GET" });
    const data = Buffer.from(await response.arrayBuffer());
    res.status(response.status);
    const contentType = response.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    const disposition = response.headers.get("content-disposition");
    if (disposition) res.setHeader("Content-Disposition", disposition);
    res.send(data);
  });

  app.get("/api/control/infrastructure", async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const checks = await Promise.all([
      fetch(RENDER_WATCHDOG_URL + "/healthz", { signal: AbortSignal.timeout(8000) }).then(r => ({ name: "Render watchdog", ok: r.ok, detail: r.ok ? "reachable" : `HTTP ${r.status}` })).catch(() => ({ name: "Render watchdog", ok: false, detail: "unreachable" })),
      fetch(CLOUDFLARE_WATCHDOG_URL, { signal: AbortSignal.timeout(8000) }).then(r => ({ name: "Cloudflare watchdog", ok: r.ok, detail: r.ok ? "reachable" : `HTTP ${r.status}` })).catch(() => ({ name: "Cloudflare watchdog", ok: false, detail: "unreachable" })),
    ]);
    res.json({ ok: true, checks });
  });

  app.post("/api/control/ws-ticket", async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const session = String(req.body?.session || "terminal");
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(session)) {
      res.status(400).json({ ok: false, error: "invalid_session" });
      return;
    }
    const ticket = randomBytes(24).toString("hex");
    tickets.set(ticket, { session, expiresAt: Date.now() + 60_000 });
    res.json({ ok: true, ticket, session });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.url || "";
    if (!origin.startsWith("/api/control/sessions/") || !origin.includes("/ws")) return;
    const url = new URL(origin, "http://control.local");
    const match = url.pathname.match(/^\/api\/control\/sessions\/([^/]+)\/ws$/);
    const ticket = url.searchParams.get("ticket") || "";
    const session = match ? decodeURIComponent(match[1]) : "";
    const ticketData = tickets.get(ticket);
    tickets.delete(ticket);
    if (!ticketData || ticketData.expiresAt < Date.now() || ticketData.session !== session) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, client => {
      const { base, token } = config();
      const wsBase = base.replace(/^http/, "ws");
      const upstreamSocket = new WebSocket(`${wsBase}/v1/sessions/${encodeURIComponent(session)}/ws?token=${encodeURIComponent(token)}`);
      const buffered: WebSocket.RawData[] = [];
      client.on("message", data => {
        if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(data);
        else buffered.push(data);
      });
      upstreamSocket.on("open", () => {
        for (const data of buffered) upstreamSocket.send(data);
        buffered.length = 0;
      });
      upstreamSocket.on("message", data => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      });
      upstreamSocket.on("close", (code, reason) => {
        if (client.readyState === WebSocket.OPEN) client.close(code, reason);
      });
      client.on("close", () => upstreamSocket.close());
      client.on("error", () => upstreamSocket.close());
      upstreamSocket.on("error", () => client.close(1011, "upstream error"));
    });
  });
}
