import { resolveOwnerOrigin } from "./editLink"
import { submitSuggestionIntent } from "./suggestModeClient"
import type { SuggestionIntent } from "./suggestModeClient"
import type { SourceIdentity } from "./suggestModeModel"

/** Finish providers own transport and labels, never source mapping or authority.
 * Owner handoff stages only. The separate owner-origin CSRF Save authorizes it. */
export interface FinishAction {
  label: "Send" | "Save"
  reviewLabel: string
  needsChallenge: boolean
  rawHref?: string
  submit(intent: SuggestionIntent, token?: string): Promise<{ accepted: boolean; message: string; navigating?: boolean }>
}
export function createFinishAction(form: HTMLFormElement, source: SourceIdentity): FinishAction {
  const ownerLink = document.querySelector<HTMLAnchorElement>(".edit-this-page a[href*='/owner/in-place?']")
  if (location.hash === "#owner-edit" && ownerLink) {
    const target = new URL(ownerLink.href)
    resolveOwnerOrigin(target.origin)
    if (target.searchParams.get("relativePath") !== source.path || target.searchParams.get("slug") !== form.dataset.pageSlug) throw Error("Owner page identity differs.")
    const raw = new URL(target); raw.pathname = "/owner/edit"
    return {
      label: "Save", reviewLabel: "Continue to Save", needsChallenge: false, rawHref: raw.href,
      async submit(intent) {
        const handoff = document.createElement("form")
        handoff.method = "POST"; handoff.action = `${target.origin}/owner/stage`; handoff.hidden = true
        const field = document.createElement("input"); field.name = "changeSet"
        field.value = JSON.stringify({ source, revision: form.dataset.sourceRevision, slug: form.dataset.pageSlug, operations: intent.operations })
        handoff.append(field); document.body.append(handoff)
        // A top-level navigation, not credentialed cross-origin fetch. The
        // destination stages only, then authenticates and renders its own review.
        handoff.submit()
        return { accepted: false, navigating: true, message: "Opening owner Save…" }
      },
    }
  }
  return {
    label: "Send", reviewLabel: "Send suggestion", needsChallenge: true,
    submit(intent, token) {
      const action = new URL(form.dataset.action!); action.pathname = "/v2/suggestions"
      return submitSuggestionIntent(action.href, intent, fetch, token)
    },
  }
}
