import { DEFAULT_CHALLENGE_PROVIDER, getChallengeProvider } from "./challenge/registry"
import type { ChallengeWidget } from "./challenge/registry"

const UNAVAILABLE = "Verification is temporarily unavailable. Please try again later."
const loading = new Map<string, Promise<void>>()

/** Core loads each provider's constant script once, including across SPA pages. */
function loadChallengeScript(scriptUrl: string): Promise<void> {
  const pending = loading.get(scriptUrl)
  if (pending) return pending
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = scriptUrl
    script.async = true
    script.defer = true
    const finish = (error = false) => {
      clearTimeout(timer)
      script.onload = null
      script.onerror = null
      if (!error) resolve()
      else {
        script.remove()
        reject(new Error(UNAVAILABLE))
      }
    }
    const timer = setTimeout(() => finish(true), 15_000)
    script.onload = () => finish()
    script.onerror = () => finish(true)
    document.head.appendChild(script)
  }).catch((error) => {
    loading.delete(scriptUrl)
    throw error
  })
  loading.set(scriptUrl, promise)
  return promise
}

export interface SuggestionChallenge {
  response(): string
  submitting(): void
  reset(): void
  destroy(): void
}

/** No container means no loader, widget, token, or behavior change. */
export function setupSuggestionChallenge(
  form: HTMLFormElement,
  submit: HTMLButtonElement,
  status: (message: string, state: "idle" | "error") => void,
): SuggestionChallenge | undefined {
  const container = form.querySelector<HTMLElement>(".suggest-correction-challenge")
  if (!container) return undefined
  const provider = getChallengeProvider(container.dataset.provider ?? DEFAULT_CHALLENGE_PROVIDER)
  const siteKey = container.dataset.sitekey ?? ""
  let widget: ChallengeWidget | undefined
  let token = ""
  let destroyed = false
  let busy = false
  let verificationStatus = true
  const unavailable = () => {
    token = ""
    verificationStatus = true
    submit.disabled = true
    status(UNAVAILABLE, "error")
  }
  submit.disabled = true
  status("Please complete the human verification before sending.", "idle")
  if (!provider || !provider.validateSiteKey(siteKey)) unavailable()
  else void loadChallengeScript(provider.scriptUrl).then(() => {
    if (destroyed) return
    widget = provider.mount(container, {
      siteKey,
      action: "suggest-correction",
      onToken: (value) => {
        if (destroyed) return
        token = typeof value === "string" && value.length <= 2048 && /^\S+$/u.test(value) && !/[\x00-\x1f\x7f]/u.test(value)
          ? value : ""
        submit.disabled = busy || token === ""
        if (!busy && token !== "" && verificationStatus) status("", "idle")
      },
      onExpire: () => {
        if (destroyed) return
        token = ""
        verificationStatus = true
        submit.disabled = true
        status("Verification expired. Please verify again.", "error")
      },
      onError: () => {
        if (destroyed) return
        unavailable()
      },
    })
  }).catch(() => {
    if (!destroyed) unavailable()
  })
  return {
    response() {
      return destroyed ? "" : token
    },
    submitting() {
      busy = true
      verificationStatus = false
      submit.disabled = true
    },
    reset() {
      busy = false
      token = ""
      // A fresh token must not erase the submission's receipt or error message.
      verificationStatus = false
      submit.disabled = true
      if (!widget || destroyed) return
      try {
        widget.reset()
      } catch {
        unavailable()
      }
    },
    destroy() {
      destroyed = true
      token = ""
      if (widget) {
        try {
          widget.remove()
        } catch {
          // A stale widget must not interrupt Quartz's remaining SPA cleanup.
        }
      }
    },
  }
}
