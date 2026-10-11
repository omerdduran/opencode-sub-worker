/**
 * Agent-facing tools for V2, registered through `ctx.tool.transform`.
 * JSON Schema inputs (V2 tool convention); JSON envelopes out.
 */

import type { Engine } from "../core/engine.ts"
import type { V2ToolContext } from "./context.ts"
import { readSource } from "./port.ts"

export interface V2ToolEditor {
  add(tool: unknown): void
  namespace?(ns: unknown): void
}

function envelope(ok: boolean, data: Record<string, unknown>): string {
  return JSON.stringify({ plugin: "opencode-sub-worker", version: 1, ok, ...data })
}

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false }

const SOURCE_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string", description: "Path to a markdown task checklist (relative to the project root)." },
    source: { type: "string", description: "Inline markdown task checklist." },
  },
  additionalProperties: false,
}

function summary(run: { id: string; status: string; tasks: unknown[] }): Record<string, unknown> {
  return { runID: run.id, status: run.status, taskCount: run.tasks.length }
}

export function registerV2Tools(editor: V2ToolEditor, engine: Engine): void {
  editor.add({
    name: "taskforce_plan",
    description:
      "Parse a markdown task checklist and preview the dependency- and file-conflict-aware schedule without running anything. Provide `file` (path) or `source` (inline markdown).",
    input: SOURCE_SCHEMA,
    execute: async (input: unknown, _context: V2ToolContext) => {
      try {
        const { text, label } = await readSource(engine.baseDirectory, input as { source?: string; file?: string })
        return { content: envelope(true, { plan: engine.planText(text, label) }) }
      } catch (err) {
        return { content: envelope(false, { error: String(err) }) }
      }
    },
  })

  editor.add({
    name: "taskforce_run",
    description:
      "Start a run: schedule the checklist's ready tasks as isolated parallel workers, gate each with its verification command, and merge results. Provide `file` or `source`.",
    input: SOURCE_SCHEMA,
    execute: async (input: unknown, context: V2ToolContext) => {
      try {
        const { text, label } = await readSource(engine.baseDirectory, input as { source?: string; file?: string })
        const run = await engine.start(context.sessionID, text, label)
        return { content: envelope(true, { started: true, ...summary(run) }) }
      } catch (err) {
        return { content: envelope(false, { error: String(err) }) }
      }
    },
  })

  editor.add({
    name: "taskforce_status",
    description: "Report the current run's tasks, statuses, and recent activity.",
    input: EMPTY_SCHEMA,
    execute: async (_input: unknown, context: V2ToolContext) => ({
      content: envelope(true, { status: engine.statusText(context.sessionID) }),
    }),
  })

  editor.add({
    name: "taskforce_resume",
    description: "Resume a paused run, resetting failed/blocked tasks for another attempt.",
    input: EMPTY_SCHEMA,
    execute: async (_input: unknown, context: V2ToolContext) => {
      const run = await engine.resume(context.sessionID)
      if (!run) return { content: envelope(false, { error: "no_run" }) }
      return { content: envelope(true, { resumed: true, ...summary(run) }) }
    },
  })

  editor.add({
    name: "taskforce_abort",
    description: "Abort the current run and stop any running workers.",
    input: EMPTY_SCHEMA,
    execute: async (_input: unknown, context: V2ToolContext) => {
      const run = await engine.abort(context.sessionID)
      if (!run) return { content: envelope(false, { error: "no_run" }) }
      return { content: envelope(true, { aborted: true, ...summary(run) }) }
    },
  })

  editor.add({
    name: "taskforce_answer",
    description:
      "Answer a worker that reported blocked and resume it (human-in-the-loop). Requires askUserOnBlocked.",
    input: {
      type: "object",
      properties: {
        taskID: { type: "string", description: "Blocked task id (e.g. t1)." },
        text: { type: "string", description: "The answer or guidance to send to the worker." },
      },
      required: ["taskID", "text"],
      additionalProperties: false,
    },
    execute: async (input: unknown, context: V2ToolContext) => {
      const args = input as { taskID: string; text: string }
      const ok = await engine.answer(context.sessionID, args.taskID, args.text)
      return { content: envelope(ok, ok ? { resumed: true } : { error: "no_blocked_worker" }) }
    },
  })

  editor.add({
    name: "taskforce_send",
    description:
      "Send a message from the orchestrator to a running worker (mailbox). The worker can read it with worker_inbox.",
    input: {
      type: "object",
      properties: {
        taskID: { type: "string", description: "Target task id (e.g. t1)." },
        text: { type: "string", description: "Message body." },
      },
      required: ["taskID", "text"],
      additionalProperties: false,
    },
    execute: async (input: unknown, context: V2ToolContext) => {
      const args = input as { taskID: string; text: string }
      const ok = await engine.send(context.sessionID, args.taskID, args.text)
      return { content: envelope(ok, ok ? { sent: true } : { error: "unknown_run_or_task" }) }
    },
  })

  editor.add({
    name: "worker_report",
    description:
      "Worker tool: report progress, completion, or a blocker to the orchestrator's mailbox. Call this from a worker session.",
    input: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["progress", "blocked", "done"] },
        note: { type: "string", description: "Short message for the orchestrator." },
        evidence: { type: "string", description: "What you changed and verified (for status=done)." },
      },
      required: ["status"],
      additionalProperties: false,
    },
    execute: async (input: unknown, context: V2ToolContext) => {
      const args = input as { status?: "progress" | "blocked" | "done"; note?: string; evidence?: string }
      const ok = await engine.report(context.sessionID, args)
      return { content: envelope(ok, ok ? { received: true } : { error: "not_a_worker_session" }) }
    },
  })

  editor.add({
    name: "worker_inbox",
    description: "Worker tool: read and clear messages the orchestrator queued for this worker.",
    input: EMPTY_SCHEMA,
    execute: async (_input: unknown, context: V2ToolContext) => {
      const messages = await engine.inbox(context.sessionID)
      return { content: envelope(true, { messages }) }
    },
  })
}
