/**
 * JSX-free core of the CLI plugin: types, the keymap commands, the status
 * readout and the progress notifications. Kept separate from `tui.tsx` so it
 * can be unit tested without a JSX runtime.
 */

import { SubWorker } from "./rpc.ts"

export const PANEL_NAME = "opencode-sub-worker.panel"

export interface RpcEvent {
  data: Record<string, unknown>
}

export interface RpcClient {
  status(input: { sessionID: string }): Promise<{ json?: string }>
  events: { on(name: string, cb: (event: RpcEvent) => void): () => void }
}

export interface Theme {
  readonly text?: { readonly base?: string; readonly muted?: string }
  readonly success?: string
  readonly error?: string
  readonly warning?: string
}

export interface PanelLike {
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly focused: boolean
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

export interface CliContext {
  readonly client?: { rpc(def: unknown): RpcClient }
  readonly theme?: Theme
  readonly ui?: {
    toast?: { show(input: { title?: string; message: string; variant?: string; sessionID?: string }): void }
    dialog?: { alert?(input: { title: string; message: string }): Promise<unknown> }
    router?: { current?(): { type?: string; sessionID?: string } }
    panel?: {
      open(name: string, options?: { presentation?: string }): boolean
      close(): void
    }
    slot?(claim: { append: string; render: (input: PanelLike) => unknown }): () => void
  }
  readonly keymap?: { layer(factory: () => unknown): void }
  readonly attention?: { notify(input: Record<string, unknown>): Promise<unknown> }
}

export interface TaskRow {
  id: string
  title: string
  status: string
  branch?: string
  attempts?: number
  repairs?: number
  risk?: string
}

export interface RunSnapshot {
  status?: string
  source?: string
  stopReason?: string
  counts?: Record<string, number>
  cost?: number
  tokens?: number
  tasks?: TaskRow[]
}

export interface CliCommand {
  id: string
  title: string
  group: string
  palette: true
  slash: { name: string }
  run: () => void | Promise<void>
}

export function mark(status: string): string {
  const marks: Record<string, string> = {
    done: "x",
    running: ">",
    verifying: "?",
    review: "@",
    failed: "!",
    blocked: "#",
    skipped: "-",
  }
  return marks[status] ?? " "
}

export function colorFor(theme: Theme | undefined, status: string): string | undefined {
  if (status === "done") return theme?.success ?? theme?.text?.base
  if (status === "failed" || status === "blocked") return theme?.error ?? theme?.text?.base
  if (status === "review") return theme?.warning ?? theme?.text?.base
  if (status === "running" || status === "verifying") return theme?.text?.base
  return theme?.text?.muted ?? theme?.text?.base
}

export function currentSessionID(context: CliContext): string | undefined {
  const current = context.ui?.router?.current?.()
  if (current && current.type === "session" && typeof current.sessionID === "string") return current.sessionID
  return undefined
}

export function formatStatus(snapshot: RunSnapshot): string {
  if (!snapshot.tasks || snapshot.status === "none") return "No active task run."
  const head = `${snapshot.source ?? ""}: ${snapshot.status ?? "?"} — done ${snapshot.counts?.done ?? 0}/${
    snapshot.tasks.length
  }`
  const rows = snapshot.tasks.map((t) => `${mark(t.status)} ${t.id} ${t.title}`)
  return [head, ...rows].join("\n")
}

async function readSnapshot(rpc: RpcClient, sessionID: string): Promise<RunSnapshot> {
  const res = await rpc.status({ sessionID })
  try {
    return JSON.parse(res.json ?? "{}") as RunSnapshot
  } catch {
    return {}
  }
}

export function buildCommands(context: CliContext, rpc: RpcClient | undefined): CliCommand[] {
  return [
    {
      id: "opencode-sub-worker.panel",
      title: "Sub-worker run panel",
      group: "Sub-worker",
      palette: true,
      slash: { name: "tasks-panel" },
      run: () => {
        if (!context.ui?.panel) {
          context.ui?.toast?.show({ message: "panel API unavailable" })
          return
        }
        context.ui.panel.open(PANEL_NAME, { presentation: "panel" })
      },
    },
    {
      id: "opencode-sub-worker.status",
      title: "Task force status",
      group: "Sub-worker",
      palette: true,
      slash: { name: "tasks" },
      run: async () => {
        if (!rpc) {
          context.ui?.toast?.show({ message: "sub-worker server plugin not running" })
          return
        }
        const sessionID = currentSessionID(context)
        if (!sessionID) {
          context.ui?.toast?.show({ message: "open a session to see task status", variant: "warning" })
          return
        }
        const message = formatStatus(await readSnapshot(rpc, sessionID))
        if (context.ui?.dialog?.alert) await context.ui.dialog.alert({ title: "Sub-worker", message })
        else context.ui?.toast?.show({ message })
      },
    },
  ]
}

/** Subscribe to RPC progress events and raise toasts/notifications. */
export function subscribeProgress(context: CliContext, rpc: RpcClient): () => void {
  return rpc.events.on("progress", (event) => {
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

/** The RPC client for the sub-worker contract, if the host exposes one. */
export function rpcClient(context: CliContext): RpcClient | undefined {
  return context.client?.rpc(SubWorker)
}
