import {
  buildCorrectionIntent,
  intentFingerprint,
  parseRetryState,
  retryIdempotencyKey,
  submitCorrectionIntent,
} from "../suggestCorrectionClient"
import { setupEditEntryScroll } from "../editEntryClient"
import { setupSuggestMode } from "../suggestMode"
import { setupSuggestionSelection } from "../suggestCorrectionSelection"
import { setupSuggestionChallenge } from "../suggestCorrectionChallenge"
import type { SuggestionChallenge } from "../suggestCorrectionChallenge"

function field(form: HTMLFormElement, name: string): HTMLInputElement | HTMLTextAreaElement {
  const element = form.elements.namedItem(name)
  if (!(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLInputElement)) throw new Error(`missing ${name} field`)
  return element
}

function setStatus(form: HTMLFormElement, message: string, state: "idle" | "working" | "success" | "error") {
  const status = form.querySelector<HTMLElement>(".suggest-correction-status")
  if (!status) return
  status.textContent = message
  status.dataset.state = state
}

function readRetryState(key: string) {
  try { return parseRetryState(sessionStorage.getItem(key)) } catch { return null }
}
function writeRetryState(key: string, fingerprint: string, idempotencyKey: string) {
  try { sessionStorage.setItem(key, JSON.stringify({ fingerprint, idempotencyKey })) } catch {
    // A blocked session store must not prevent a single submission.
  }
}
function clearRetryState(key: string) {
  try { sessionStorage.removeItem(key) } catch {
    // The successful request remains authoritative.
  }
}

document.addEventListener("nav", async () => {
  window.addCleanup(setupEditEntryScroll())
  for (const form of document.querySelectorAll<HTMLFormElement>("form.suggest-correction-form")) {
    if (form.dataset.sourceIdentity && await setupSuggestMode(form)) continue
    const submit = form.querySelector<HTMLButtonElement>("button[type='submit']")
    if (!submit) continue
    let challenge: SuggestionChallenge | undefined
    let busy = false
    let destroyed = false
    let validChange = false
    const refresh = () => {
      try {
        validChange = editor.change() !== null
        const status = form.querySelector<HTMLElement>(".suggest-correction-status")
        if (status?.dataset.validation === "true") {
          setStatus(form, "", "idle")
          delete status.dataset.validation
        }
      } catch (error) {
        validChange = false
        setStatus(form, error instanceof Error ? error.message : "Try a smaller edit.", "error")
        const status = form.querySelector<HTMLElement>(".suggest-correction-status")
        if (status) status.dataset.validation = "true"
      }
      submit.disabled = !validChange || busy || (challenge !== undefined && !challenge.response())
    }
    const editor = setupSuggestionSelection(form, {
      opened() {
        setStatus(form, "", "idle")
        challenge = setupSuggestionChallenge(form, submit,
          (message, state) => setStatus(form, message, state), () => validChange && !busy && editor.active)
      },
      changed: refresh,
      closed() {
        challenge?.destroy()
        challenge = undefined
        validChange = false
        submit.disabled = true
      },
    })
    const onSubmit = async (event: SubmitEvent) => {
      event.preventDefault()
      if (destroyed || !editor.active || busy) return
      refresh()
      if (!validChange) return
      const challengeToken = challenge?.response()
      if (challenge && !challengeToken) {
        setStatus(form, "Please complete the human verification before sending.", "error")
        challenge.reset()
        return
      }
      const change = editor.change()!
      const bindingDigest = form.dataset.bindingDigest ?? ""
      const pageId = form.dataset.pageId ?? ""
      const input = {
        bindingDigest, pageId, ...change,
        // The strict machine contract requires rationale. Do not force a reader
        // to invent one or change the wire schema when the optional line is blank.
        rationale: field(form, "rationale").value.trim() || "Suggested an edit to this page.",
        evidenceText: field(form, "evidence").value.trim(),
      }
      // Let a reader paste an ordinary URL (for example a bare HTTPS origin),
      // then let the unchanged strict builder enforce HTTPS and credential rules.
      try {
        if (input.evidenceText) input.evidenceText = new URL(input.evidenceText).href
      } catch {
        setStatus(form, "Use an HTTPS source link, or leave it blank.", "error")
        challenge?.reset()
        return
      }
      const fingerprint = intentFingerprint(input)
      const storageKey = `cyberbaser:suggest-correction:v1:${bindingDigest}:${pageId}`
      const idempotencyKey = retryIdempotencyKey(fingerprint, readRetryState(storageKey), crypto.getRandomValues(new Uint8Array(32)))
      let intent
      try { intent = buildCorrectionIntent({ ...input, idempotencyKey }) } catch (error) {
        setStatus(form, error instanceof Error ? error.message : "Please check this edit.", "error")
        challenge?.reset()
        return
      }
      writeRetryState(storageKey, fingerprint, idempotencyKey)
      busy = true
      editor.busy(true)
      submit.disabled = true
      challenge?.submitting()
      setStatus(form, "Sending for owner review…", "working")
      try {
        const result = await submitCorrectionIntent(form.dataset.action ?? "", intent, fetch, challengeToken)
        if (destroyed) return
        if (result.accepted) {
          clearRetryState(storageKey)
          challenge?.reset()
          editor.finish(result.message)
        } else setStatus(form, result.message, "error")
      } catch {
        if (!destroyed) setStatus(form, "The edit could not be submitted. Retry to send the same request safely.", "error")
      } finally {
        busy = false
        if (!destroyed) {
          editor.busy(false)
          challenge?.reset()
          refresh()
        }
      }
    }
    form.addEventListener("submit", onSubmit)
    window.addCleanup(() => {
      destroyed = true
      form.removeEventListener("submit", onSubmit)
      editor.destroy()
    })
  }
})
