// CSP-safe arithmetic for Compute Column: a tiny recursive-descent evaluator
// over validated tokens (numbers, identifiers, + - * / ( )). Returns null on
// any parse error or non-numeric variable reference; NaN survives (division by
// zero) so callers can map it to missing.
export type ExprVars = Record<string, number | string | null>

export function evalExprTokens(tokens: string[], vars: ExprVars): number | null {
  let pos = 0
  function atom(): number | null {
    const t = tokens[pos++]
    if (t === undefined) return null
    if (t === '(') {
      const inner = expr()
      if (inner === null || tokens[pos++] !== ')') return null
      return inner
    }
    if (t === '-') {
      const v = atom()
      return v === null ? null : -v
    }
    if (/^\d/.test(t)) return Number(t)
    if (/^[A-Za-z_]/.test(t)) {
      const v = vars[t]
      return typeof v === 'number' ? v : null
    }
    return null
  }
  function term(): number | null {
    let acc = atom()
    if (acc === null) return null
    while (tokens[pos] === '*' || tokens[pos] === '/') {
      const op = tokens[pos++]
      const rhs = atom()
      if (rhs === null) return null
      if (op === '*') acc = acc * rhs
      else if (rhs === 0) acc = NaN
      else acc = acc / rhs
    }
    return acc
  }
  function expr(): number | null {
    let acc = term()
    if (acc === null) return null
    while (tokens[pos] === '+' || tokens[pos] === '-') {
      const op = tokens[pos++]
      const rhs = term()
      if (rhs === null) return null
      acc = op === '+' ? acc + rhs : acc - rhs
    }
    return acc
  }
  const result = expr()
  return pos === tokens.length ? result : null
}

/** Tokenize a Compute expression; empty array means the expression had characters we do not support. */
export function tokenizeExpr(expr: string): string[] {
  const tokens = expr.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[+\-*/()]/g) ?? []
  return tokens.join('') === expr.replace(/\s/g, '') ? tokens : []
}
