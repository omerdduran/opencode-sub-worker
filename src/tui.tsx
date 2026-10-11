/**
 * CLI (TUI) plugin.
 *
 * Adds a "Sub-worker run panel" session panel (a live task table), a
 * "Task force status" palette/`/tasks` command, and attention notifications
 * when a task or a run finishes or fails. The JSX-free parts live in
 * `tui-commands.ts`.
 */

import { createSignal, For, onCleanup, Show } from "solid-js"
import {
  PANEL_NAME,
  buildCommands,
  colorFor,
  mark,
  rpcClient,
  subscribeProgress,
  type CliContext,
  type PanelLike,
  type RunSnapshot,
  type TaskRow,
} from "./tui-commands.ts"

function RunPanel(props: { context: CliContext; panel: PanelLike }) {
  const rpc = rpcClient(props.context)
  const theme = props.context.theme
  const [snapshot, setSnapshot] = createSignal<RunSnapshot | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const refresh = async (): Promise<void> => {
    if (!rpc) return
    try {
      const res = await rpc.status({ sessionID: props.panel.sessionID })
      setSnapshot(JSON.parse(res.json ?? "{}") as RunSnapshot)
      setError(undefined)
    } catch (err) {
      setError(String(err))
    }
  }
  void refresh()

  const unsubscribe = rpc?.events.on("progress", () => {
    void refresh()
  })
  const timer = setInterval(() => {
    void refresh()
  }, 2000)
  onCleanup(() => {
    clearInterval(timer)
    unsubscribe?.()
  })

  // Panel-scoped keys (active only while this component owns the slot).
  props.context.keymap?.layer(() => ({
    commands: [
      { id: "opencode-sub-worker.panel.fullscreen", bind: "f", run: () => props.panel.toggleFullscreen() },
      { id: "opencode-sub-worker.panel.close", bind: "escape", run: () => props.panel.close() },
    ],
  }))

  const tasks = (): TaskRow[] => snapshot()?.tasks ?? []
  const counts = (): Record<string, number> => snapshot()?.counts ?? {}

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={theme?.text?.base}>{"Sub-worker"}</text>
      <Show
        when={snapshot()}
        fallback={<text fg={theme?.text?.muted}>{"No active task run. Start one with /tasks run <file>."}</text>}
      >
        <box flexDirection="column">
          <text fg={theme?.text?.muted}>
            {`${snapshot()!.source ?? ""}  ·  ${snapshot()!.status ?? ""}${
              snapshot()!.stopReason ? ` (${snapshot()!.stopReason})` : ""
            }`}
          </text>
          <text fg={theme?.text?.muted}>
            {`done ${counts().done ?? 0}/${tasks().length}  ·  $${(snapshot()!.cost ?? 0).toFixed(4)}  ·  ${
              snapshot()!.tokens ?? 0
            } tokens`}
          </text>
          <box flexDirection="column">
            <For each={tasks()}>
              {(task) => (
                <text fg={colorFor(theme, task.status)}>
                  {` ${mark(task.status)}  ${task.id.padEnd(8)} ${task.status.padEnd(9)} ${task.title}${
                    task.attempts ? `  (attempts ${task.attempts})` : ""
                  }`}
                </text>
              )}
            </For>
          </box>
        </box>
      </Show>
      <Show when={error()}>
        <text fg={theme?.error}>{`error: ${error()}`}</text>
      </Show>
      <text fg={theme?.text?.muted}>{"[f] fullscreen  ·  [esc] close"}</text>
    </box>
  )
}

export function setup(context: CliContext): () => void {
  const rpc = rpcClient(context)
  const cleanups: Array<() => void> = []

  context.keymap?.layer(() => ({
    mode: "global",
    commands: buildCommands(context, rpc),
    bindings: [],
  }))

  if (context.ui?.slot) {
    const unregister = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL_NAME} fallback={null}>
          <RunPanel context={context} panel={panel} />
        </Show>
      ),
    })
    cleanups.push(unregister)
  }

  if (rpc) cleanups.push(subscribeProgress(context, rpc))

  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // ignore
      }
    }
  }
}

export default { id: "opencode-sub-worker.cli", setup }
