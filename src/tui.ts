/**
 * CLI (TUI) plugin.
 *
 * Adds a "Task force status" palette command and a `/tasks` slash command that
 * read the run status over RPC, and raises an attention notification when a
 * task or a run finishes or fails. It deliberately renders nothing (no JSX, no
 * OpenTUI/solid dependency) so the package stays lightweight.
 */

import { SubWorker } from "./rpc.ts"

interface RpcEvent {
  data: Record<string, unknown>
}

interface RpcClient {
  status(input: { sessionID: string }): Promise<{ json?: string }>
  events: { on(name: string, cb: (event: RpcEvent) => void): () => void }
}

interface CliContext {
  readonly app?: { version?: string }
  readonly client?: { rpc(def: unknown): RpcClient }
  readonly ui?: {
    toast?: { show(input: { title?: string; message: string; variant?: string }): unknown }
    dialog?: { alert?(input: { title?: string; message: string }): Promise<unknown> }
    router?: { current?(): { type?: string; sessionID?: string } }
  }
  readonly attention?: {
    notify(input: {
      title?: string
      message: string
      notification?: { when?: string }
      sound?: { name?: string }
    }): Promise<unknown>
  }
  readonly keymap?: {
    layer(factory: () => unknown): void
  }
}

interface RunSnapshot {
  status?: string
  source?: string
  counts?: Record<string, number>
  tasks?: Array<{ id: string; title: string; status: string }>
}

function currentSessionID(context: CliContext): string | undefined {
  const current = context.ui?.router?.current?.()
  if (current && current.type === "session" && typeof current.sessionID === "string") return current.sessionID
  return undefined
}

function format(snapshot: RunSnapshot): string {
  if (snapshot.status === "none") return "No active task run."
  const counts = snapshot.counts ?? {}
  const tasks = snapshot.tasks ?? []
  const head = `${snapshot.source ?? ""}: ${snapshot.status ?? "?"} — done ${counts.done ?? 0}/${tasks.length}`
  const rows = tasks.map((t) => `  ${t.status.padEnd(9)} ${t.id}  ${t.title}`)
  return [head, ...rows].join("\n")
}

async function showStatus(context: CliContext, rpc: RpcClient): Promise<void> {
  const sessionID = currentSessionID(context)
  if (!sessionID) {
    context.ui?.toast?.show({ message: "open a session to see task status", variant: "warning" })
    return
  }
  const res = await rpc.status({ sessionID })
  let snapshot: RunSnapshot = {}
  try {
    snapshot = JSON.parse(res.json ?? "{}") as RunSnapshot
  } catch {
    snapshot = {}
  }
  const message = format(snapshot)
  if (context.ui?.dialog?.alert) await context.ui.dialog.alert({ title: "Sub-worker", message })
  else context.ui?.toast?.show({ message })
}

export function setup(context: CliContext): () => void {
  const rpc = context.client?.rpc(SubWorker)

  context.keymap?.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "opencode-sub-worker.status",
        title: "Task force status",
        group: "Sub-worker",
        palette: true,
        slash: { name: "tasks" },
        run: () => (rpc ? showStatus(context, rpc) : context.ui?.toast?.show({ message: "sub-worker server plugin not running" })),
      },
    ],
    bindings: [],
  }))

  let unsubscribe: (() => void) | undefined
  if (rpc) {
    unsubscribe = rpc.events.on("progress", (event) => {
      const type = String(event.data.type ?? "")
      const taskID = String(event.data.taskID ?? "")
      if (type === "task.done") {
        context.ui?.toast?.show({ message: `task ${taskID} done`, variant: "success" })
      } else if (type === "task.blocked" || type === "task.failed") {
        void context.attention?.notify({
          title: "Sub-worker",
          message: `task ${taskID} ${type.replace("task.", "")}`,
          notification: { when: "blurred" },
        })
      } else if (type === "run.completed" || type === "run.failed") {
        void context.attention?.notify({
          title: "Sub-worker",
          message: `run ${type.replace("run.", "")}`,
          notification: { when: "blurred" },
          sound: { name: "done" },
        })
      }
    })
  }

  return () => {
    try {
      unsubscribe?.()
    } catch {
      // ignore
    }
  }
}

export default { id: "opencode-sub-worker.cli", setup }
