/**
 * TEE auth token flow (same protocol as `getAuthToken` in
 * @magicblock-labs/ephemeral-rollups-sdk): fetch a challenge for the pubkey,
 * sign it, post it to /auth/login, receive a bearer token used as `?token=`.
 * Reimplemented here so browser bundles do not pull in the whole MagicBlock SDK.
 */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) out += "1";
  for (let q = digits.length - 1; q >= 0; q--) out += ALPHABET[digits[q]];
  return out;
}

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export interface AuthToken {
  token: string;
  expiresAt: number;
}

export async function getAuthToken(teeUrl: string, pubkey: string, sign: SignMessage, fetchImpl: typeof fetch = fetch): Promise<AuthToken> {
  const base = teeUrl.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/auth/challenge?${new URLSearchParams({ pubkey })}`);
  const body = (await res.json()) as { challenge?: string; error?: string };
  if (body.error) throw new Error(`challenge failed: ${body.error}`);
  if (!body.challenge) throw new Error("no challenge received");
  const signature = await sign(new TextEncoder().encode(body.challenge));
  const login = await fetchImpl(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, challenge: body.challenge, signature: base58Encode(signature) }),
  });
  const json = (await login.json()) as { token?: string; expiresAt?: number; error?: string };
  if (login.status !== 200) throw new Error(`login failed: ${json.error ?? login.status}`);
  if (!json.token) throw new Error("no token received");
  return { token: json.token, expiresAt: json.expiresAt ?? Date.now() + 30 * 24 * 3600 * 1000 };
}

/** RPC URL carrying a token. */
export const tokenUrl = (teeUrl: string, token: string) => `${teeUrl.replace(/\/+$/, "")}?token=${encodeURIComponent(token)}`;

/** Show a token-bearing URL without leaking the token: `...?token=…a3f9`. */
export function redactToken(url: string): string {
  return url.replace(/token=([^&]+)/, (_m, t: string) => `token=…${decodeURIComponent(t).slice(-4)}`);
}
