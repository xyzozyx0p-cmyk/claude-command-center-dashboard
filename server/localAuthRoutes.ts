import type { Express, Request, Response } from "express";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { authenticateLocalUser, normalizeUsername } from "./localAuth";

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

function clientKey(req: Request) {
  return `${req.ip}:${normalizeUsername(req.body?.username)}`;
}

function isRateLimited(key: string) {
  const current = attempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    attempts.delete(key);
    return false;
  }
  return current.count >= MAX_ATTEMPTS;
}

function noteFailure(key: string) {
  const current = attempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
  } else {
    current.count += 1;
  }
}

export function registerLocalAuthRoutes(app: Express) {
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const key = clientKey(req);
    if (isRateLimited(key)) {
      res.status(429).json({ ok: false, error: "Слишком много попыток. Повторите через 15 минут." });
      return;
    }

    const username = normalizeUsername(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username) || password.length < 12) {
      noteFailure(key);
      res.status(401).json({ ok: false, error: "Неверный логин или пароль" });
      return;
    }

    const user = await authenticateLocalUser(username, password);
    if (!user) {
      noteFailure(key);
      res.status(401).json({ ok: false, error: "Неверный логин или пароль" });
      return;
    }

    attempts.delete(key);
    const token = await sdk.createSessionToken(user.openId, { name: user.name || username, expiresInMs: ONE_YEAR_MS });
    res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });
    res.json({ ok: true, user: { username, name: user.name || username } });
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(req), maxAge: -1 });
    res.json({ ok: true });
  });
}
