import { TextDecoder } from "node:util";

const STRICT_JSON_MAX_BYTES = 262_144;
const STRICT_JSON_MAX_DEPTH = 16;
const STRICT_JSON_MAX_KEYS = 2_048;
const STRICT_JSON_MAX_ITEMS = 2_048;
const STRICT_JSON_MAX_STRING_BYTES = 4_096;

export interface StrictJsonLimits {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxItems: number;
  readonly maxStringBytes: number;
}

const DEFAULT_LIMITS: StrictJsonLimits = Object.freeze({
  maxDepth: STRICT_JSON_MAX_DEPTH,
  maxKeys: STRICT_JSON_MAX_KEYS,
  maxItems: STRICT_JSON_MAX_ITEMS,
  maxStringBytes: STRICT_JSON_MAX_STRING_BYTES,
});

export type StrictJsonErrorReason = "utf8" | "bom" | "syntax" | "duplicate" | "control" | "limit" | "number";

export class StrictJsonError extends Error {
  readonly reason: StrictJsonErrorReason;
  readonly offset: number;

  constructor(reason: StrictJsonErrorReason, message: string, offset: number) {
    super(message);
    this.name = "StrictJsonError";
    this.reason = reason;
    this.offset = offset;
  }
}

function hasValidUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code >= 0xdc00 || index + 1 >= value.length) return false;
    const next = value.charCodeAt(index + 1);
    if (next < 0xdc00 || next > 0xdfff) return false;
    index += 1;
  }
  return true;
}

function hasAllowedControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
    if (code >= 0x7f && code <= 0x9f) return false;
  }
  return true;
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function validateStringLimits(value: string, maxBytes = STRICT_JSON_MAX_STRING_BYTES): boolean {
  return hasValidUnicodeScalars(value)
    && hasAllowedControls(value)
    && byteLength(value) <= maxBytes;
}

export function decodeStrictUtf8(input: Uint8Array | string): { readonly bytes: Buffer; readonly text: string } {
  const bytes = typeof input === "string"
    ? (() => {
        if (!hasValidUnicodeScalars(input)) throw new StrictJsonError("utf8", "input contains unpaired Unicode", 0);
        return Buffer.from(input, "utf8");
      })()
    : Buffer.from(input);
  if (bytes.byteLength > STRICT_JSON_MAX_BYTES) {
    throw new StrictJsonError("limit", "JSON input exceeds byte limit", 0);
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StrictJsonError("bom", "UTF-8 BOM is not permitted", 0);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StrictJsonError("utf8", "input is not valid UTF-8", 0);
  }
  if (text.startsWith("\ufeff") || !hasValidUnicodeScalars(text)) {
    throw new StrictJsonError("utf8", "input contains invalid Unicode", 0);
  }
  return { bytes, text };
}

class StrictJsonParser {
  private readonly text: string;
  private readonly limits: StrictJsonLimits;
  private position = 0;
  private keyCount = 0;
  private itemCount = 0;

  constructor(text: string, limits: StrictJsonLimits = DEFAULT_LIMITS) {
    this.text = text;
    this.limits = limits;
  }

  parse(): unknown {
    this.skipWhitespace();
    const result = this.parseValue(0);
    this.skipWhitespace();
    if (this.position !== this.text.length) this.fail("syntax", "trailing JSON data");
    return result;
  }

  private fail(reason: StrictJsonErrorReason, message: string): never {
    throw new StrictJsonError(reason, message, this.position);
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length) {
      const code = this.text.charCodeAt(this.position);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      this.position += 1;
    }
  }

  private parseValue(depth: number): unknown {
    if (depth > this.limits.maxDepth) this.fail("limit", "JSON nesting depth exceeds limit");
    const character = this.text[this.position];
    if (character === "{") return this.parseObject(depth);
    if (character === "[") return this.parseArray(depth);
    if (character === '"') return this.parseString();
    if (character === "t" && this.consumeLiteral("true")) return true;
    if (character === "f" && this.consumeLiteral("false")) return false;
    if (character === "n" && this.consumeLiteral("null")) return null;
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) return this.parseNumber();
    this.fail("syntax", "expected a JSON value");
  }

  private consumeLiteral(literal: string): boolean {
    if (this.text.slice(this.position, this.position + literal.length) !== literal) {
      this.fail("syntax", "invalid JSON literal");
    }
    this.position += literal.length;
    return true;
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.position += 1;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    this.skipWhitespace();
    if (this.text[this.position] === "}") {
      this.position += 1;
      return result;
    }
    while (this.position < this.text.length) {
      if (this.text[this.position] !== '"') this.fail("syntax", "object keys must be JSON strings");
      const key = this.parseString();
      if (Object.prototype.hasOwnProperty.call(result, key)) this.fail("duplicate", "duplicate object key");
      this.keyCount += 1;
      if (this.keyCount > this.limits.maxKeys) this.fail("limit", "JSON key count exceeds limit");
      this.skipWhitespace();
      if (this.text[this.position] !== ":") this.fail("syntax", "expected ':' after object key");
      this.position += 1;
      this.skipWhitespace();
      const value = this.parseValue(depth + 1);
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      this.skipWhitespace();
      const delimiter = this.text[this.position];
      if (delimiter === "}") {
        this.position += 1;
        return result;
      }
      if (delimiter !== ",") this.fail("syntax", "expected ',' or '}' in object");
      this.position += 1;
      this.skipWhitespace();
    }
    this.fail("syntax", "unterminated JSON object");
  }

  private parseArray(depth: number): unknown[] {
    this.position += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.position] === "]") {
      this.position += 1;
      return result;
    }
    while (this.position < this.text.length) {
      this.itemCount += 1;
      if (this.itemCount > this.limits.maxItems) this.fail("limit", "JSON item count exceeds limit");
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const delimiter = this.text[this.position];
      if (delimiter === "]") {
        this.position += 1;
        return result;
      }
      if (delimiter !== ",") this.fail("syntax", "expected ',' or ']' in array");
      this.position += 1;
      this.skipWhitespace();
    }
    this.fail("syntax", "unterminated JSON array");
  }

  private parseString(): string {
    if (this.text[this.position] !== '"') this.fail("syntax", "expected JSON string");
    this.position += 1;
    let result = "";
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (character === '"') {
        this.position += 1;
        if (!validateStringLimits(result, this.limits.maxStringBytes)) this.fail("control", "string contains forbidden Unicode/control data or exceeds limit");
        return result;
      }
      if (character === "\\") {
        this.position += 1;
        const escape = this.text[this.position];
        if (escape === undefined) this.fail("syntax", "unterminated JSON escape");
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (Object.prototype.hasOwnProperty.call(simple, escape)) {
          result += simple[escape]!;
          this.position += 1;
          continue;
        }
        if (escape !== "u") this.fail("syntax", "invalid JSON escape");
        const hex = this.text.slice(this.position + 1, this.position + 5);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) this.fail("syntax", "invalid Unicode escape");
        result += String.fromCharCode(Number.parseInt(hex, 16));
        this.position += 5;
        continue;
      }
      const code = this.text.charCodeAt(this.position);
      if (code < 0x20) this.fail("control", "unescaped JSON control character");
      result += character;
      this.position += 1;
    }
    this.fail("syntax", "unterminated JSON string");
  }

  private parseNumber(): number {
    const start = this.position;
    if (this.text[this.position] === "-") this.position += 1;
    if (this.text[this.position] === "0") {
      this.position += 1;
    } else {
      const first = this.text.charCodeAt(this.position);
      if (first < 0x31 || first > 0x39) this.fail("syntax", "invalid JSON number");
      while (this.position < this.text.length) {
        const code = this.text.charCodeAt(this.position);
        if (code < 0x30 || code > 0x39) break;
        this.position += 1;
      }
    }
    if (this.text[this.position] === ".") {
      this.position += 1;
      const fractionStart = this.position;
      while (this.position < this.text.length) {
        const code = this.text.charCodeAt(this.position);
        if (code < 0x30 || code > 0x39) break;
        this.position += 1;
      }
      if (fractionStart === this.position) this.fail("syntax", "JSON number fraction is empty");
    }
    const exponent = this.text[this.position];
    if (exponent === "e" || exponent === "E") {
      this.position += 1;
      if (this.text[this.position] === "+" || this.text[this.position] === "-") this.position += 1;
      const exponentStart = this.position;
      while (this.position < this.text.length) {
        const code = this.text.charCodeAt(this.position);
        if (code < 0x30 || code > 0x39) break;
        this.position += 1;
      }
      if (exponentStart === this.position) this.fail("syntax", "JSON number exponent is empty");
    }
    const token = this.text.slice(start, this.position);
    const value = Number(token);
    if (!Number.isFinite(value)) this.fail("number", "JSON number is outside finite range");
    return value;
  }
}

export function parseStrictJsonValue(input: Uint8Array | string, limits: StrictJsonLimits = DEFAULT_LIMITS): unknown {
  const { text } = decodeStrictUtf8(input);
  return new StrictJsonParser(text, limits).parse();
}
