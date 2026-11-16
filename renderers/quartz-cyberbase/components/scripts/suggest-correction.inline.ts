import {
  buildCorrectionIntent,
  intentFingerprint,
  parseRetryState,
  retryIdempotencyKey,
  submitCorrectionIntent,
} from "../suggestCorrectionClient"

import { setupSuggestionSelection } from "../suggestCorrectionSelection"
import { setupSuggestionChallenge } from "../suggestCorrectionChallenge"
import type { SuggestionChallenge } from "../suggestCorrectionChallenge"

const FORM_SELECTOR = "form.suggest-correction-form"
const challenges = new WeakMap<HTMLFormElement, SuggestionChallenge>()

function field(form: HTMLFormElement, name: string): HTMLTextAreaElement {
  const element = form.elements.namedItem(name)
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`missing ${name} field`)
  return element
}

function setStatus(form: HTMLFormElement, message: string, state: "idle" | "working" | "success" | "error") {
  const status = form.querySelector<HTMLElement>(".suggest-correction-status")
  if (!status) return
  status.textContent = message
  status.dataset.state = state
}

function retryStorageKey(bindingDigest: string, pageId: string): string {
  return `cyberbaser:suggest-correction:v1:${bindingDigest}:${pageId}`
}

function readRetryState(key: string) {
  try {
    return parseRetryState(sessionStorage.getItem(key))
  } catch {
    return null
  }
}

function writeRetryState(key: string, fingerprint: string, idempotencyKey: string) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ fingerprint, idempotencyKey }))
  } catch {
    // A blocked or full session store must not prevent a single submission.
  }
}

function clearRetryState(key: string) {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // The successful request is authoritative even if browser storage is blocked.
  }
}

async function submitCorrection(event: SubmitEvent) {
  event.preventDefault()
  const form = event.currentTarget
  if (!(form instanceof HTMLFormElement)) return
  const submit = form.querySelector<HTMLButtonElement>("button[type='submit']")
  if (!submit || submit.disabled) return
  const challenge = challenges.get(form)
  const challengeToken = challenge?.response()
  if (challenge && !challengeToken) {
    setStatus(form, "Please complete the human verification before sending.", "error")
    challenge.reset()
    return
  }

  const bindingDigest = form.dataset.bindingDigest ?? ""
  const pageId = form.dataset.pageId ?? ""
  const action = form.dataset.action ?? ""
  const input = {
    bindingDigest,
    pageId,
    quote: field(form, "quote").value,
    prefix: field(form, "prefix").value,
    suffix: field(form, "suffix").value,
    replacement: field(form, "replacement").value,
    rationale: field(form, "rationale").value,
    evidenceText: field(form, "evidence").value,
  }
  const fingerprint = intentFingerprint(input)
  const storageKey = retryStorageKey(bindingDigest, pageId)
  const entropy = crypto.getRandomValues(new Uint8Array(32))
  const idempotencyKey = retryIdempotencyKey(fingerprint, readRetryState(storageKey), entropy)

  let intent
  try {
    intent = buildCorrectionIntent({ ...input, idempotencyKey })
  } catch (error) {
    setStatus(form, error instanceof Error ? error.message : "The correction form is invalid.", "error")
    challenge?.reset()
    return
  }

  writeRetryState(storageKey, fingerprint, idempotencyKey)
  submit.disabled = true
  challenge?.submitting()
  setStatus(form, "Sending correction for owner review…", "working")
  try {
    const result = await submitCorrectionIntent(action, intent, fetch, challengeToken)
    if (result.accepted) {
      clearRetryState(storageKey)
      form.reset()
      setStatus(form, result.message, "success")
    } else {
      setStatus(form, result.message, "error")
    }
  } catch {
    setStatus(form, "The correction could not be submitted. Retry to send the same request safely.", "error")
  } finally {
    if (challenge) challenge.reset()
    else submit.disabled = false
  }
}

document.addEventListener("nav", () => {
  for (const form of document.querySelectorAll<HTMLFormElement>(FORM_SELECTOR)) {
    form.addEventListener("submit", submitCorrection)
    const cleanupSelection = setupSuggestionSelection(form)
    const submit = form.querySelector<HTMLButtonElement>("button[type='submit']")
    if (submit) {
      const challenge = setupSuggestionChallenge(form, submit, (message, state) => setStatus(form, message, state))
      if (challenge) challenges.set(form, challenge)
      else submit.disabled = false
    }
    window.addCleanup(() => {
      form.removeEventListener("submit", submitCorrection)
      cleanupSelection()
      challenges.get(form)?.destroy()
      challenges.delete(form)
    })
  }
})
