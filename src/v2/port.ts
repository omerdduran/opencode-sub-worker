/**
 * V2 HostPort adapter: maps the OpenCode V2 plugin context onto the engine's
 * HostPort. Message and result shapes are normalized defensively because the
 * exact runtime schemas are not part of the type surface we duck-type.
 */

import { exec } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { CONTROL_MARKER, DONE_MARKER, BLOCKED_MARKER, WORK_MARKER } from "../core/constants.ts"
import type {
  GateResult,
  GateSpec,
  HostPort,
  LogLevel,
  MergeResult,
  WorkerHandle,
  WorkerSpec,
  WorktreeRef,
} from "../ports.ts"
import type { V2Context } from "./context.ts"

interface ExecOutcome {
  code: number | null
  output: string
  timedOut: boolean
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim()
        if (!err) {
          resolve({ code: 0, output, timedOut: false })
          return
        }
        const e = err as { code?: number | string; killed?: boolean; signal?: string }
        const timedOut = e.killed === true || e.signal === "SIGTERM"
        const code = typeof e.code === "number" ? e.code : null
        resolve({ code, output, timedOut })
      },
    )
  })
}

/** Single-quote a string for POSIX shells. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function textOfParts(parts: unknown): string {
  if (typeof parts === "string") return parts
  if (!Array.isArray(parts)) return ""
  const chunks: string[] = []
  for (const part of parts) {
    if (typeof part === "string") {
      chunks.push(part)
      continue
    }
    if (part && typeof part === "object") {
      const p = part as { type?: string; text?: unknown }
      if (p.type === "text" && typeof p.text === "string") chunks.push(p.text)
    }
  }
  return chunks.join("\n")
}

function lastAssistantText(entries: readonly unknown[]): string {
  let text = ""
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const e = entry as Record<string, unknown>
    const info = (e["info"] && typeof e["info"] === "object" ? e["info"] : e) as Record<string, unknown>
    const role = info["role"] ?? info["type"]
    if (role !== "assistant") continue
    const parts = e["parts"] ?? e["content"]
    let current = textOfParts(parts)
    if (!current && typeof info["text"] === "string") current = info["text"]
    if (current) text = current
  }
  return text
}

function workerAgentMarkdown(): string {
  return `---
description: Isolated worker for one orchestrated task. Runs in its own git worktree.
mode: all
---
You are a sub-worker: an isolated worker executing exactly one task in an orchestrated parallel run.

Rules:
- Work only inside your current checkout.
- Create or modify only the files named in your task's write scope. If you must touch another file, stop and report blocked instead.
- Run the task's verification command before finishing and make it pass.
- Keep your final message short. End with exactly one marker line:
  - \`${DONE_MARKER} <one line of evidence: what changed and what you verified>\` when finished, or
  - \`${BLOCKED_MARKER} <the concrete blocker>\` when you cannot finish.
`
}

export function createV2Port(ctx: V2Context): HostPort {
  const projectID = ctx.location?.project?.id ?? ""
  const baseDirectory =
    ctx.location?.project?.canonical ?? ctx.location?.project?.directory ?? ctx.location?.directory ?? process.cwd()
  const worktree = ctx.worktree

  // Event-driven completion: resolve a session's waiter as soon as the host
  // publishes that it went idle or finished, without polling.
  const finished = new Set<string>()
  const waiters = new Map<string, () => void>()
  let subscribed = false
  const ensureSubscription = (): void => {
    if (subscribed || !ctx.event?.subscribe) return
    subscribed = true
    const subscribe = ctx.event.subscribe.bind(ctx.event)
    void (async () => {
      try {
        for await (const event of subscribe()) {
          const id = event.data?.sessionID ?? event.properties?.sessionID
          if (!id) continue
          if (
            event.type === "session.idle" ||
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted"
          ) {
            finished.add(id)
            const resolve = waiters.get(id)
            if (resolve) {
              waiters.delete(id)
              resolve()
            }
          }
        }
      } catch {
        // stream ended or aborted
      }
    })()
  }

  const port: HostPort = {
    kind: "v2",
    projectID,
    baseDirectory,

    async ensureWorkerAgent(agent: string): Promise<void> {
      const dir = join(baseDirectory, ".opencode", "agents")
      const path = join(dir, `${agent}.md`)
      try {
        await readFile(path, "utf8")
        return // already present
      } catch {
        // write it
      }
      await mkdir(dir, { recursive: true })
      await writeFile(path, workerAgentMarkdown(), "utf8")
    },

    async createWorktree(name: string): Promise<WorktreeRef> {
      if (!worktree || projectID.length === 0) throw new Error("worktree API unavailable")
      const created = await worktree.create({ projectID, name })
      const directory = typeof created["directory"] === "string" ? (created["directory"] as string) : ""
      if (directory.length === 0) throw new Error("worktree create returned no directory")
      return { directory }
    },

    async removeWorktree(directory: string, force: boolean): Promise<void> {
      if (!worktree || projectID.length === 0) return
      await worktree.remove({ projectID, directory, force })
    },

    async mergeWorktree(directory: string, into: string): Promise<MergeResult> {
      const branchRes = await runCommand(`git -C ${shq(directory)} rev-parse --abbrev-ref HEAD`, into, 30_000)
      const branch = branchRes.output.trim().split("\n").pop()?.trim() ?? ""
      if (branchRes.code !== 0 || branch.length === 0 || branch === "HEAD") {
        return { ok: false, output: `could not determine worktree branch: ${branchRes.output}` }
      }
      const merge = await runCommand(
        `git -C ${shq(into)} merge --no-ff --no-edit ${shq(branch)}`,
        into,
        120_000,
      )
      return { ok: merge.code === 0, output: merge.output }
    },

    async spawnWorker(spec: WorkerSpec): Promise<WorkerHandle> {
      const input: Record<string, unknown> = {
        title: `task ${spec.taskID}: ${spec.title}`,
        location: { directory: spec.directory },
        metadata: { subWorkerTask: spec.taskID },
      }
      if (spec.parentSessionID) input["parentID"] = spec.parentSessionID
      if (spec.agent) input["agent"] = spec.agent
      if (spec.model)
        input["model"] = { providerID: spec.model.providerID, id: spec.model.modelID, variant: spec.model.variant }
      if (spec.permissions) input["permissions"] = spec.permissions

      const created = await ctx.session.create(input)
      const sessionID =
        typeof created.id === "string"
          ? created.id
          : typeof created.sessionID === "string"
            ? created.sessionID
            : ""
      if (sessionID.length === 0) throw new Error("session.create returned no id")

      await ctx.session.prompt({
        sessionID,
        text: `${WORK_MARKER}\n${spec.prompt}`,
        metadata: { subWorkerTask: spec.taskID },
      })
      return { sessionID }
    },

    async waitWorker(sessionID: string): Promise<void> {
      if (finished.has(sessionID)) return
      ensureSubscription()
      const eventWait = new Promise<void>((resolve) => {
        waiters.set(sessionID, resolve)
      })
      // The host's own wait is a fallback when no event stream is available.
      const hostWait = ctx.session.wait({ sessionID }).catch(() => undefined)
      await Promise.race([eventWait, hostWait])
      finished.add(sessionID)
      const resolve = waiters.get(sessionID)
      if (resolve) {
        waiters.delete(sessionID)
        resolve()
      }
    },

    async readWorkerOutcome(sessionID: string): Promise<string> {
      const entries = await ctx.session.context({ sessionID })
      return lastAssistantText(entries)
    },

    async readWorkerStats(sessionID: string): Promise<{ cost: number; tokens: number }> {
      const entries = await ctx.session.context({ sessionID })
      let cost = 0
      let tokens = 0
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue
        const e = entry as Record<string, unknown>
        const info = (e["info"] && typeof e["info"] === "object" ? e["info"] : e) as Record<string, unknown>
        if (info["role"] !== "assistant" && info["type"] !== "assistant") continue
        const t = info["tokens"] as
          | { input?: number; output?: number; reasoning?: number }
          | undefined
        if (t) tokens += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0)
        if (typeof info["cost"] === "number") cost += info["cost"] as number
      }
      return { cost, tokens }
    },

    async changedFiles(directory: string): Promise<string[]> {
      const res = await runCommand(`git -C ${shq(directory)} status --porcelain`, directory, 30_000)
      if (res.code !== 0) return []
      const out = new Set<string>()
      for (const line of res.output.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.length < 4) continue
        let path = trimmed.slice(3)
        const arrow = path.indexOf(" -> ")
        if (arrow >= 0) path = path.slice(arrow + 4)
        path = path.replace(/^"|"$/g, "").replace(/\\/g, "/")
        if (path.length > 0) out.add(path)
      }
      return [...out]
    },

    async commitWorktree(directory: string, message: string): Promise<MergeResult> {
      const res = await runCommand(
        `git -C ${shq(directory)} add -A && git -C ${shq(directory)} commit -m ${shq(message)} --no-verify`,
        directory,
        60_000,
      )
      const nothing = /nothing to commit|no changes added|nothing added to commit/i.test(res.output)
      return { ok: res.code === 0 || nothing, output: res.output }
    },

    async sendWorkerMessage(sessionID: string, text: string): Promise<void> {
      await ctx.session.prompt({
        sessionID,
        text: `${CONTROL_MARKER}\n${text}`,
        delivery: "steer",
      })
    },

    async disposeWorker(sessionID: string): Promise<void> {
      try {
        if (ctx.session.interrupt) await ctx.session.interrupt({ sessionID, continue: false })
      } catch {
        // ignore
      }
      try {
        if (ctx.session.remove) await ctx.session.remove({ sessionID })
      } catch {
        // ignore
      }
    },

    async runGate(spec: GateSpec): Promise<GateResult> {
      const res = await runCommand(spec.command, spec.directory, spec.timeoutMs)
      return {
        ok: res.code === 0,
        output: res.output,
        exitCode: res.code,
        timedOut: res.timedOut,
      }
    },

    storage: {
      get: (key: string) => ctx.storage.get(key),
      set: (key: string, value: unknown) => ctx.storage.set(key, value),
      remove: (key: string) => ctx.storage.remove(key),
    },

    async log(level: LogLevel, message: string, extra?: Record<string, unknown>): Promise<void> {
      if (level === "debug") return
      const line = `[opencode-sub-worker] ${message}`
      if (level === "error") console.error(line, extra ?? "")
      else if (level === "warn") console.warn(line, extra ?? "")
      else console.log(line, extra ?? "")
    },

    async notify(message: string): Promise<void> {
      console.log(`[opencode-sub-worker] ${message}`)
    },

    now(): number {
      return Date.now()
    },
  }

  return port
}

/** Resolve a source argument (inline markdown, or a path) against the base dir. */
export async function readSource(
  baseDirectory: string,
  input: { source?: string; file?: string },
): Promise<{ text: string; label: string }> {
  if (typeof input.source === "string" && input.source.trim().length > 0) {
    return { text: input.source, label: "inline" }
  }
  if (typeof input.file === "string" && input.file.trim().length > 0) {
    const path = isAbsolute(input.file) ? input.file : resolve(baseDirectory, input.file)
    const text = await readFile(path, "utf8")
    return { text, label: input.file }
  }
  throw new Error("provide either `file` (a path) or `source` (inline markdown)")
}
