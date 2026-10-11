/**
 * V2 plugin entrypoint. Registers the command and the agent tools on an
 * OpenCode V2 plugin context and returns a cleanup function.
 *
 * A plugin cannot register new agents through `agent.transform` (there is no
 * `add`), so the worker agent is installed as a markdown file on setup.
 */

import { Engine } from "../core/engine.ts"
import { normalizeOptions } from "../core/options.ts"
import { control } from "../core/prompt.ts"
import type { V2Context, V2ToolContext } from "./context.ts"
import { createV2Port, readSource } from "./port.ts"
import { registerV2Tools, type V2ToolEditor } from "./tools.ts"

interface Registration {
  dispose(): Promise<void>
}

function isRegistration(value: unknown): value is Registration {
  return !!value && typeof (value as Registration).dispose === "function"
}

function helpText(): string {
  return [
    "Usage:",
    "  /tasks plan <file|markdown>   preview the dependency/conflict schedule (no execution)",
    "  /tasks run <file|markdown>    start the run (parallel isolated workers)",
    "  /tasks status                 show task statuses and recent activity",
    "  /tasks list                   one-line summary",
    "  /tasks resume                 resume a paused run",
    "  /tasks abort                  stop the run and its workers",
    "  /tasks answer <taskID> <text> answer a blocked worker and continue it",
  ].join("\n")
}

async function resolveSource(baseDirectory: string, rest: string): Promise<{ text: string; label: string }> {
  const trimmed = rest.trim()
  if (trimmed.length === 0) throw new Error("provide a file path or inline markdown")
  // Inline markdown (a checklist line, heading, or fence) is used as-is.
  if (/[\n#`]/.test(trimmed) || /^[-*]\s*\[/.test(trimmed)) {
    return { text: trimmed, label: "inline" }
  }
  try {
    return await readSource(baseDirectory, { file: trimmed })
  } catch {
    return { text: trimmed, label: "inline" }
  }
}

async function handleCommand(
  engine: Engine,
  baseDirectory: string,
  sessionID: string,
  raw: string,
): Promise<string> {
  const text = raw.trim()
  if (text.length === 0) return control(engine.statusText(sessionID))
  const spaceAt = text.indexOf(" ")
  const cmd = (spaceAt >= 0 ? text.slice(0, spaceAt) : text).toLowerCase()
  const rest = spaceAt >= 0 ? text.slice(spaceAt + 1).trim() : ""

  switch (cmd) {
    case "status":
      return control(engine.statusText(sessionID))
    case "list":
      return control(engine.listText(sessionID))
    case "plan": {
      const src = await resolveSource(baseDirectory, rest)
      return control(engine.planText(src.text, src.label))
    }
    case "run":
    case "start": {
      const src = await resolveSource(baseDirectory, rest)
      const run = await engine.start(sessionID, src.text, src.label)
      return control(
        `Run started: ${run.tasks.length} task(s), maxConcurrency=${run.maxConcurrency}. Each ready task runs as an isolated worker session in its own worktree; use /tasks status to follow it.`,
      )
    }
    case "resume": {
      const run = await engine.resume(sessionID)
      return control(run ? `Run resumed (${run.tasks.length} task(s)).` : "No run to resume.")
    }
    case "abort":
    case "stop": {
      const run = await engine.abort(sessionID)
      return control(run ? "Run aborted." : "No run to abort.")
    }
    case "answer": {
      const m = /^(\S+)\s+([\s\S]+)$/.exec(rest)
      if (!m) return control("Usage: /tasks answer <taskID> <text>")
      const ok = await engine.answer(sessionID, m[1]!, m[2]!.trim())
      return control(ok ? `Answer sent to ${m[1]}.` : `No blocked worker ${m[1]} to answer.`)
    }
    default:
      return control(helpText())
  }
}

export async function setupV2(rawCtx: unknown): Promise<() => Promise<void>> {
  const ctx = rawCtx as V2Context
  // Only a real V2 host (with a version string) should activate.
  if (!ctx.app || typeof ctx.app.version !== "string" || ctx.app.version.length === 0) {
    return async () => {}
  }

  const options = normalizeOptions(ctx.options ?? {})
  const port = createV2Port(ctx)
  const engine = new Engine(options, port)

  await engine.load()
  await port.log("info", "opencode-sub-worker ready (V2)", { version: ctx.app.version })

  if (options.installWorkerAgent) {
    try {
      await port.ensureWorkerAgent(options.workerAgent)
    } catch (err) {
      await port.log("warn", "could not install worker agent", { error: String(err) })
    }
  }

  const disposers: Registration[] = []
  const track = (registration: unknown): void => {
    if (isRegistration(registration)) disposers.push(registration)
  }

  if (options.registerCommand) {
    track(
      await ctx.command.transform((editor) => {
        editor.add({
          name: options.commandName,
          description: "Plan or run a markdown task checklist across isolated parallel workers.",
          execute: async (invocation: unknown) => {
            const inv = invocation as {
              sessionID: string
              prompt?: Record<string, unknown>
              delivery?: unknown
            }
            const argText =
              inv.prompt && typeof inv.prompt["text"] === "string" ? (inv.prompt["text"] as string) : ""
            let outcome: string
            try {
              outcome = await handleCommand(engine, port.baseDirectory, inv.sessionID, argText)
            } catch (err) {
              outcome = control(`Error: ${String(err)}`)
            }
            const body: Record<string, unknown> = {
              ...(inv.prompt ?? {}),
              sessionID: inv.sessionID,
              text: outcome,
            }
            if (inv.delivery !== undefined) body["delivery"] = inv.delivery
            await ctx.session.prompt(body)
          },
        })
      }),
    )
  }

  if (options.registerTools) {
    track(
      await ctx.tool.transform((editor) => {
        registerV2Tools(editor as V2ToolEditor, engine)
      }),
    )
  }

  return async () => {
    for (const registration of disposers) {
      try {
        await registration.dispose()
      } catch {
        // ignore
      }
    }
    await engine.persist()
  }
}

export type { V2ToolContext }
