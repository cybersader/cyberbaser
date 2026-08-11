const ACCOUNT_FREE_INTENT_ARTIFACT_TYPE = "cyberbaser-account-free-correction-intent" as const
const ACCOUNT_FREE_INTENT_SCHEMA_VERSION = 1 as const
const INTENT_MAX_BYTES = 96 * 1024
const RESPONSE_MAX_BYTES = 16 * 1024
const QUOTE_MAX_BYTES = 16 * 1024
const REPLACEMENT_MAX_BYTES = 16 * 1024
const CONTEXT_MAX_BYTES = 4 * 1024
const RATIONALE_MAX_BYTES = 16 * 1024
const MAX_EVIDENCE = 8
const MAX_URL_BYTES = 2 * 1024
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/u
const DIGEST_RE = /^sha-256=:[A-Za-z0-9+/]{43}=:$/u
const PAGE_ID_RE = /^page-v1:[A-Za-z0-9_-]{43}$/u

export interface CorrectionIntentInput {
  bindingDigest: string
  pageId: string
  quote: string
  prefix: string
  suffix: string
  replacement: string
  rationale: string
  evidenceText: string
  idempotencyKey: string
}

export interface CorrectionIntent {
  schemaVersion: 1
  artifactType: "cyberbaser-account-free-correction-intent"
  bindingDigest: string
  pageId: string
  selection: {
    quote: string
    prefix: string | null
    suffix: string | null
  }
  replacement: string
  rationale: string
  evidence: string[]
  idempotencyKey: string
}

export interface RetryState {
  fingerprint: string
  idempotencyKey: string
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function bounded(value: string, label: string, maximum: number, nonEmpty = true): string {
  if (nonEmpty && value.length === 0) throw new Error(`${label} must not be empty`)
  if (byteLength(value) > maximum) throw new Error(`${label} exceeds ${maximum} UTF-8 bytes`)
  return value
}

function canonicalEvidenceUrl(value: string): string {
  bounded(value, "evidence URL", MAX_URL_BYTES)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("evidence URLs must be canonical credential-free HTTPS URLs")
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hostname.endsWith(".")
    || url.toString() !== value
  ) {
    throw new Error("evidence URLs must be canonical credential-free HTTPS URLs")
  }
  if (/%(?![0-9A-Fa-f]{2})/u.test(value)) {
    throw new Error("evidence URLs must use canonical percent encoding")
  }
  for (const match of value.matchAll(/%([0-9A-Fa-f]{2})/gu)) {
    const hex = match[1]
    const character = String.fromCharCode(Number.parseInt(hex, 16))
    if (hex !== hex.toUpperCase() || /[A-Za-z0-9._~-]/u.test(character)) {
      throw new Error("evidence URLs must use canonical percent encoding")
    }
  }
  return value
}

export function parseEvidenceUrls(value: string): string[] {
  const urls = value.split("\n").map((line) => line.trim()).filter(Boolean)
  if (urls.length > MAX_EVIDENCE) throw new Error(`evidence must contain at most ${MAX_EVIDENCE} URLs`)
  const normalized = urls.map(canonicalEvidenceUrl)
  if (new Set(normalized).size !== normalized.length) throw new Error("evidence must not contain duplicate URLs")
  return normalized
}

export function buildCorrectionIntent(input: CorrectionIntentInput): CorrectionIntent {
  if (!DIGEST_RE.test(input.bindingDigest)) throw new Error("publication binding is invalid")
  if (!PAGE_ID_RE.test(input.pageId)) throw new Error("page identity is invalid")
  if (!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) throw new Error("idempotency key is invalid")
  const rationale = bounded(input.rationale, "rationale", RATIONALE_MAX_BYTES)
  if (rationale.includes("\r") || rationale.trim().length === 0) {
    throw new Error("rationale must contain non-whitespace text using LF line endings")
  }
  const intent: CorrectionIntent = {
    schemaVersion: ACCOUNT_FREE_INTENT_SCHEMA_VERSION,
    artifactType: ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
    bindingDigest: input.bindingDigest,
    pageId: input.pageId,
    selection: {
      quote: bounded(input.quote, "selected text", QUOTE_MAX_BYTES),
      prefix: input.prefix === "" ? null : bounded(input.prefix, "context before", CONTEXT_MAX_BYTES, false),
      suffix: input.suffix === "" ? null : bounded(input.suffix, "context after", CONTEXT_MAX_BYTES, false),
    },
    replacement: bounded(input.replacement, "replacement", REPLACEMENT_MAX_BYTES, false),
    rationale,
    evidence: parseEvidenceUrls(input.evidenceText),
    idempotencyKey: input.idempotencyKey,
  }
  if (byteLength(serializeCorrectionIntent(intent)) > INTENT_MAX_BYTES) {
    throw new Error(`correction intent exceeds ${INTENT_MAX_BYTES} UTF-8 bytes`)
  }
  return intent
}

export function serializeCorrectionIntent(intent: CorrectionIntent): string {
  return `${JSON.stringify(intent)}\n`
}

export function intentFingerprint(input: Omit<CorrectionIntentInput, "idempotencyKey">): string {
  return JSON.stringify({
    bindingDigest: input.bindingDigest,
    pageId: input.pageId,
    quote: input.quote,
    prefix: input.prefix,
    suffix: input.suffix,
    replacement: input.replacement,
    rationale: input.rationale,
    evidenceText: input.evidenceText,
  })
}

export function idempotencyKeyFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error("idempotency key entropy must be exactly 32 bytes")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")
}

export function parseRetryState(value: string | null): RetryState | null {
  if (value === null) return null
  try {
    const parsed = JSON.parse(value) as Partial<RetryState>
    if (
      typeof parsed.fingerprint !== "string"
      || typeof parsed.idempotencyKey !== "string"
      || !IDEMPOTENCY_KEY_RE.test(parsed.idempotencyKey)
      || Object.keys(parsed).length !== 2
    ) return null
    return { fingerprint: parsed.fingerprint, idempotencyKey: parsed.idempotencyKey }
  } catch {
    return null
  }
}

export function retryIdempotencyKey(
  fingerprint: string,
  stored: RetryState | null,
  randomBytes: Uint8Array,
): string {
  if (stored?.fingerprint === fingerprint) return stored.idempotencyKey
  return idempotencyKeyFromBytes(randomBytes)
}

export interface SubmissionResult {
  accepted: boolean
  replayed: boolean
  message: string
}

function safeReceiptValue(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null
  if (/[\x00-\x1f\x7f]/u.test(value)) return null
  return value
}

function receiptFields(value: unknown): { status: string | null; queueId: string | null } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: null, queueId: null }
  }
  const top = value as Record<string, unknown>
  const receipt = top.receipt !== null && typeof top.receipt === "object" && !Array.isArray(top.receipt)
    ? top.receipt as Record<string, unknown>
    : top
  return {
    status: safeReceiptValue(receipt.state ?? receipt.status),
    queueId: safeReceiptValue(receipt.queueId),
  }
}

export function errorCodeFromResponse(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const error = (value as Record<string, unknown>).error
  if (error === null || typeof error !== "object" || Array.isArray(error)) return null
  const code = (error as Record<string, unknown>).code
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(code) ? code : null
}

export async function readBoundedJsonResponse(
  response: Response,
  maximum = RESPONSE_MAX_BYTES,
): Promise<unknown | null> {
  const contentType = response.headers.get("content-type") ?? ""
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) return null
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
      throw new Error("response body is too large")
    }
  }
  if (response.body === null) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximum) {
      await reader.cancel()
      throw new Error("response body is too large")
    }
    chunks.push(value)
  }
  if (total === 0) return null
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function submitCorrectionIntent(
  action: string,
  intent: CorrectionIntent,
  fetcher: typeof fetch = fetch,
): Promise<SubmissionResult> {
  const response = await fetcher(action, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: serializeCorrectionIntent(intent),
  })
  let payload: unknown | null = null
  try {
    payload = await readBoundedJsonResponse(response)
  } catch {
    payload = null
  }
  if (response.status === 200 || response.status === 202) {
    const fields = receiptFields(payload)
    const details = [
      fields.status === null ? null : `Status: ${fields.status}.`,
      fields.queueId === null ? null : `Queue ID: ${fields.queueId}.`,
    ].filter((value): value is string => value !== null)
    return {
      accepted: true,
      replayed: response.status === 200,
      message: [response.status === 200 ? "Correction already received." : "Correction received.", ...details].join(" "),
    }
  }
  const code = errorCodeFromResponse(payload)
  return {
    accepted: false,
    replayed: false,
    message: code === null ? "Submission failed. Try again." : `Submission failed (${code}). Try again.`,
  }
}
