import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import * as db from "./db";

const scrypt = promisify(scryptCallback);
const HASH_PREFIX = "scrypt";
const KEY_LENGTH = 64;

export function normalizeUsername(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${HASH_PREFIX}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [prefix, saltHex, hashHex] = stored.split("$");
  if (prefix !== HASH_PREFIX || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = (await scrypt(password, Buffer.from(saltHex, "hex"), expected.length)) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function getLocalUser(username: string) {
  const normalized = normalizeUsername(username);
  const databaseUser = await db.getUserByUsername(normalized);
  if (databaseUser) return databaseUser;
  if (normalized && normalized === normalizeUsername(process.env.LOCAL_AUTH_USERNAME) && process.env.LOCAL_AUTH_PASSWORD_HASH) {
    const now = new Date();
    return {
      id: 0,
      openId: `local:${normalized}`,
      username: normalized,
      passwordHash: process.env.LOCAL_AUTH_PASSWORD_HASH,
      name: process.env.LOCAL_AUTH_DISPLAY_NAME || normalized,
      email: null,
      loginMethod: "password",
      role: "admin" as const,
      createdAt: now,
      updatedAt: now,
      lastSignedIn: now,
    };
  }
  return undefined;
}

export async function authenticateLocalUser(username: string, password: string) {
  const user = await getLocalUser(username);
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) return null;
  await db.touchUser(user.openId);
  return user;
}
