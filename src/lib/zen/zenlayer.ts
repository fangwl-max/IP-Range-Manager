import crypto from "crypto";

const HOST = "console.zenlayer.com";
const CONTENT_TYPE = "application/json; charset=utf-8";
export const ZEC_URL = "https://console.zenlayer.com/api/v2/zec";
export const BMC_URL = "https://console.zenlayer.com/api/v2/bmc";
export const TRAFFIC_URL = "https://console.zenlayer.com/api/v2/traffic";

function sha256HexLower(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex").toLowerCase();
}

function buildAuthorization(
  accessKeyId: string,
  secret: string,
  body: string,
  timestamp: number
): string {
  const payloadHash = sha256HexLower(body);
  const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${HOST}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const hashedCanonical = sha256HexLower(canonicalRequest);
  const stringToSign = `ZC2-HMAC-SHA256\n${timestamp}\n${hashedCanonical}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(stringToSign)
    .digest("hex")
    .toLowerCase();
  return `ZC2-HMAC-SHA256 Credential=${accessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function unwrapResponse(data: Record<string, unknown>): Record<string, unknown> {
  const inner = data.response;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    let o = inner as Record<string, unknown>;
    if (o.data_set != null && o.dataSet == null) {
      o = { ...o, dataSet: o.data_set };
    }
    if (o.total_count != null && o.totalCount == null) {
      o = { ...o, totalCount: o.total_count };
    }
    return o;
  }
  return data;
}

export async function signedPost(
  url: string,
  action: string,
  payload: Record<string, unknown>,
  accessKeyId: string,
  secret: string,
  apiVersion: string,
  timeoutMs = 120000
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const auth = buildAuthorization(accessKeyId, secret, body, ts);
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": CONTENT_TYPE,
          // ??????Host?? URL ?????????????? Host ????????????host:console.zenlayer.com
          Authorization: auth,
          "X-ZC-Action": action,
          "X-ZC-Timestamp": String(ts),
          "X-ZC-Version": apiVersion,
          "X-ZC-Signature-Method": "ZC2-HMAC-SHA256",
        },
        body,
        signal: ac.signal,
      });
    } catch (e) {
      const aborted =
        e instanceof Error &&
        (e.name === "AbortError" ||
          (e as Error & { cause?: { code?: string } }).cause?.code === "ABORT_ERR");
      if (aborted) {
        throw new Error(
          `Zenlayer ???????? (${action})???? ${timeoutMs}ms?????????? CLI ???????? maxDuration`
        );
      }
      throw e;
    }
  } finally {
    clearTimeout(tid);
  }
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Zenlayer??JSON ?? (${action}): ${text.slice(0, 400)}`);
  }
  if (!res.ok) {
    throw new Error(`Zenlayer HTTP ${res.status} (${action}): ${text.slice(0, 800)}`);
  }
  if (data.code) {
    throw new Error(
      `Zenlayer ???? (${action}): ${String(data.code)} ${String(data.message ?? "")}`
    );
  }
  return data;
}

/**
 * ?? CreateEips ????eipIds???????? amount?Zenlayer ??????????????? * @param requestedAmount ???? amount ???????????????? */
export function parseCreateEipsReturnedIds(
  data: Record<string, unknown>,
  requestedAmount: number
): string[] {
  const inner = unwrapResponse(data);
  const raw = inner.eipIds;
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new Error(
      `CreateEips ???? eipIds?????????????response=${JSON.stringify(inner).slice(0, 900)}`
    );
  }
  if (raw.length > requestedAmount) {
    throw new Error(
      `CreateEips ?? eipIds ??=${raw.length}??????amount=${requestedAmount}?response=${JSON.stringify(inner).slice(0, 900)}`
    );
  }
  return raw.map(String);
}

/**
 * CreateEips ????response ????eipIds?????? amount ???????????? */
export function assertCreateEipsReturnedIds(
  data: Record<string, unknown>,
  expectedAmount?: number
): string[] {
  if (expectedAmount === undefined || !Number.isFinite(expectedAmount)) {
    const inner = unwrapResponse(data);
    const raw = inner.eipIds;
    if (!Array.isArray(raw) || raw.length < 1) {
      throw new Error(
        `CreateEips ???? eipIds?????????????response=${JSON.stringify(inner).slice(0, 900)}`
      );
    }
    return raw.map(String);
  }
  const ids = parseCreateEipsReturnedIds(data, expectedAmount);
  if (ids.length !== expectedAmount) {
    throw new Error(
      `CreateEips ?? eipIds ??=${ids.length}?? amount=${expectedAmount} ????response=${JSON.stringify(unwrapResponse(data)).slice(0, 900)}`
    );
  }
  return ids;
}

export async function zecCall(
  action: string,
  payload: Record<string, unknown>,
  accessKeyId: string,
  secret: string,
  apiVersion: string,
  timeoutMs?: number
) {
  return signedPost(ZEC_URL, action, payload, accessKeyId, secret, apiVersion, timeoutMs);
}

export async function bmcCall(
  action: string,
  payload: Record<string, unknown>,
  accessKeyId: string,
  secret: string,
  apiVersion: string,
  timeoutMs?: number
) {
  return signedPost(BMC_URL, action, payload, accessKeyId, secret, apiVersion, timeoutMs);
}

export async function trafficCall(
  action: string,
  payload: Record<string, unknown>,
  accessKeyId: string,
  secret: string,
  apiVersion: string,
  timeoutMs?: number
) {
  return signedPost(
    TRAFFIC_URL,
    action,
    payload,
    accessKeyId,
    secret,
    apiVersion,
    timeoutMs
  );
}
