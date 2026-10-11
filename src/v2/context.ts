/**
 * A minimal, duck-typed description of the OpenCode V2 plugin context.
 *
 * We deliberately do NOT import `@opencode/plugin` types: that would pull the
 * large Effect-based dependency tree into this package and force it on
 * consumers. Only the members this plugin touches are declared here.
 */

export interface V2App {
  readonly name?: string
  readonly version?: string
  readonly channel?: string
}

export interface V2Location {
  readonly directory?: string
  readonly project?: {
    readonly id?: string
    readonly directory?: string
    readonly canonical?: string
  }
}

export interface V2Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan?(options: { prefix: string; after?: string; limit?: number }): Promise<unknown>
}

export interface V2SessionCreated {
  readonly id?: string
  readonly sessionID?: string
  readonly [k: string]: unknown
}

export interface V2SessionDomain {
  create(input?: Record<string, unknown>): Promise<V2SessionCreated>
  prompt(input: Record<string, unknown>): Promise<unknown>
  wait(input: { sessionID: string }): Promise<void>
  context(input: { sessionID: string }): Promise<readonly unknown[]>
  update(input: { sessionID: string; title?: string }): Promise<unknown>
  interrupt?(input: { sessionID: string; continue?: boolean }): Promise<unknown>
  remove?(input: { sessionID: string }): Promise<unknown>
  switchAgent?(input: { sessionID: string; agent: string }): Promise<unknown>
  switchModel?(input: { sessionID: string; model: { providerID: string; id: string } }): Promise<unknown>
}

export interface V2Registration {
  dispose(): Promise<void>
}

export interface V2Context {
  readonly app?: V2App
  readonly location?: V2Location
  readonly options?: Record<string, unknown>

  readonly session: V2SessionDomain

  readonly command: {
    transform(callback: (editor: { add(definition: unknown): void }) => void): Promise<unknown>
  }

  readonly tool: {
    transform(
      callback: (editor: {
        add(tool: unknown): void
        namespace?(ns: unknown): void
        list?(): readonly unknown[]
      }) => void,
    ): Promise<unknown>
  }

  readonly storage: V2Storage

  readonly event?: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{
      type?: string
      data?: { sessionID?: string }
      properties?: { sessionID?: string }
    }>
  }

  readonly worktree?: {
    create(input: Record<string, unknown>): Promise<Record<string, unknown>>
    remove(input: Record<string, unknown>): Promise<unknown>
    list(input: Record<string, unknown>): Promise<unknown>
    refresh?(input: Record<string, unknown>): Promise<unknown>
  }

  readonly rpc?: {
    (definition: unknown): {
      events: { on(name: string, cb: (event: { data: Record<string, unknown> }) => void): () => void }
    }
    register(
      definition: unknown,
      handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
    ): Promise<{
      events: { emit(name: string, data: Record<string, unknown>): Promise<void> }
      dispose(): Promise<void>
    }>
  }
}

export interface V2ToolContext {
  readonly sessionID: string
  readonly agent?: string
  readonly signal?: AbortSignal
  progress?(update: unknown): Promise<void>
}
