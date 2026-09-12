import type { Tool } from '../types.ts'

/**
 * Arithmetic evaluator: a small recursive-descent parser.
 *
 * There is no `eval` anywhere in this project — expressions come from a model,
 * so they are parsed against a fixed grammar and a whitelist of functions.
 *
 * Grammar (lowest precedence first):
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/' | '%') unary)*
 *   unary      := ('+' | '-') unary | power
 *   power      := primary ('^' unary)?          // right associative
 *   primary    := number | identifier | '(' expression ')'
 */

type MathFn = (...args: number[]) => number

const FUNCTIONS: Record<string, MathFn> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  log: Math.log,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
}

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
}

class ExpressionParser {
  private pos = 0
  private readonly source: string

  constructor(source: string) {
    this.source = source
  }

  parse(): number {
    const value = this.parseExpression()
    const rest = this.peek()
    if (rest !== '') {
      throw new Error(`Unexpected "${rest}" at position ${this.pos}`)
    }
    return value
  }

  private parseExpression(): number {
    let left = this.parseTerm()
    for (;;) {
      const op = this.peek()
      if (op !== '+' && op !== '-') return left
      this.pos++
      const right = this.parseTerm()
      left = op === '+' ? left + right : left - right
    }
  }

  private parseTerm(): number {
    let left = this.parseUnary()
    for (;;) {
      const op = this.peek()
      if (op !== '*' && op !== '/' && op !== '%') return left
      this.pos++
      const right = this.parseUnary()
      if ((op === '/' || op === '%') && right === 0) {
        throw new Error('Division by zero')
      }
      if (op === '*') left = left * right
      else if (op === '/') left = left / right
      else left = left % right
    }
  }

  private parseUnary(): number {
    const op = this.peek()
    if (op === '-') {
      this.pos++
      return -this.parseUnary()
    }
    if (op === '+') {
      this.pos++
      return this.parseUnary()
    }
    return this.parsePower()
  }

  private parsePower(): number {
    const base = this.parsePrimary()
    if (this.peek() !== '^') return base
    this.pos++
    const value = base ** this.parseUnary()
    if (!Number.isFinite(value)) {
      throw new Error('Exponentiation overflowed to a non-finite number')
    }
    return value
  }

  private parsePrimary(): number {
    const char = this.peek()
    if (char === '') throw new Error('Unexpected end of expression')
    if (char === '(') {
      this.pos++
      const value = this.parseExpression()
      if (!this.eat(')')) throw new Error('Missing closing parenthesis')
      return value
    }
    if (isDigit(char) || char === '.') return this.parseNumber()
    if (isAlpha(char)) return this.parseIdentifier()
    throw new Error(`Unexpected "${char}" at position ${this.pos}`)
  }

  private parseNumber(): number {
    const start = this.pos
    while (this.pos < this.source.length && (isDigit(this.source[this.pos]) || this.source[this.pos] === '.')) {
      this.pos++
    }
    const exponent = this.source[this.pos]
    if (exponent === 'e' || exponent === 'E') {
      this.pos++
      const sign = this.source[this.pos]
      if (sign === '+' || sign === '-') this.pos++
      while (this.pos < this.source.length && isDigit(this.source[this.pos])) this.pos++
    }
    const text = this.source.slice(start, this.pos)
    const value = Number(text)
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid number "${text}"`)
    }
    return value
  }

  private parseIdentifier(): number {
    const start = this.pos
    while (this.pos < this.source.length && isIdentifierChar(this.source[this.pos])) this.pos++
    const name = this.source.slice(start, this.pos).toLowerCase()

    if (this.peek() === '(') {
      this.pos++
      const args: number[] = []
      if (this.peek() !== ')') {
        args.push(this.parseExpression())
        while (this.eat(',')) args.push(this.parseExpression())
      }
      if (!this.eat(')')) throw new Error(`Missing closing parenthesis for ${name}(`)
      const fn = FUNCTIONS[name]
      if (!fn) throw new Error(`Unknown function "${name}"`)
      const value = fn(...args)
      if (Number.isNaN(value)) {
        throw new Error(`${name}(${args.join(', ')}) is undefined`)
      }
      if (!Number.isFinite(value)) {
        throw new Error(`${name}(${args.join(', ')}) overflowed`)
      }
      return value
    }

    const constant = CONSTANTS[name]
    if (constant === undefined) throw new Error(`Unknown identifier "${name}"`)
    return constant
  }

  private peek(): string {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos] as string)) this.pos++
    return this.source[this.pos] ?? ''
  }

  private eat(char: string): boolean {
    if (this.peek() !== char) return false
    this.pos++
    return true
  }
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function isAlpha(char: string | undefined): boolean {
  return char !== undefined && ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_')
}

function isIdentifierChar(char: string | undefined): boolean {
  return isAlpha(char) || isDigit(char)
}

/** Evaluate an arithmetic expression. Throws on anything malformed. */
export function evaluateExpression(expression: string): number {
  return new ExpressionParser(expression).parse()
}

export const calculatorTool: Tool<{ expression: string }> = {
  name: 'calculator',
  description:
    'Evaluate an arithmetic expression exactly. Use this instead of doing mental math. ' +
    'Supports + - * / % ^, parentheses, the functions sqrt/abs/round/floor/ceil/min/max/pow/log/sin/cos/tan, ' +
    'and the constants pi and e.',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The expression to evaluate, e.g. "(12 + 8) / 4 * 3".',
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  execute({ expression }) {
    if (typeof expression !== 'string' || expression.trim() === '') {
      throw new Error('"expression" must be a non-empty string')
    }
    const value = evaluateExpression(expression)
    return `${expression.trim()} = ${value}`
  },
}
