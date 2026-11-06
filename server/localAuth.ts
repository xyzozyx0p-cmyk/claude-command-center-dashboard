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
  return db.getUserByUsername(normalizeUsername(username));
}

export async function authenticateLocalUser(username: string, password: string) {
  const user = await getLocalUser(username);
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) return null;
  await db.touchUser(user.openId);
  return user;
}
