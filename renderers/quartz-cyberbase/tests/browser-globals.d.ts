// Quartz supplies this SPA lifecycle API in its own global declarations.
interface Window {
  addCleanup(callback: () => void): void
}
