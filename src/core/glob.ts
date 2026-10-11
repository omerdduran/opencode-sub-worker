/**
 * Glob matching for declared write scopes.
 *
 * Supported syntax: `*` (within a path segment), `?`, and `**` (across
 * segments). Matching is used both for conflict detection and for the
 * post-run diff-scope check.
 */

const GLOB_CHARS = /[*?[\]{}()!+@]/

export function hasGlob(spec: string): boolean {
  return GLOB_CHARS.test(spec)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function globToRegExp(glob: string): RegExp {
  let re = "^"
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++
        if (glob[i + 1] === "/") {
          i++
          re += "(?:.*/)?"
        } else {
          re += ".*"
        }
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else {
      re += escapeRegExp(c)
    }
  }
  re += "$"
  return new RegExp(re)
}

export function pathMatchesGlob(spec: string, path: string): boolean {
  if (!hasGlob(spec)) return spec === path
  return globToRegExp(spec).test(path)
}

export function matchesAny(specs: readonly string[], path: string): boolean {
  return specs.some((spec) => pathMatchesGlob(spec, path))
}

/** The literal directory prefix before the first glob character, with a trailing slash. */
function staticPrefix(spec: string): string {
  const idx = spec.search(GLOB_CHARS)
  if (idx < 0) return spec
  const cut = spec.slice(0, idx)
  const slash = cut.lastIndexOf("/")
  return slash >= 0 ? cut.slice(0, slash + 1) : ""
}

/**
 * Whether two write-scope specs can refer to a common path. Conservative: when
 * in doubt it reports a conflict, so an imprecise scope never runs in parallel.
 */
export function specConflicts(a: string, b: string): boolean {
  if (a === b) return true
  const aGlob = hasGlob(a)
  const bGlob = hasGlob(b)
  if (!aGlob && !bGlob) return false
  if (!aGlob) return pathMatchesGlob(b, a)
  if (!bGlob) return pathMatchesGlob(a, b)
  const pa = staticPrefix(a)
  const pb = staticPrefix(b)
  if (pa.length === 0 || pb.length === 0) return true
  return pa.startsWith(pb) || pb.startsWith(pa)
}
