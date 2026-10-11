/**
 * The RPC contract opencode-sub-worker exposes, so other plugins and clients can
 * read run status and subscribe to progress events.
 *
 * This is a plain Rpc.define-shaped object. It is exported from the package as
 * `opencode-sub-worker/rpc` so a client (for example the bundled CLI plugin) can
 * import the same shape without loading the implementation.
 */

export const SubWorker = {
  id: "opencode.sub-worker",
  methods: {
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
        additionalProperties: false,
      },
    },
  },
  events: {
    progress: {
      schema: {
        type: "object",
        properties: {
          type: { type: "string" },
          runID: { type: "string" },
          taskID: { type: "string" },
          detail: { type: "string" },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
  },
} as const

export interface SubWorkerStatus {
  json: string
}
