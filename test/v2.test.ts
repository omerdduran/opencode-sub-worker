import { test } from "node:test"
import assert from "node:assert/strict"
import { setupV2 } from "../src/v2/plugin.ts"

interface CommandDef {
  name: string
  execute: (invocation: { sessionID: string; prompt?: { text?: string } }) => Promise<void>
}

interface ToolDef {
  name: string
  input: unknown
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>
}

function makeV2Context() {
  const values = new Map<string, unknown>()
  const prompts: Array<Record<string, unknown>> = []
  let commandDef: CommandDef | undefined
  const tools: ToolDef[] = []

  const ctx = {
    app: { name: "opencode", version: "2.0.26", channel: "stable" },
    location: {
      directory: "/tmp/project",
      project: { id: "p1", directory: "/tmp/project", canonical: "/tmp/project" },
    },
    options: { installWorkerAgent: false, useWorktrees: false },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, value)
      },
      remove: async (key: string) => {
        values.delete(key)
      },
    },
    session: {
      create: async () => ({ id: "child" }),
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return {}
      },
      wait: async () => {},
      context: async () => [],
      update: async () => ({}),
    },
    command: {
      transform: async (cb: (editor: { add: (def: unknown) => void }) => void) => {
        cb({ add: (def: unknown) => (commandDef = def as CommandDef) })
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async (cb: (editor: { add: (t: unknown) => void }) => void) => {
        cb({ add: (t: unknown) => tools.push(t as ToolDef) })
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, prompts, tools, get commandDef() { return commandDef } }
}

test("setup with an empty context does not activate", async () => {
  const cleanup = await setupV2({})
  assert.equal(typeof cleanup, "function")
  await cleanup()
})

test("setup registers the command and the tools", async () => {
  const fake = makeV2Context()
  const cleanup = await setupV2(fake.ctx)
  assert.equal(typeof cleanup, "function")
  assert.ok(fake.commandDef)
  assert.equal(fake.commandDef!.name, "tasks")

  const names = fake.tools.map((t) => t.name)
  for (const expected of [
    "taskforce_plan",
    "taskforce_run",
    "taskforce_status",
    "taskforce_resume",
    "taskforce_abort",
    "taskforce_answer",
    "taskforce_send",
    "taskforce_diff",
    "taskforce_logs",
    "taskforce_approve",
    "taskforce_reject",
    "taskforce_add",
    "taskforce_broadcast",
    "worker_report",
    "worker_inbox",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`)
  }
  await cleanup()
})

test("/tasks plan submits a schedule preview without running", async () => {
  const fake = makeV2Context()
  await setupV2(fake.ctx)
  const source = "- [ ] a\n  - files: a.txt\n- [ ] b\n  - files: b.txt"
  await fake.commandDef!.execute({ sessionID: "s1", prompt: { text: `plan ${source}` } })
  assert.equal(fake.prompts.length, 1)
  const text = fake.prompts[0]!["text"] as string
  assert.match(text, /Planned waves/)
  assert.match(text, /wave 1: t1, t2/)
})

test("taskforce_status returns a JSON envelope", async () => {
  const fake = makeV2Context()
  await setupV2(fake.ctx)
  const statusTool = fake.tools.find((t) => t.name === "taskforce_status")!
  const result = await statusTool.execute({}, { sessionID: "s1" })
  const parsed = JSON.parse(result.content) as { ok: boolean; status: string }
  assert.equal(parsed.ok, true)
  assert.match(parsed.status, /No active task run/)
})

test("worker_report on a non-worker session fails cleanly", async () => {
  const fake = makeV2Context()
  await setupV2(fake.ctx)
  const reportTool = fake.tools.find((t) => t.name === "worker_report")!
  const result = await reportTool.execute({ status: "progress" }, { sessionID: "unknown" })
  const parsed = JSON.parse(result.content) as { ok: boolean; error?: string }
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, "not_a_worker_session")
})

test("/tasks run starts a run and reports it in the submitted prompt", async () => {
  const fake = makeV2Context()
  await setupV2(fake.ctx)
  const source = "- [ ] a\n  - files: a.txt"
  await fake.commandDef!.execute({ sessionID: "s1", prompt: { text: `run ${source}` } })
  assert.ok(fake.prompts.length >= 1)
  assert.ok(fake.prompts.some((p) => /Run started/.test(String(p["text"]))))
})

test("setup registers the RPC surface when the host exposes it", async () => {
  const fake = makeV2Context()
  let registered: unknown
  ;(fake.ctx as Record<string, unknown>)["rpc"] = {
    register: async (definition: unknown) => {
      registered = definition
      return { events: { emit: async () => {} }, dispose: async () => {} }
    },
  }
  await setupV2(fake.ctx)
  assert.ok(registered)
  assert.equal((registered as { id: string }).id, "opencode.sub-worker")
})
