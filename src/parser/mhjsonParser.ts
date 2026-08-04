/**
 * Mindustry-HJSON parser.
 *
 * This is a hand-rolled recursive-descent parser modeled directly on
 * arc.util.serialization.JvalReader (Mindustry's own HJSON reader), NOT the
 * stock `hjson` npm package. The two differ in a few important ways that
 * Mindustry mods rely on:
 *
 *  - Root braces are optional: a file can start straight with `key: value`
 *    pairs with no enclosing `{ }`.
 *  - Commas are always optional as separators in arrays/objects (newline is
 *    enough), but ARE treated as a value terminator inside a container, so
 *    `[a, b, c]` on one line works.
 *  - Unquoted ("quoteless"/TFNNS - True/False/Null/Number/String) scalars are
 *    supported both as bare values (`key: bare value`) and, unlike stock
 *    HJSON, *inside* single-line arrays/objects: `[string1, string2, string3]`
 *    and `{a: aval, b: bval, c: cval}` are both legal, with the quoteless
 *    string terminated by the `,`, `]`, or `}` rather than requiring its own
 *    line.
 *  - Comments: `#`, `//`, and `/* *\/`.
 *  - Triple-quoted multiline strings: `'''...'''`.
 *
 * Every AST node keeps a source [start, end) offset range so the rest of the
 * extension (diagnostics, hover, completion) can map back into the document.
 */

export type JvalType = 'object' | 'array' | 'string' | 'double' | 'long' | 'boolean' | 'null';

export interface Range {
	/** 0-based character offset, inclusive. */
	start: number;
	/** 0-based character offset, exclusive. */
	end: number;
}

export interface JvalBase {
	type: JvalType;
	range: Range;
	/** Range of just the value's own tokens (same as `range` for scalars). */
	valueRange: Range;
}

export interface JvalObject extends JvalBase {
	type: 'object';
	/** Insertion-ordered entries. Duplicate keys are kept (last one "wins" per Mindustry's putAdd-merge semantics for objects, overwrite otherwise) but both are retained here for diagnostics. */
	entries: JvalMember[];
}

export interface JvalMember {
	key: string;
	keyRange: Range;
	value: Jval;
}

export interface JvalArray extends JvalBase {
	type: 'array';
	elements: Jval[];
}

export interface JvalString extends JvalBase {
	type: 'string';
	value: string;
	/** true if this was a quoted ("...", '...') or triple-quoted string, as opposed to a bare/quoteless token. */
	quoted: boolean;
}

export interface JvalNumber extends JvalBase {
	type: 'double' | 'long';
	value: number;
	raw: string;
}

export interface JvalBoolean extends JvalBase {
	type: 'boolean';
	value: boolean;
}

export interface JvalNull extends JvalBase {
	type: 'null';
}

export type Jval = JvalObject | JvalArray | JvalString | JvalNumber | JvalBoolean | JvalNull;

export interface ParseComment {
	range: Range;
	text: string;
}

export interface ParseError {
	message: string;
	range: Range;
}

export interface ParseResult {
	root: Jval | undefined;
	errors: ParseError[];
	comments: ParseComment[];
}

const PUNCTUATORS = new Set(['{', '}', '[', ']', ',', ':']);

function isPunctuatorChar(ch: string): boolean {
	return PUNCTUATORS.has(ch);
}

function isDigit(ch: string): boolean {
	return ch >= '0' && ch <= '9';
}

function isWhiteSpace(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Matches java's String.trim(): trims any char <= 0x20. */
function isTrimChar(ch: string): boolean {
	return ch.charCodeAt(0) <= 0x20;
}

class ParseException extends Error {
	constructor(message: string, public range: Range) {
		super(message);
	}
}

export function parseMHJson(text: string): ParseResult {
	return new Parser(text).parse();
}

class Parser {
	private buffer: string;
	private length: number;
	private index = 0; // index of next char to read
	private current = -1; // char code at position (index-1), or -1 at EOF
	private inContainer = false;
	private errors: ParseError[] = [];
	private comments: ParseComment[] = [];

	constructor(text: string) {
		this.buffer = text;
		this.length = text.length;
	}

	parse(): ParseResult {
		try {
			this.read();
			this.skipWhiteSpace();
			let root: Jval;
			if (this.current === '{'.charCodeAt(0) || this.current === '['.charCodeAt(0)) {
				root = this.readValue();
			} else {
				// try: root object without braces
				const savedIndex = this.index;
				try {
					root = this.readObject(true);
					this.checkTrailing();
					return { root, errors: this.errors, comments: this.comments };
				} catch (e) {
					// fall back: maybe it's a single bare scalar
					this.index = 0;
					this.errors = [];
					this.read();
					this.skipWhiteSpace();
					try {
						root = this.readValue();
						this.checkTrailing();
						return { root, errors: this.errors, comments: this.comments };
					} catch (e2) {
						this.pushError(e instanceof ParseException ? e : e2 as ParseException);
						return { root: undefined, errors: this.errors, comments: this.comments };
					}
				}
			}
			this.checkTrailing();
			return { root, errors: this.errors, comments: this.comments };
		} catch (e) {
			this.pushError(e as ParseException);
			return { root: undefined, errors: this.errors, comments: this.comments };
		}
	}

	private pushError(e: ParseException | Error) {
		if (e instanceof ParseException) {
			this.errors.push({ message: e.message, range: e.range });
		} else {
			this.errors.push({ message: e.message, range: { start: this.index, end: this.index + 1 } });
		}
	}

	private checkTrailing() {
		this.skipWhiteSpace();
		if (!this.isEndOfText()) {
			throw this.error(`Extra characters in input: ${this.currentChar()}`);
		}
	}

	// ---- low level char handling -----------------------------------------

	private currentChar(): string {
		return this.current < 0 ? '' : String.fromCharCode(this.current);
	}

	private isEndOfText(): boolean {
		return this.current === -1;
	}

	private read() {
		if (this.index >= this.length) {
			this.current = -1;
			return;
		}
		this.current = this.buffer.charCodeAt(this.index++);
	}

	private peek(): string {
		return this.index < this.length ? this.buffer[this.index] : '';
	}

	private error(message: string): ParseException {
		const pos = Math.max(0, this.index - 1);
		return new ParseException(message, { start: pos, end: pos + 1 });
	}

	private expected(what: string): ParseException {
		return this.isEndOfText()
			? this.error(`Unexpected end of input, expected ${what}`)
			: this.error(`Expected ${what}`);
	}

	private readIf(ch: string): boolean {
		if (this.current !== ch.charCodeAt(0)) return false;
		this.read();
		return true;
	}

	private skipWhiteSpace() {
		while (true) {
			if (isWhiteSpace(this.currentChar())) {
				this.read();
			} else if (this.current === '#'.charCodeAt(0)) {
				this.skipLineComment(1);
			} else if (this.current === '/'.charCodeAt(0) && this.peek() === '/') {
				this.skipLineComment(2);
			} else if (this.current === '/'.charCodeAt(0) && this.peek() === '*') {
				this.skipBlockComment();
			} else {
				break;
			}
		}
	}

	private skipLineComment(prefixLen: number) {
		const start = this.index - 1;
		for (let i = 1; i < prefixLen; i++) this.read();
		while (this.current !== -1 && this.current !== '\n'.charCodeAt(0)) this.read();
		this.comments.push({ range: { start, end: this.index - 1 }, text: this.buffer.slice(start, this.index - 1) });
	}

	private skipBlockComment() {
		const start = this.index - 1;
		this.read(); // consume '*'
		this.read();
		while (true) {
			if (this.current === -1) throw this.error('Unterminated block comment');
			if (this.current === '*'.charCodeAt(0) && this.peek() === '/') {
				this.read();
				this.read();
				break;
			}
			this.read();
		}
		this.comments.push({ range: { start, end: this.index }, text: this.buffer.slice(start, this.index) });
	}

	// ---- value dispatch -----------------------------------------------------

	private readValue(): Jval {
		const ch = this.currentChar();
		if (ch === '"' || ch === "'") return this.readString();
		if (ch === '[') return this.readArray();
		if (ch === '{') return this.readObject(false);
		return this.readTfnns();
	}

	/** True / False / Null / Number / quoteless-String */
	private readTfnns(): Jval {
		const start = this.index - 1;
		const first = this.currentChar();
		if (isPunctuatorChar(first)) {
			throw this.error(`Found a punctuator character '${first}' when expecting a quoteless string (check your syntax)`);
		}

		while (true) {
			this.read();
			const cur = this.currentChar();
			const isComment = this.current === '#'.charCodeAt(0) || (this.current === '/'.charCodeAt(0) && (this.peek() === '/' || this.peek() === '*'));
			const isEol =
				this.current === -1 ||
				cur === '\r' ||
				cur === '\n' ||
				(cur === ',' && this.inContainer) ||
				cur === ']' ||
				cur === '}' ||
				isComment;

			if (isEol || cur === ',') {
				const stop = this.current === -1 ? this.index : this.index - 1;

				if (first === 'f' || first === 'n' || first === 't') {
					let s = start, e = stop;
					while (s < e && isTrimChar(this.buffer[s])) s++;
					while (e > s && isTrimChar(this.buffer[e - 1])) e--;
					const len = e - s;
					const slice = this.buffer.slice(s, e);
					if (len === 5 && slice === 'false') return this.mk<JvalBoolean>({ type: 'boolean', value: false }, start, stop);
					if (len === 4 && slice === 'null') return this.mk<JvalNull>({ type: 'null' }, start, stop);
					if (len === 4 && slice === 'true') return this.mk<JvalBoolean>({ type: 'boolean', value: true }, start, stop);
				} else if (first === '-' || (first >= '0' && first <= '9')) {
					const n = tryParseNumber(this.buffer, start, stop);
					if (n) return this.mk<JvalNumber>({ type: n.isDecimal ? 'double' : 'long', value: n.value, raw: n.raw }, start, stop);
				}

				if (isEol) {
					let end = stop;
					if (end > start && this.buffer[end - 1] === ',') end--;
					let s = start, e = end;
					while (s < e && isTrimChar(this.buffer[s])) s++;
					while (e > s && isTrimChar(this.buffer[e - 1])) e--;
					return this.mk<JvalString>({ type: 'string', value: this.buffer.slice(s, e), quoted: false }, start, end);
				}
			}
		}
	}

	private mk<T extends JvalBase>(partial: Omit<T, 'range' | 'valueRange'>, start: number, end: number): T {
		const range = { start, end };
		return { ...(partial as any), range, valueRange: range } as T;
	}

	private recoverToMemberBoundary(closingChar: string | undefined) {
		while (!this.isEndOfText()) {
			const ch = this.currentChar();
			if (ch === ',') {
				this.read();
				return;
			}
			if (closingChar && ch === closingChar) return; // don't consume; let the caller's own check handle it
			if (ch === '\n') {
				this.read();
				return;
			}
			this.read();
		}
	}

	private readArray(): JvalArray {
		const start = this.index - 1;
		const previousInContainer = this.inContainer;
		this.inContainer = true;
		this.read();
		const elements: Jval[] = [];
		this.skipWhiteSpace();
		if (this.readIf(']')) {
			this.inContainer = previousInContainer;
			return this.mk<JvalArray>({ type: 'array', elements }, start, this.index);
		}
		while (true) {
			this.skipWhiteSpace();
			if (this.isEndOfText()) throw this.error("End of input while parsing an array (did you forget a closing ']'?)");
			try {
				elements.push(this.readValue());
				this.skipWhiteSpace();
				if (this.readIf(',')) this.skipWhiteSpace();
				if (this.readIf(']')) break;
				else if (this.isEndOfText()) throw this.error("End of input while parsing an array (did you forget a closing ']'?)");
			} catch (e) {
				this.pushError(e instanceof ParseException ? e : this.error(String((e as Error).message)));
				if (this.isEndOfText()) break;
				this.recoverToMemberBoundary(']');
				if (this.readIf(']')) break;
			}
		}
		this.inContainer = previousInContainer;
		return this.mk<JvalArray>({ type: 'array', elements }, start, this.index);
	}

	private readObject(objectWithoutBraces: boolean): JvalObject {
		const start = this.index - 1;
		const previousInContainer = this.inContainer;
		if (!objectWithoutBraces) this.inContainer = true;
		if (!objectWithoutBraces) this.read();
		const entries: JvalMember[] = [];
		this.skipWhiteSpace();
		while (true) {
			if (objectWithoutBraces) {
				if (this.isEndOfText()) break;
			} else {
				if (this.isEndOfText()) throw this.error("End of input while parsing an object (did you forget a closing '}'?)");
				if (this.readIf('}')) break;
			}
			const keyStart = this.index - 1;
			try {
				const name = this.readName();
				const keyRange = { start: keyStart, end: this.index - 1 };
				this.skipWhiteSpace();
				if (!this.readIf(':')) throw this.expected("':'");
				this.skipWhiteSpace();
				const value = this.readValue();
				entries.push({ key: name, keyRange, value });
				this.skipWhiteSpace();
				if (this.readIf(',')) this.skipWhiteSpace();
			} catch (e) {
				this.pushError(e instanceof ParseException ? e : this.error(String((e as Error).message)));
				if (this.isEndOfText()) break;
				this.recoverToMemberBoundary(objectWithoutBraces ? undefined : '}');
				this.skipWhiteSpace();
			}
		}
		this.inContainer = previousInContainer;
		return this.mk<JvalObject>({ type: 'object', entries }, start, this.index);
	}

	private readName(): string {
		if (this.currentChar() === '"' || this.currentChar() === "'") return this.readStringInternal(false);

		let name = '';
		let space = -1;
		const start = this.index - 1;
		while (true) {
			if (this.current === -1) {
				throw this.error("Unexpected end of input while reading a key name (expected ':')");
			}
			const ch = this.currentChar();
			if (ch === ':') {
				if (name.length === 0) throw this.error("Found ':' but no key name (for an empty key name use quotes)");
				else if (space >= 0 && space !== name.length) {
					this.index = start + space;
					throw this.error('Found whitespace in your key name (use quotes to include)');
				}
				return name;
			} else if (isWhiteSpace(ch)) {
				if (space < 0) space = name.length;
			} else if (this.current !== -1 && this.current < 0x20) {
				throw this.error('Name is not closed');
			} else if (isPunctuatorChar(ch)) {
				throw this.error(`Found '${ch}' where a key name was expected (check your syntax or use quotes if the key name includes {}[],: or whitespace)`);
			} else {
				name += ch;
			}
			this.read();
		}
	}

	private readString(): JvalString {
		const start = this.index - 1;
		const value = this.readStringInternal(true);
		return this.mk<JvalString>({ type: 'string', value, quoted: true }, start, this.index);
	}

	private readStringInternal(allowML: boolean): string {
		const exitCh = this.currentChar();
		this.read();
		let captured = '';
		while (this.current !== -1 && this.currentChar() !== exitCh) {
			if (this.currentChar() === '\\') {
				captured += this.readEscape();
			} else {
				captured += this.currentChar();
				this.read();
			}
		}
		this.read(); // consume closing quote

		if (allowML && exitCh === "'" && this.currentChar() === "'" && captured.length === 0) {
			this.read();
			return this.readMlString();
		}
		return captured;
	}

	private readEscape(): string {
		this.read(); // consume backslash, current -> escape designator
		const ch = this.currentChar();
		let out: string;
		switch (ch) {
			case '"': case "'": case '#': case '/': case '\\': out = ch; break;
			case 'b': out = '\b'; break;
			case 'f': out = '\f'; break;
			case 'n': out = '\n'; break;
			case 'r': out = '\r'; break;
			case 't': out = '\t'; break;
			case 'u': {
				const hex = this.buffer.slice(this.index, this.index + 4);
				out = String.fromCharCode(parseInt(hex, 16) || 0);
				for (let i = 0; i < 4; i++) this.read();
				this.read();
				return out;
			}
			default:
				throw this.error(`Expected a valid escape sequence, got '\\${ch}'`);
		}
		this.read();
		return out;
	}

	private readMlString(): string {
		let sb = '';
		let triple = 0;
		// index-lineOffset tracking is not needed for correctness here (only affects dedent);
		// approximate indent using column of the opening ''' on its line.
		const lineStart = this.buffer.lastIndexOf('\n', this.index - 1) + 1;
		const indent = Math.max(0, (this.index - 4) - lineStart);

		while (isWhiteSpace(this.currentChar()) && this.currentChar() !== '\n') this.read();
		if (this.currentChar() === '\n') {
			this.read();
			this.skipIndent(indent);
		}

		while (true) {
			if (this.current === -1) throw this.error('Bad multiline string');
			if (this.currentChar() === "'") {
				triple++;
				this.read();
				if (triple === 3) {
					if (sb.endsWith('\n')) sb = sb.slice(0, -1);
					return sb;
				}
				continue;
			} else {
				while (triple > 0) { sb += "'"; triple--; }
			}
			if (this.currentChar() === '\n') {
				sb += '\n';
				this.read();
				this.skipIndent(indent);
			} else {
				if (this.currentChar() !== '\r') sb += this.currentChar();
				this.read();
			}
		}
	}

	private skipIndent(indent: number) {
		while (indent-- > 0) {
			if (isWhiteSpace(this.currentChar()) && this.currentChar() !== '\n') this.read();
			else break;
		}
	}
}

function tryParseNumber(buf: string, from: number, to: number): { value: number; isDecimal: boolean; raw: string } | null {
	let idx = from;
	const len = to;
	if (idx < len && buf[idx] === '-') idx++;
	if (idx >= len) return null;
	const first = buf[idx++];
	if (!isDigit(first)) return null;
	if (first === '0' && idx < len && isDigit(buf[idx])) return null; // leading zero disallowed

	while (idx < len && isDigit(buf[idx])) idx++;

	if (idx < len && buf[idx] === '.') {
		idx++;
		if (idx >= len || !isDigit(buf[idx++])) return null;
		while (idx < len && isDigit(buf[idx])) idx++;
	}

	if (idx < len && (buf[idx] === 'e' || buf[idx] === 'E')) {
		idx++;
		if (idx < len && (buf[idx] === '+' || buf[idx] === '-')) idx++;
		if (idx >= len || !isDigit(buf[idx++])) return null;
		while (idx < len && isDigit(buf[idx])) idx++;
	}

	const last = idx;
	while (idx < len && isWhiteSpace(buf[idx])) idx++;
	if (idx < len) return null; // trailing junk before `to` -> not a clean number token

	let isDecimal = false;
	for (let i = from; i < last; i++) {
		const c = buf[i];
		if (c === '.' || c === 'e' || c === 'E') { isDecimal = true; break; }
	}

	const str = buf.slice(from, last);
	const value = Number(str);
	if (Number.isNaN(value)) return null;
	return { value, isDecimal, raw: str };
}
