import {
  ZuploContext,
  ZuploRequest,
  HttpProblems,
  environment,
} from "@zuplo/runtime";

type EdgegridSigningOptions = {
  // The upstream API path prefix (e.g. "/ccu/v3" or "/papi/v1") that
  // urlForwardHandler's baseUrl will prepend to this route's path a moment
  // after this policy runs. The signature must cover the path Akamai will
  // actually receive, so this must stay in sync with each route's baseUrl.
  apiPathPrefix: string;
};

const REQUIRED_ENV_VARS = [
  "EDGERC_CLIENT_TOKEN",
  "EDGERC_CLIENT_SECRET",
  "EDGERC_ACCESS_TOKEN",
  "EDGERC_HOST",
] as const;

// Most EdgeGrid client implementations cap the hashed request-body prefix at
// 128KB. Verify this against Akamai's current "Authenticate with EdgeGrid"
// tech docs before relying on it for large purge-object-list bodies.
const MAX_BODY_HASH_BYTES = 131072;

function readRequiredEnv():
  | { ok: true; values: Record<(typeof REQUIRED_ENV_VARS)[number], string> }
  | { ok: false; missing: string } {
  const values = {} as Record<(typeof REQUIRED_ENV_VARS)[number], string>;
  for (const name of REQUIRED_ENV_VARS) {
    const value = environment[name];
    if (!value) {
      return { ok: false, missing: name };
    }
    values[name] = value;
  }
  return { ok: true, values };
}

function formatEdgeGridTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${y}${mo}${d}T${h}:${mi}:${s}+0000`;
}

function toBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

async function hmacSha256(
  keyData: BufferSource,
  message: string,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return toBase64(digest);
}

export default async function edgegridSigningInbound(
  request: ZuploRequest,
  context: ZuploContext,
  options: EdgegridSigningOptions,
  policyName: string,
): Promise<ZuploRequest | Response> {
  const env = readRequiredEnv();
  if (!env.ok) {
    context.log.error(
      `${policyName}: missing required environment variable ${env.missing}`,
    );
    return HttpProblems.internalServerError(request, context, {
      detail: `EdgeGrid credentials not configured: missing ${env.missing}`,
    });
  }
  const { EDGERC_CLIENT_TOKEN, EDGERC_CLIENT_SECRET, EDGERC_ACCESS_TOKEN, EDGERC_HOST } =
    env.values;

  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const signedPath = `${options.apiPathPrefix}${url.pathname}${url.search}`;

    const timestamp = formatEdgeGridTimestamp(new Date());
    const nonce = crypto.randomUUID();

    const hasBody = method !== "GET" && method !== "HEAD";
    let bodyText = "";
    if (hasBody && request.headers.get("content-length") !== "0") {
      bodyText = await request.text();
    }

    let contentHash = "";
    if (bodyText.length > 0) {
      const hashInput =
        bodyText.length > MAX_BODY_HASH_BYTES
          ? bodyText.slice(0, MAX_BODY_HASH_BYTES)
          : bodyText;
      contentHash = await sha256Base64(hashInput);
    }

    const authDataValue =
      `EG1-HMAC-SHA256 client_token=${EDGERC_CLIENT_TOKEN};` +
      `access_token=${EDGERC_ACCESS_TOKEN};` +
      `timestamp=${timestamp};` +
      `nonce=${nonce};`;

    const headersToSign = "";
    const dataToSign = [
      method,
      "https",
      EDGERC_HOST,
      signedPath,
      headersToSign,
      contentHash,
      authDataValue,
    ].join("\t");

    // The intermediate signing key is used as the *base64 text* of the first
    // HMAC's digest (its UTF-8 bytes), not the raw binary digest - this is
    // easy to get wrong and was the cause of an earlier "signature does not
    // match" failure against the real API.
    const signingKeyBase64 = toBase64(
      await hmacSha256(new TextEncoder().encode(EDGERC_CLIENT_SECRET), timestamp),
    );
    const signature = toBase64(
      await hmacSha256(new TextEncoder().encode(signingKeyBase64), dataToSign),
    );

    const authorization = `${authDataValue}signature=${signature}`;

    context.log.info(
      `${policyName}: signed ${method} ${signedPath} (nonce=${nonce})`,
    );

    const headers = new Headers(request.headers);
    headers.set("Authorization", authorization);

    return new ZuploRequest(request, {
      headers,
      body: hasBody ? bodyText : undefined,
    });
  } catch (err) {
    context.log.error(`${policyName}: signing failed: ${err}`);
    return HttpProblems.internalServerError(request, context, {
      detail: "Failed to sign request with EdgeGrid credentials.",
    });
  }
}
