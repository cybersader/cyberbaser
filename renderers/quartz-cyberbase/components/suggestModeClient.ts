import { parseEvidenceUrls, submitCorrectionIntent } from "./suggestCorrectionClient"
import { validateOperations, utf8 } from "./suggestModeModel"
import type { Operation } from "./suggestModeModel"
export interface SuggestionIntent {
  schemaVersion: 2
  artifactType: "cyberbaser-account-free-correction-intent"
  bindingDigest: string
  pageId: string
  operations: Operation[]
  rationale?: string
  evidence?: string[]
  idempotencyKey: string
}
export function buildSuggestionIntent(input: { bindingDigest: string; pageId: string; operations: Operation[]; rationale: string; evidenceText: string; idempotencyKey: string }): SuggestionIntent {
  if (!/^sha-256=:[A-Za-z0-9+/]{43}=:$/u.test(input.bindingDigest) || !/^page-v1:[A-Za-z0-9_-]{43}$/u.test(input.pageId) || !/^[A-Za-z0-9_-]{32,128}$/u.test(input.idempotencyKey)) throw Error("Invalid publication identity or retry key.")
  validateOperations(input.operations)
  if (!input.operations.length) throw Error("Make an edit first.")
  const rationale = input.rationale.trim()
  if (utf8(rationale).length > 16384 || rationale.includes("\r")) throw Error("Use a shorter reason with LF line endings.")
  const intent: SuggestionIntent = {
    schemaVersion: 2, artifactType: "cyberbaser-account-free-correction-intent",
    bindingDigest: input.bindingDigest, pageId: input.pageId,
    operations: input.operations.map(({ operationId, start, end, expected, replacement }) => ({ operationId, start, end, expected, replacement })),
    ...(rationale ? { rationale } : {}),
    evidence: parseEvidenceUrls(input.evidenceText), idempotencyKey: input.idempotencyKey,
  }
  if (utf8(JSON.stringify(intent)).length > 262144) throw Error("Suggestions are too large to send.")
  return intent
}
export const submitSuggestionIntent = submitCorrectionIntent
