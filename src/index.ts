/**
 * opencode-sub-worker
 *
 * Turns a markdown task checklist into a dependency- and file-conflict-aware
 * schedule, runs ready tasks in parallel as isolated child sessions each in
 * its own git worktree, coordinates through an orchestrator-mediated mailbox,
 * and gates every task with a verification command.
 */

import { PLUGIN_ID } from "./core/constants.ts"
import { setupV2 } from "./v2/plugin.ts"

const subWorkerPlugin = {
  id: PLUGIN_ID,
  setup: setupV2,
}

export default subWorkerPlugin
export { setupV2 }
export * from "./core/index.ts"
