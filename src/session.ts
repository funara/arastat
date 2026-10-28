import { watch } from 'vue'
import { clearHistory, state } from './store.ts'
import { runsState } from './results.ts'

/** Reset related session state after a confirmed replacement. */
export function resetDatasetSession(): void {
  clearHistory()
  state.computedFormulas = []
  runsState.runs = []
  state.sessionVersion++
}

/** Keep restored project contents but discard undo events from the previous session. */
export function resetProjectHistory(): void {
  clearHistory()
  state.sessionVersion++
}

/** Only explicit session replacement, not undoable dataset edits, resets workflows. */
export function watchDatasetSession(onReplace: () => void): () => void {
  return watch(() => state.sessionVersion, onReplace)
}
