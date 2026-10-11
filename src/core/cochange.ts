/**
 * Git co-change learning.
 *
 * Records which files changed together across completed tasks and reports a
 * conflict when two write scopes have historically changed together often
 * enough. This is a heuristic: it can over-serialize, never under-serialize
 * (it only ever adds conflicts).
 */

const SEP = "\u0000"

export class CoChangeStore {
  private readonly pairs = new Map<string, number>()
  private readonly minCount: number

  constructor(minCount = 2) {
    this.minCount = minCount
  }

  record(files: readonly string[]): void {
    const unique = [...new Set(files)].sort()
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = `${unique[i]}${SEP}${unique[j]}`
        this.pairs.set(key, (this.pairs.get(key) ?? 0) + 1)
      }
    }
  }

  score(a: string, b: string): number {
    const [x, y] = a <= b ? [a, b] : [b, a]
    return this.pairs.get(`${x}${SEP}${y}`) ?? 0
  }

  /** True when any file pair across the two scopes has been seen >= minCount. */
  conflicts(a: readonly string[], b: readonly string[]): boolean {
    for (const fa of a) {
      for (const fb of b) {
        if (fa !== fb && this.score(fa, fb) >= this.minCount) return true
      }
    }
    return false
  }

  serialize(): Record<string, number> {
    return Object.fromEntries(this.pairs)
  }

  load(data: unknown): void {
    if (!data || typeof data !== "object") return
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) this.pairs.set(key, value)
    }
  }
}
