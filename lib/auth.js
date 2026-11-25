// Password hashing (scrypt, built into Node) and random tokens. No third-party crypto.
import crypto from "node:crypto";

const scrypt = (pw, salt, N) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, 64, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, key) => e ? reject(e) : resolve(key)));

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16), N = 16384;
  const key = await scrypt(pw, salt, N);
  return `scrypt$${N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// Compared against when the email doesn't exist, so response time doesn't reveal which accounts exist.
const DUMMY = "scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

export async function checkPassword(pw, stored) {
  try {
    const [alg, N, salt, hash] = (stored || DUMMY).split("$");
    if (alg !== "scrypt") return false;
    const key = await scrypt(String(pw), Buffer.from(salt, "base64"), Number(N));
    const want = Buffer.from(hash, "base64");
    return want.length === key.length && crypto.timingSafeEqual(want, key) && !!stored;
  } catch { return false; }
}

export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const sha256 = t => crypto.createHash("sha256").update(String(t)).digest("hex");
