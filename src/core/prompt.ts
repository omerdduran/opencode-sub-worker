/**
 * Prompt construction and worker-outcome parsing.
 *
 * Workers are ordinary sessions. The orchestrator cannot assume a tool it
 * registered is visible inside a worker's worktree location, so the durable
 * contract is a report at the end of the worker's final message: a fenced JSON
 * block, with the bracket markers kept as a fallback.
 */

import { BLOCKED_MARKER, CONTROL_MARKER, DONE_MARKER, WORK_MARKER } from "./constants.ts"
import type { Task, WorkerReport } from "./types.ts"

export interface WorkerOutcome {
  kind: "done" | "blocked" | "unknown"
  evidence: string
  blocker: string
}

const REPORT_INSTRUCTIONS = [
  "When the task is finished, end your final message with a fenced JSON report:",
  "```json",
  '{ "status": "done", "evidence": "<what you changed and what you verified>", "files": ["<paths you changed>"] }',
  "```",
  "If you cannot finish, use:",
  "```json",
  '{ "status": "blocked", "blocker": "<the concrete blocker>" }',
  "```",
  `(If you cannot produce JSON, the line "${DONE_MARKER} <evidence>" or "${BLOCKED_MARKER} <blocker>" also works.)`,
]

export function buildWorkerPrompt(task: Task, projectDir: string, previousError?: string): string {
  const lines: string[] = []
  lines.push(`${WORK_MARKER} task ${task.id}: ${task.title}`)
  lines.push("")
  lines.push(
    "You are a worker for one task in an orchestrated run. Your working directory is the isolated checkout provided by the session.",
  )
  if (task.files.length > 0) {
    lines.push("")
    lines.push("Write scope — only create or modify these paths:")
    for (const f of task.files) lines.push(`  - ${f}`)
    lines.push("Do not modify any other file. If you must, stop and report blocked.")
  } else {
    lines.push("")
    lines.push("No write scope was declared. Keep changes minimal and isolated.")
  }
  if (task.locks && task.locks.length > 0) {
    lines.push("")
    lines.push(`This task holds these exclusive locks: ${task.locks.join(", ")}`)
  }
  if (task.verify) {
    lines.push("")
    lines.push("Before finishing, run this verification command from the task directory and make it pass:")
    lines.push(`  ${task.verify}`)
  }
  if (previousError) {
    lines.push("")
    lines.push("A previous attempt failed. Address this before finishing:")
    lines.push(previousError.slice(0, 4000))
  }
  lines.push("")
  for (const line of REPORT_INSTRUCTIONS) lines.push(line)
  lines.push("")
  lines.push(`Base project directory (for reference, do not edit outside your checkout): ${projectDir}`)
  return lines.join("\n")
}

/** Steer a worker whose gate failed back onto the same task to repair it. */
export function buildRepairPrompt(task: Task, failure: string): string {
  const lines: string[] = []
  lines.push(`${CONTROL_MARKER} repair ${task.id}: ${task.title}`)
  lines.push("")
  lines.push("The verification command failed. Fix the problem in this same checkout and make it pass.")
  if (task.verify) {
    lines.push("")
    lines.push(`Command:\n  ${task.verify}`)
  }
  lines.push("")
  lines.push("Output:")
  lines.push("```")
  lines.push(failure.slice(0, 4000))
  lines.push("```")
  lines.push("")
  for (const line of REPORT_INSTRUCTIONS) lines.push(line)
  return lines.join("\n")
}

/** Prompt for an independent, read-only verifier session. */
export function buildVerifierPrompt(task: Task): string {
  const lines: string[] = []
  lines.push(`${WORK_MARKER} verify ${task.id}: ${task.title}`)
  lines.push("")
  lines.push("You are an independent verifier. Do NOT modify any files — inspect only.")
  lines.push(
    "Inspect the working tree changes in this checkout and judge whether the task was completed correctly and whether it stayed within its declared write scope.",
  )
  if (task.files.length > 0) {
    lines.push("")
    lines.push("Declared write scope:")
    for (const f of task.files) lines.push(`  - ${f}`)
  }
  lines.push("")
  for (const line of REPORT_INSTRUCTIONS) lines.push(line)
  return lines.join("\n")
}

/** Parse a worker's final assistant text for the structured report. */
export function parseWorkerReport(text: string): WorkerReport {
  const fence = /```(?:json)?\s*([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) {
    const body = match[1]!.trim()
    if (!body.includes("status")) continue
    try {
      const obj = JSON.parse(body) as Record<string, unknown>
      const raw = obj["status"]
      if (typeof raw !== "string") continue
      const status = raw === "blocked" ? "blocked" : raw === "progress" ? "progress" : "done"
      const report: WorkerReport = { status }
      if (typeof obj["evidence"] === "string") report.evidence = obj["evidence"]
      if (typeof obj["blocker"] === "string") report.blocker = obj["blocker"]
      if (typeof obj["note"] === "string") report.note = obj["note"]
      if (Array.isArray(obj["files"])) report.files = obj["files"].filter((f): f is string => typeof f === "string")
      return report
    } catch {
      // keep looking
    }
  }
  const outcome = parseWorkerOutcome(text)
  if (outcome.kind === "blocked") return { status: "blocked", blocker: outcome.blocker }
  if (outcome.kind === "done") return { status: "done", evidence: outcome.evidence }
  return { status: "progress" }
}

/** Parse a worker's final assistant text for the completion/blocker markers. */
export function parseWorkerOutcome(text: string): WorkerOutcome {
  const clean = text.trim()
  const idxDone = clean.lastIndexOf(DONE_MARKER)
  const idxBlocked = clean.lastIndexOf(BLOCKED_MARKER)

  if (idxBlocked >= 0 && idxBlocked >= idxDone) {
    return {
      kind: "blocked",
      evidence: "",
      blocker: suffix(clean, idxBlocked + BLOCKED_MARKER.length) || "worker reported blocked",
    }
  }
  if (idxDone >= 0) {
    return {
      kind: "done",
      evidence: suffix(clean, idxDone + DONE_MARKER.length) || "worker reported done",
      blocker: "",
    }
  }
  return { kind: "unknown", evidence: "", blocker: "" }
}

function suffix(text: string, from: number): string {
  const rest = text.slice(from).trim()
  const firstLine = rest.split("\n")[0] ?? ""
  return (firstLine || rest).trim()
}

export function control(text: string): string {
  return `${CONTROL_MARKER} ${text}`
}

export function summarize(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine
}
