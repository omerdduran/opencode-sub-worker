/**
 * Markdown checklist parser.
 *
 * A task is any line matching `- [ ] title` or `* [x] title` (checked items are
 * recognised and skipped at run time). Lines that follow a task and match
 * `key: value` (optionally bulleted, e.g. `  - files: a.ts`) attach metadata to
 * it when indented at least as far as the task.
 *
 * Recognised metadata: id, files, verify, deps, agent, risk, timeout.
 *
 * The parser is deliberately forgiving: unknown lines and unknown keys are
 * ignored, but structural problems (duplicate ids, unknown dependency targets)
 * are reported in `errors` rather than thrown.
 */

import { META_KEYS, VERIFY_OFF } from "./constants.ts"
import type { ParseResult, Task } from "./types.ts"

interface RawTask {
  indent: number
  checked: boolean
  title: string
  meta: Record<string, string>
}

const ITEM_RE = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/
const META_RE = /^(\s*)(?:[-*+]\s+)?([A-Za-z][\w-]*)\s*:\s*(.*)$/

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

function parseTimeoutMs(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(value.trim())
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n)) return undefined
  const unit = (m[2] ?? "ms").toLowerCase()
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000
  return Math.round(n * factor)
}

function extractRaw(source: string): RawTask[] {
  const raw: RawTask[] = []
  let current: RawTask | undefined
  for (const line of source.split(/\r?\n/)) {
    const item = ITEM_RE.exec(line)
    if (item) {
      current = {
        indent: item[1]!.length,
        checked: item[2]!.toLowerCase() === "x",
        title: item[3]!.trim(),
        meta: {},
      }
      raw.push(current)
      continue
    }
    const meta = META_RE.exec(line)
    if (meta && current && meta[1]!.length >= current.indent) {
      const key = meta[2]!.toLowerCase()
      if ((META_KEYS as readonly string[]).includes(key)) {
        current.meta[key] = meta[3]!.trim()
      }
    }
  }
  return raw
}

export function parseChecklist(source: string): ParseResult {
  const errors: string[] = []
  const raw = extractRaw(source)

  // Assign ids: explicit `id:` wins, otherwise `t<index>`.
  const used = new Set<string>()
  const ids: string[] = []
  raw.forEach((r, i) => {
    let id = (r.meta["id"] ?? `t${i + 1}`).trim()
    if (id.length === 0) id = `t${i + 1}`
    if (used.has(id)) {
      errors.push(`duplicate task id "${id}" at item ${i + 1}; using "${id}-${i + 1}"`)
      id = `${id}-${i + 1}`
    }
    used.add(id)
    ids.push(id)
  })

  const tasks: Task[] = raw.map((r, i) => {
    const idx = i + 1
    const id = ids[i]!
    const files = splitList(r.meta["files"] ?? "").map(normalizePath)
    const verifyRaw = (r.meta["verify"] ?? "").trim()
    const verify = verifyRaw.length === 0 || VERIFY_OFF.has(verifyRaw.toLowerCase()) ? null : verifyRaw

    const deps: string[] = []
    for (const token of splitList((r.meta["deps"] ?? "").replace(/[;\s]+/g, ","))) {
      let depID = token
      if (/^\d+$/.test(token)) {
        const n = Number(token)
        const target = ids[n - 1]
        if (!target) {
          errors.push(`task "${id}" depends on missing item ${n}`)
          continue
        }
        depID = target
      } else if (!used.has(token)) {
        errors.push(`task "${id}" depends on unknown id "${token}"`)
        continue
      }
      if (depID === id) {
        errors.push(`task "${id}" depends on itself`)
        continue
      }
      if (!deps.includes(depID)) deps.push(depID)
    }

    const timeoutMs = r.meta["timeout"] ? parseTimeoutMs(r.meta["timeout"]!) : undefined

    const task: Task = {
      id,
      index: idx,
      title: r.title,
      checkedInSource: r.checked,
      files,
      verify,
      deps,
      status: "pending",
      attempts: 0,
    }
    if (r.meta["agent"]) task.agent = r.meta["agent"]!
    if (r.meta["model"]) task.model = r.meta["model"]!
    if (r.meta["risk"]) task.risk = r.meta["risk"]!
    if (r.meta["locks"]) {
      const locks = splitList(r.meta["locks"]!).map((s) => s.trim())
      if (locks.length > 0) task.locks = locks
    }
    if (r.meta["priority"]) {
      const p = Number(r.meta["priority"])
      if (Number.isFinite(p)) task.priority = p
    }
    if (timeoutMs !== undefined) task.timeoutMs = timeoutMs
    return task
  })

  if (tasks.length === 0) errors.push("no tasks found (expected lines like '- [ ] do something')")

  return { tasks, errors }
}
