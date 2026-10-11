/**
 * Prompt construction and worker-outcome parsing.
 *
 * Workers are ordinary sessions. The orchestrator cannot assume a tool it
 * registered is visible inside a worker's worktree location, so the durable
 * contract is a marker at the end of the worker's final message.
 */

import { BLOCKED_MARKER, CONTROL_MARKER, DONE_MARKER, WORK_MARKER } from "./constants.ts"
import type { Task } from "./types.ts"

export interface WorkerOutcome {
  kind: "done" | "blocked" | "unknown"
  evidence: string
  blocker: string
}

export function buildWorkerPrompt(task: Task, projectDir: string, previousError?: string): string {
  const lines: string[] = []
  lines.push(`${WORK_MARKER} task ${task.id}: ${task.title}`)
  lines.push("")
  lines.push(`You are a worker for one task in an orchestrated run. Your working directory is the isolated checkout provided by the session.`)
  if (task.files.length > 0) {
    lines.push("")
    lines.push("Write scope — only create or modify these paths:")
    for (const f of task.files) lines.push(`  - ${f}`)
    lines.push("Do not modify any other file. If you must, stop and report blocked.")
  } else {
    lines.push("")
    lines.push("No write scope was declared. Keep changes minimal and isolated.")
  }
  if (task.verify) {
    lines.push("")
    lines.push("Before finishing, run this verification command from the task directory and make it pass:")
    lines.push(`  ${task.verify}`)
  }
  if (previousError) {
    lines.push("")
    lines.push(`A previous attempt failed. Address this before finishing:`)
    lines.push(previousError.slice(0, 4000))
  }
  lines.push("")
  lines.push("When the task is finished, end your final message with:")
  lines.push(`${DONE_MARKER} <one line of evidence: what you changed and what you verified>`)
  lines.push("If you cannot finish, end with:")
  lines.push(`${BLOCKED_MARKER} <the concrete blocker>`)
  lines.push("")
  lines.push(`Base project directory (for reference, do not edit outside your checkout): ${projectDir}`)
  return lines.join("\n")
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
  lines.push("If the work is correct and in scope, end with:")
  lines.push(`${DONE_MARKER} <one line: what you checked and why it is correct>`)
  lines.push("If it is wrong, incomplete, or out of scope, end with:")
  lines.push(`${BLOCKED_MARKER} <the concrete problem>`)
  return lines.join("\n")
}

export function summarize(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine
}
