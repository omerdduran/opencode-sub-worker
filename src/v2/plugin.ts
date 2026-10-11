/**
 * V2 plugin entrypoint. Registers the command, the agent tools and the RPC
 * surface on an OpenCode V2 plugin context and returns a cleanup function.
 *
 * A plugin cannot register new agents through `agent.transform` (there is no
 * `add`), so the worker agent is installed as a markdown file on setup.
 */

import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Engine, type EngineEvent } from "../core/engine.ts"
import { normalizeOptions, type CustomParser } from "../core/options.ts"
import { control } from "../core/prompt.ts"
import { SubWorker } from "../rpc.ts"
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
    "  /tasks plan <file|markdown>        preview the dependency/conflict schedule",
    "  /tasks run <file|markdown>         start the run (parallel isolated workers)",
    "  /tasks add <file|markdown>         add tasks to the active run",
    "  /tasks status                      show task statuses and recent activity",
    "  /tasks list                        one-line summary",
    "  /tasks diff <taskID>               show a task's worktree diff",
    "  /tasks logs <taskID>               show a task's status, gate output and history",
    "  /tasks approve <taskID>            approve a task held at the approval gate",
    "  /tasks reject <taskID> <reason>    reject a task held at the approval gate",
    "  /tasks answer <taskID> <text>      answer a blocked worker and continue it",
    "  /tasks broadcast <text>            message every running worker",
    "  /tasks resume | abort              resume a paused run / stop the run",
  ].join("\n")
}

async function resolveSource(baseDirectory: string, rest: string): Promise<{ text: string; label: string }> {
  const trimmed = rest.trim()
  if (trimmed.length === 0) throw new Error("provide a file path or inline markdown")
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
    case "add": {
      const src = await resolveSource(baseDirectory, rest)
      const run = await engine.add(sessionID, src.text, src.label)
      return control(run ? `Added tasks (now ${run.tasks.length}).` : "No active run to add to.")
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
    case "diff": {
      if (!rest) return control("Usage: /tasks diff <taskID>")
      return control(await engine.diffText(sessionID, rest))
    }
    case "logs": {
      if (!rest) return control("Usage: /tasks logs <taskID>")
      return control(engine.logsText(sessionID, rest))
    }
    case "approve": {
      if (!rest) return control("Usage: /tasks approve <taskID>")
      const ok = await engine.approve(sessionID, rest)
      return control(ok ? `Approved ${rest}; integrating.` : `No task ${rest} awaiting approval.`)
    }
    case "reject": {
      const m = /^(\S+)\s*([\s\S]*)$/.exec(rest)
      if (!m) return control("Usage: /tasks reject <taskID> <reason>")
      const ok = await engine.reject(sessionID, m[1]!, m[2]!.trim() || "rejected")
      return control(ok ? `Rejected ${m[1]}.` : `No task ${m[1]} awaiting approval.`)
    }
    case "answer": {
      const m = /^(\S+)\s+([\s\S]+)$/.exec(rest)
      if (!m) return control("Usage: /tasks answer <taskID> <text>")
      const ok = await engine.answer(sessionID, m[1]!, m[2]!.trim())
      return control(ok ? `Answer sent to ${m[1]}.` : `No blocked worker ${m[1]} to answer.`)
    }
    case "broadcast": {
      if (!rest) return control("Usage: /tasks broadcast <text>")
      const count = await engine.broadcast(sessionID, rest)
      return control(`Broadcast reached ${count} worker(s).`)
    }
    default:
      return control(helpText())
  }
}

export async function setupV2(rawCtx: unknown): Promise<() => Promise<void>> {
  const ctx = rawCtx as V2Context
  if (!ctx.app || typeof ctx.app.version !== "string" || ctx.app.version.length === 0) {
    return async () => {}
  }

  const options = normalizeOptions(ctx.options ?? {})
  const port = createV2Port(ctx)

  // Optional custom parser module (absolute path, relative path or package name).
  if (options.parserModule.length > 0) {
    try {
      const mod = options.parserModule
      const spec =
        mod.startsWith("file:") || mod.startsWith(".") || mod.startsWith("/")
          ? pathToFileURL(isAbsolute(mod) ? mod : resolve(port.baseDirectory, mod)).href
          : mod
      const loaded = (await import(spec)) as { parse?: CustomParser; default?: CustomParser }
      const custom = loaded.parse ?? loaded.default
      if (typeof custom === "function") options.customParser = custom
    } catch (err) {
      await port.log("warn", "could not load parserModule", { error: String(err) })
    }
  }

  // Optional worker instruction file appended to every worker prompt.
  if (options.workerInstructionsFile.length > 0) {
    try {
      const path = isAbsolute(options.workerInstructionsFile)
        ? options.workerInstructionsFile
        : resolve(port.baseDirectory, options.workerInstructionsFile)
      const text = await port.readText(path)
      if (text && text.trim().length > 0) {
        options.workerInstructions = [options.workerInstructions, text.trim()]
          .filter((s) => s.length > 0)
          .join("\n\n")
      }
    } catch (err) {
      await port.log("warn", "could not read workerInstructionsFile", { error: String(err) })
    }
  }

  // The engine emits events before the RPC registration exists; route them
  // through a mutable sink that the registration fills in below.
  let sink: ((event: EngineEvent) => void) | undefined
  const engine = new Engine(options, port, (event) => sink?.(event))

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

  // RPC: status method + progress events for external clients / the CLI plugin.
  if (ctx.rpc) {
    try {
      const registration = await ctx.rpc.register(SubWorker, {
        status: async (input: unknown) => {
          const { sessionID } = input as { sessionID: string }
          const snapshot = engine.snapshot(sessionID)
          return { json: JSON.stringify(snapshot ?? { status: "none" }) }
        },
      })
      track(registration)
      sink = (event) => {
        void registration.events
          .emit("progress", {
            type: event.type,
            ...(event.runID !== undefined ? { runID: event.runID } : {}),
            ...(event.taskID !== undefined ? { taskID: event.taskID } : {}),
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
          })
          .catch(() => {})
      }
    } catch (err) {
      await port.log("warn", "could not register RPC", { error: String(err) })
    }
  }

  if (options.registerCommand) {
    track(
      await ctx.command.transform((editor) => {
        editor.add({
          name: options.commandName,
          description: "Plan, run, inspect and control a markdown task checklist across isolated workers.",
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
