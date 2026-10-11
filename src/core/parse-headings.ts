/**
 * `headings` task-list parser.
 *
 * Reads the PRD/tasks.md shape used by feature workflows: frontmatter, tasks as
 * `### N. [ ] Title` headings, and bold `**Label:**` fields under each. Order in
 * the file is the dependency chain (the engine can turn that into explicit deps
 * with `sequentialDeps`). Parsing is tolerant by design: unknown labels are
 * ignored and a slightly reworded heading is still recognized.
 */

import type { FieldMap } from "./options.ts"
import type { ParseResult, Task } from "./types.ts"

export interface HeadingParseResult extends ParseResult {
  meta: Record<string, string>
}

const TASK_RE = /^#{3,}\s+(\d+)[.)]?\s*\[([ xX])\]\s*(.*)$/
const FIELD_RE = /^\s*[-*]?\s*\*\*([^*]+?):?\*\*:?\s*(.*)$/
const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX])\]\s+(.*\S)\s*$/

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

function buildLabelIndex(fields: FieldMap): Map<string, keyof FieldMap> {
  const map = new Map<string, keyof FieldMap>()
  for (const key of Object.keys(fields) as Array<keyof FieldMap>) {
    for (const label of fields[key]) map.set(label.toLowerCase().trim(), key)
  }
  return map
}

function parsePaths(value: string): string[] {
  const backticked = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
  const base = backticked.length > 0 ? backticked : value.split(",")
  return [...new Set(base.map((s) => normalizePath(s.replace(/`/g, ""))).filter((s) => s.length > 0))]
}

function parseRisk(value: string): string {
  for (const ch of ["🔴", "🟠", "🟢"]) if (value.includes(ch)) return ch
  return value.trim().split(/\s+/)[0] ?? ""
}

function parseList(value: string): string[] {
  const backticked = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
  const base = backticked.length > 0 ? backticked : value.split(/[,\n]/)
  return [...new Set(base.map((s) => s.replace(/`/g, "").trim()).filter((s) => s.length > 0))]
}

function parseFrontmatter(lines: string[]): { meta: Record<string, string>; rest: string[] } {
  const meta: Record<string, string> = {}
  if (lines[0]?.trim() !== "---") return { meta, rest: lines }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i
      break
    }
  }
  if (end < 0) return { meta, rest: lines }
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]!)
    if (!m) continue
    let value = m[2]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[m[1]!] = value
  }
  return { meta, rest: lines.slice(end + 1) }
}

interface RawTask {
  number: string
  checked: boolean
  title: string
  design: boolean
  values: Map<keyof FieldMap, string[]>
  acceptance: string[]
  raw: string
}

function collectBlock(lines: string[], start: number, labelIndex: Map<string, keyof FieldMap>): RawTask {
  const head = TASK_RE.exec(lines[start]!)!
  const raw: string[] = [lines[start]!]
  const values = new Map<keyof FieldMap, string[]>()
  const acceptance: string[] = []
  let lastKey: keyof FieldMap | undefined
  let inAcceptance = false

  const append = (key: keyof FieldMap | undefined, text: string): void => {
    if (!key || text.trim().length === 0) return
    const list = values.get(key) ?? []
    list.push(text.trim())
    values.set(key, list)
  }

  let i = start + 1
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (TASK_RE.test(line)) break
    if (/^##\s/.test(line)) break
    raw.push(line)

    const field = FIELD_RE.exec(line)
    if (field) {
      const key = labelIndex.get(field[1]!.toLowerCase().trim())
      inAcceptance = key === "acceptance"
      lastKey = key
      if (key !== "acceptance") append(key, field[2]!)
      continue
    }
    const checkbox = CHECKBOX_RE.exec(line)
    if (checkbox) {
      if (inAcceptance) acceptance.push(checkbox[2]!.trim())
      continue
    }
    if (line.trim().length === 0) continue
    if (!inAcceptance) append(lastKey, line)
  }

  // Re-examine the head title for a [design] annotation.
  let title = head[3]!.trim()
  const design = /^\[design\]\s*/i.test(title)
  if (design) title = title.replace(/^\[design\]\s*/i, "").trim()

  const task: RawTask = {
    number: head[1]!,
    checked: head[2]!.toLowerCase() === "x",
    title,
    design,
    values,
    acceptance,
    raw: raw.join("\n"),
  }
  return task
}

export function parseHeadings(source: string, fields: FieldMap): HeadingParseResult {
  const errors: string[] = []
  const allLines = source.split(/\r?\n/)
  const { meta, rest } = parseFrontmatter(allLines)
  const labelIndex = buildLabelIndex(fields)

  const starts: number[] = []
  rest.forEach((line, index) => {
    if (TASK_RE.test(line)) starts.push(index)
  })

  const rawTasks = starts.map((start) => collectBlock(rest, start, labelIndex))

  // Assign ids: the heading number, deduped.
  const used = new Set<string>()
  const ids: string[] = []
  rawTasks.forEach((t) => {
    let id = t.number
    if (used.has(id)) {
      errors.push(`duplicate task number "${id}"; using "${id}-2"`)
      id = `${id}-2`
    }
    used.add(id)
    ids.push(id)
  })

  const text = (key: keyof FieldMap, t: RawTask): string => (t.values.get(key) ?? []).join(" ").trim()

  const tasks: Task[] = rawTasks.map((t, i) => {
    const id = ids[i]!
    const files = parsePaths(text("files", t))
    const verifyValue = text("verify", t)
    const risk = parseRisk(text("risk", t))
    const storiesText = text("stories", t)
    const stories = [...storiesText.matchAll(/\d+/g)].map((m) => Number(m[0]))

    const task: Task = {
      id,
      index: i + 1,
      title: t.title,
      checkedInSource: t.checked,
      files,
      verify: verifyValue.length > 0 ? verifyValue : null,
      deps: [],
      status: t.checked ? "skipped" : "pending",
      attempts: 0,
      raw: t.raw,
    }
    if (t.design) task.design = true
    if (risk.length > 0) task.risk = risk
    if (stories.length > 0) task.stories = stories
    const tdd = text("tdd", t)
    if (tdd.length > 0) task.tdd = tdd
    const what = text("whatToBuild", t)
    if (what.length > 0) task.whatToBuild = what
    const outOfScope = parseList(text("outOfScope", t))
    if (outOfScope.length > 0) task.outOfScope = outOfScope
    const spec = text("spec", t)
    if (spec.length > 0) task.spec = spec
    if (t.acceptance.length > 0) task.acceptance = t.acceptance
    const locks = parseList(text("locks", t))
    if (locks.length > 0) task.locks = locks
    const agent = text("agent", t)
    if (agent.length > 0) task.agent = agent
    const model = text("model", t)
    if (model.length > 0) task.model = model
    const prio = Number(text("priority", t))
    if (Number.isFinite(prio) && text("priority", t).length > 0) task.priority = prio
    return task
  })

  // Resolve deps: numeric tokens are heading numbers, others are ids.
  const byId = new Map(tasks.map((t) => [t.id, t] as const))
  rawTasks.forEach((t, i) => {
    const depsText = text("deps", t)
    if (depsText.length === 0) return
    const deps: string[] = []
    for (const token of parseList(depsText.replace(/\s+/g, ","))) {
      const target = /^\d+$/.test(token) ? token : token
      if (!byId.has(target)) {
        errors.push(`task "${ids[i]}" depends on unknown task "${token}"`)
        continue
      }
      if (target !== ids[i] && !deps.includes(target)) deps.push(target)
    }
    tasks[i]!.deps = deps
  })

  if (tasks.length === 0) {
    errors.push("no tasks found (expected headings like '### 1. [ ] title')")
  }

  return { tasks, errors, meta }
}
