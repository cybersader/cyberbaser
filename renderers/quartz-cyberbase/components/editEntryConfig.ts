export type EditEntryPlacement = "auto" | "floating" | "inline"
export function resolveEditEntry(value: string | undefined): EditEntryPlacement {
  if (value === undefined) return "auto"
  if (value !== "auto" && value !== "floating" && value !== "inline") throw Error("CYBERBASER_EDIT_ENTRY must be auto, floating, or inline")
  return value
}
