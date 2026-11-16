import { assertText, encode, decode, sameBytes, concatBytes, createCoordinateAdapter } from './coordinates.js';
import { digestBytes } from './digest.js';
import { defaultDisplayAdapters } from './display.js';

const DEFAULT_LIMITS = Object.freeze({ maxBaseBytes: 4 * 1024 * 1024, maxViewBytes: 8 * 1024 * 1024,
  maxOperations: 1000, maxHistory: 100, maxSerializedBytes: 16 * 1024 * 1024 });
const copy = (value) => JSON.parse(JSON.stringify(value));
const sequence = (id) => Number(id.slice(11));
const validId = (id) => typeof id === 'string' && /^suggestion-[1-9][0-9]*$/.test(id) && Number.isSafeInteger(sequence(id));
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const isDeleted = (piece) => piece.kind === 'base' && piece.id !== null;
const modified = (piece) => piece.kind === 'insert' || isDeleted(piece);
const liveLength = (piece) => piece.kind === 'insert' ? encode(piece.text).length : piece.id === null ? piece.end - piece.start : 0;
const freezeOperations = (operations) => Object.freeze(operations.map((op) => Object.freeze({ ...op })));

/** Pure, scalar-safe piece table. A base piece is retained even when deleted (a tombstone). */
export class SuggestionLedger {
  #base; #baseCoordinates; #identity; #pieces; #metadata = {}; #nextSequence = 1;
  #undo = []; #redo = []; #clock; #limits;

  constructor(baseBytes, identity, { clock = () => new Date().toISOString(), limits = {} } = {}) {
    if (!(baseBytes instanceof Uint8Array)) throw new TypeError('Base must be UTF-8 Uint8Array');
    if (!keysAre(identity, ['path', 'byteLength', 'digest']) || typeof identity.path !== 'string' ||
        !identity.path || identity.path.includes('\0') || identity.byteLength !== baseBytes.length ||
        typeof identity.digest !== 'string') throw new TypeError('Invalid base identity');
    if (typeof clock !== 'function') throw new TypeError('Clock must be a function');
    if (!limits || typeof limits !== 'object' || Array.isArray(limits) ||
        Object.keys(limits).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key))) throw new TypeError('Unknown limits');
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    for (const value of Object.values(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Limits must be positive safe integers');
    }
    if (baseBytes.length > this.#limits.maxBaseBytes || baseBytes.length > this.#limits.maxViewBytes) {
      throw new RangeError('Base exceeds byte limit');
    }
    decode(baseBytes); // Fatal UTF-8 decode; BOM is content, not an encoding instruction.
    if (digestBytes(baseBytes) !== identity.digest) throw new Error('Base digest mismatch');
    this.#base = new Uint8Array(baseBytes);
    this.#baseCoordinates = createCoordinateAdapter(this.#base);
    this.#identity = Object.freeze({ ...identity });
    this.#clock = clock;
    this.#pieces = baseBytes.length ? [{ kind: 'base', start: 0, end: baseBytes.length, id: null }] : [];
  }

  get baseIdentity() { return this.#identity; }
  get baseBytes() { return this.#base.slice(); }
  get currentText() { return decode(this.#viewBytes()); }
  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }
  get metadata() {
    return Object.freeze(Object.fromEntries(Object.entries(this.#metadata)
      .map(([id, value]) => [id, Object.freeze({ ...value })])));
  }

  coordinates(space = 'view') {
    this.#checkSpace(space);
    return space === 'base' ? this.#baseCoordinates : createCoordinateAdapter(this.#viewBytes());
  }

  /** Maps an original byte boundary through suggestions; interior deleted points use affinity. */
  baseToView(offset, affinity = 'right') {
    this.coordinates('base').byteToUtf16(offset);
    if (affinity !== 'left' && affinity !== 'right') throw new TypeError('Invalid affinity');
    let delta = 0;
    for (const op of this.toOperations()) {
      const start = op.start + delta, length = encode(op.replacement).length;
      if (offset < op.start) return offset + delta;
      if (offset === op.start || (offset > op.start && offset < op.end)) {
        return start + (affinity === 'right' ? length : 0);
      }
      delta += length - (op.end - op.start);
    }
    return offset + delta;
  }

  insert(at, text, options = {}) { return this.replace({ start: at, end: at }, text, options); }
  delete(range, options = {}) { return this.replace(range, '', options); }
  replace({ start, end }, text, { space = 'view', comment = '' } = {}) {
    this.#checkSpace(space);
    assertText(text); assertText(comment);
    const coordinates = this.coordinates(space);
    coordinates.byteToUtf16(start); coordinates.byteToUtf16(end);
    if (end < start) throw new RangeError('Range end precedes start');
    if (space === 'base') {
      if (start === end) start = end = this.baseToView(start, 'right');
      else {
        const interior = this.toOperations().some((op) => op.start < end && end < op.end);
        end = this.baseToView(end, interior ? 'right' : 'left');
        start = this.baseToView(start, 'left');
      }
    }
    const current = this.#viewBytes();
    const inserted = encode(text);
    if (sameBytes(current.subarray(start, end), inserted)) return false;
    if (current.length - (end - start) + inserted.length > this.#limits.maxViewBytes) {
      throw new RangeError('View exceeds byte limit');
    }
    return this.#commit(() => {
      if (this.#nextSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError('Suggestion sequence exhausted');
      const affected = [];
      let delta = 0;
      for (const op of this.toOperations()) {
        const viewStart = op.start + delta, viewEnd = viewStart + encode(op.replacement).length;
        if (viewStart <= end && viewEnd >= start) affected.push(op.operationId);
        delta += encode(op.replacement).length - (op.end - op.start);
      }
      affected.sort((a, b) => sequence(a) - sequence(b));
      const affectedIds = new Set(affected);
      const id = affected[0] ?? `suggestion-${this.#nextSequence++}`;
      const createdAt = affected.length ? this.#metadata[id].createdAt : this.#clock();
      if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new TypeError('Clock must return a timestamp string');
      const comments = [...affected.map((key) => this.#metadata[key].comment), comment].filter(Boolean);
      this.#metadata[id] = { comment: [...new Set(comments)].join('\n'), createdAt };
      this.#splitAt(start); this.#splitAt(end);
      const output = [];
      let cursor = 0, insertedOnce = false;
      for (const piece of this.#pieces) {
        if (!insertedOnce && cursor === start) {
          if (text) output.push({ kind: 'insert', text, id });
          insertedOnce = true;
        }
        const length = liveLength(piece);
        if (length && cursor >= start && cursor < end) {
          if (piece.kind === 'base') output.push({ ...piece, id });
          // Inserted text is removed, never recorded as deleted original text.
        } else output.push(modified(piece) && affectedIds.has(piece.id) ? { ...piece, id } : piece);
        cursor += length;
      }
      if (!insertedOnce && text) output.push({ kind: 'insert', text, id });
      this.#pieces = output;
      this.#normalize();
    });
  }

  setComment(suggestionId, comment) {
    assertText(comment);
    if (!Object.hasOwn(this.#metadata, suggestionId)) throw new RangeError('Unknown suggestion');
    if (this.#metadata[suggestionId].comment === comment) return false;
    return this.#commit(() => { this.#metadata[suggestionId].comment = comment; });
  }

  discard(suggestionId) {
    if (!Object.hasOwn(this.#metadata, suggestionId)) throw new RangeError('Unknown suggestion');
    return this.#commit(() => {
      const operations = this.toOperations().filter((op) => op.operationId !== suggestionId);
      delete this.#metadata[suggestionId];
      this.#pieces = this.#piecesFromOperations(operations);
      this.#normalize();
    });
  }

  undo() {
    if (!this.canUndo) return false;
    this.#redo.push(this.#snapshot());
    this.#restore(this.#undo.pop());
    return true;
  }
  redo() {
    if (!this.canRedo) return false;
    this.#undo.push(this.#snapshot());
    this.#restore(this.#redo.pop());
    return true;
  }

  toOperations() {
    const operations = [];
    let group = null, baseCursor = 0;
    const flush = () => {
      if (!group) return;
      operations.push({ operationId: group.id, start: group.start, end: baseCursor,
        expected: decode(this.#base.subarray(group.start, baseCursor)), replacement: group.text });
      group = null;
    };
    for (const piece of this.#pieces) {
      if (!modified(piece)) { flush(); baseCursor = piece.end; continue; }
      if (!group) group = { id: piece.id, start: baseCursor, text: '' };
      if (piece.kind === 'insert') group.text += piece.text;
      else baseCursor = piece.end;
    }
    flush();
    return freezeOperations(operations);
  }

  /** Constructed only from original byte slices and declared replacement bytes. */
  toCandidateBytes() {
    const chunks = [];
    let cursor = 0;
    for (const op of this.toOperations()) {
      chunks.push(this.#base.subarray(cursor, op.start), encode(op.replacement));
      cursor = op.end;
    }
    chunks.push(this.#base.subarray(cursor));
    return concatBytes(chunks);
  }

  verify() {
    let baseCursor = 0;
    const baseCoordinates = this.coordinates('base');
    for (const piece of this.#pieces) {
      if (piece.kind === 'base') {
        if (piece.start !== baseCursor || piece.end <= piece.start) throw new Error('Broken base provenance');
        baseCoordinates.byteToUtf16(piece.start); baseCoordinates.byteToUtf16(piece.end);
        baseCursor = piece.end;
      } else assertText(piece.text);
      if (modified(piece) && !Object.hasOwn(this.#metadata, piece.id)) throw new Error('Missing metadata');
    }
    if (baseCursor !== this.#base.length) throw new Error('Incomplete base provenance');
    const candidate = this.toCandidateBytes(), view = this.#viewBytes();
    if (!sameBytes(candidate, view)) throw new Error('Operation replay differs from piece-table view');
    if (this.toOperations().length && sameBytes(candidate, this.#base)) throw new Error('Globally unchanged operations');
    let oldCursor = 0, newCursor = 0, lastEnd = -1;
    const ids = new Set();
    for (const op of this.toOperations()) {
      if (op.start <= lastEnd || op.end < op.start || ids.has(op.operationId) || op.expected === op.replacement ||
          !sameBytes(encode(op.expected), this.#base.subarray(op.start, op.end))) throw new Error('Invalid canonical operation');
      ids.add(op.operationId); lastEnd = op.end;
      const gap = this.#base.subarray(oldCursor, op.start);
      if (!sameBytes(gap, candidate.subarray(newCursor, newCursor + gap.length))) throw new Error('Untouched bytes changed');
      newCursor += gap.length + encode(op.replacement).length;
      oldCursor = op.end;
    }
    if (!sameBytes(this.#base.subarray(oldCursor), candidate.subarray(newCursor))) throw new Error('Untouched suffix changed');
    if (Object.keys(this.#metadata).length !== ids.size) throw new Error('Orphan metadata');
    return true;
  }

  render(adapterId, registry = defaultDisplayAdapters) {
    // Providers receive immutable copies, not mutable ledger state or write authority.
    const adapter = registry.get(adapterId);
    return adapter.render(Object.freeze({ baseText: decode(this.#base), operations: this.toOperations(), metadata: this.metadata }));
  }

  serialize() {
    const value = JSON.stringify({ schemaVersion: 1, base: this.#identity, nextSequence: this.#nextSequence,
      current: this.#snapshot(), undo: this.#undo, redo: this.#redo });
    if (encode(value).length > this.#limits.maxSerializedBytes) throw new RangeError('Serialized ledger exceeds byte limit');
    return value;
  }

  static deserialize(baseBytes, identity, serialized, options) {
    const ledger = new SuggestionLedger(baseBytes, identity, options);
    if (typeof serialized !== 'string' || serialized.length > ledger.#limits.maxSerializedBytes ||
        encode(serialized).length > ledger.#limits.maxSerializedBytes) throw new RangeError('Invalid serialized ledger size');
    const value = JSON.parse(serialized);
    if (!keysAre(value, ['schemaVersion', 'base', 'nextSequence', 'current', 'undo', 'redo']) || value.schemaVersion !== 1 ||
        !keysAre(value.base, ['path', 'byteLength', 'digest']) ||
        Object.keys(identity).some((key) => value.base[key] !== identity[key])) throw new Error('Persisted base identity mismatch');
    if (!Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1 ||
        !Array.isArray(value.undo) || !Array.isArray(value.redo) ||
        value.undo.length + value.redo.length > ledger.#limits.maxHistory) throw new TypeError('Invalid persisted history');
    for (const snapshot of [value.current, ...value.undo, ...value.redo]) ledger.#validateSnapshot(snapshot, value.nextSequence);
    ledger.#restore(value.current);
    ledger.#undo = copy(value.undo); ledger.#redo = copy(value.redo);
    ledger.#nextSequence = value.nextSequence;
    ledger.verify();
    return ledger;
  }

  #checkSpace(space) {
    if (space !== 'base' && space !== 'view') throw new TypeError('Coordinate space must be base or view');
  }
  #viewBytes() {
    return concatBytes(this.#pieces.filter((piece) => !isDeleted(piece)).map((piece) =>
      piece.kind === 'insert' ? encode(piece.text) : this.#base.subarray(piece.start, piece.end)));
  }
  #splitAt(offset) {
    let cursor = 0;
    for (let i = 0; i < this.#pieces.length; i++) {
      const piece = this.#pieces[i], length = liveLength(piece);
      if (cursor < offset && offset < cursor + length) {
        const at = offset - cursor;
        const parts = piece.kind === 'base' ? [{ ...piece, end: piece.start + at }, { ...piece, start: piece.start + at }] :
          [{ ...piece, text: decode(encode(piece.text).subarray(0, at)) }, { ...piece, text: decode(encode(piece.text).subarray(at)) }];
        this.#pieces.splice(i, 1, ...parts);
        return;
      }
      cursor += length;
    }
  }
  #piecesFromOperations(operations) {
    const pieces = [];
    let cursor = 0;
    for (const op of operations) {
      if (op.start > cursor) pieces.push({ kind: 'base', start: cursor, end: op.start, id: null });
      if (op.end > op.start) pieces.push({ kind: 'base', start: op.start, end: op.end, id: op.operationId });
      if (op.replacement) pieces.push({ kind: 'insert', text: op.replacement, id: op.operationId });
      cursor = op.end;
    }
    if (cursor < this.#base.length) pieces.push({ kind: 'base', start: cursor, end: this.#base.length, id: null });
    return pieces;
  }
  #normalize() {
    const operations = [], metadata = {};
    let group = null, cursor = 0;
    const flush = () => {
      if (!group) return;
      const expected = decode(this.#base.subarray(group.start, cursor));
      if (expected !== group.text) {
        const ids = [...group.ids].sort((a, b) => sequence(a) - sequence(b));
        const id = ids[0];
        const comments = ids.map((key) => this.#metadata[key].comment).filter(Boolean);
        metadata[id] = { ...this.#metadata[id], comment: [...new Set(comments)].join('\n') };
        operations.push({ operationId: id, start: group.start, end: cursor, expected, replacement: group.text });
      }
      group = null;
    };
    for (const piece of this.#pieces) {
      if (!modified(piece)) { flush(); cursor = piece.end; continue; }
      if (!group) group = { start: cursor, text: '', ids: new Set() };
      group.ids.add(piece.id);
      if (piece.kind === 'base') cursor = piece.end; else group.text += piece.text;
    }
    flush();
    // Separate origin edits can cancel globally (e.g. moving one indistinguishable byte).
    if (sameBytes(this.#viewBytes(), this.#base)) {
      this.#metadata = {};
      this.#pieces = this.#piecesFromOperations([]);
    } else {
      this.#metadata = metadata;
      this.#pieces = this.#piecesFromOperations(operations);
    }
  }
  #snapshot() { return { operations: this.toOperations(), metadata: copy(this.#metadata) }; }
  #restore(snapshot) {
    this.#pieces = this.#piecesFromOperations(snapshot.operations);
    this.#metadata = copy(snapshot.metadata);
  }
  #commit(action) {
    const before = this.#snapshot(), next = this.#nextSequence;
    try {
      action();
      if (this.toOperations().length > this.#limits.maxOperations) throw new RangeError('Operation limit exceeded');
      this.verify();
      this.#undo.push(before);
      if (this.#undo.length > this.#limits.maxHistory) this.#undo.shift();
      this.#redo = [];
      return true;
    } catch (error) { this.#restore(before); this.#nextSequence = next; throw error; }
  }
  #validateSnapshot(snapshot, nextSequence) {
    if (!keysAre(snapshot, ['operations', 'metadata']) || !Array.isArray(snapshot.operations) ||
        snapshot.operations.length > this.#limits.maxOperations || !snapshot.metadata ||
        typeof snapshot.metadata !== 'object' || Array.isArray(snapshot.metadata)) throw new TypeError('Invalid persisted snapshot');
    const coordinates = this.coordinates('base'), ids = new Set();
    let lastEnd = -1, candidateLength = this.#base.length;
    for (const op of snapshot.operations) {
      if (!keysAre(op, ['operationId', 'start', 'end', 'expected', 'replacement']) || !validId(op.operationId) ||
          sequence(op.operationId) >= nextSequence || ids.has(op.operationId)) throw new TypeError('Invalid persisted operation');
      ids.add(op.operationId);
      coordinates.byteToUtf16(op.start); coordinates.byteToUtf16(op.end);
      assertText(op.expected); assertText(op.replacement);
      if (op.end < op.start || op.start <= lastEnd || op.expected === op.replacement ||
          decode(this.#base.subarray(op.start, op.end)) !== op.expected) throw new Error('Invalid persisted operation range or bytes');
      lastEnd = op.end;
      candidateLength += encode(op.replacement).length - (op.end - op.start);
      const metadata = snapshot.metadata[op.operationId];
      if (!keysAre(metadata, ['comment', 'createdAt']) || typeof metadata.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(metadata.createdAt))) throw new TypeError('Invalid persisted metadata');
      assertText(metadata.comment);
    }
    if (Object.keys(snapshot.metadata).length !== ids.size || Object.keys(snapshot.metadata).some((id) => !ids.has(id)) ||
        candidateLength > this.#limits.maxViewBytes) throw new Error('Invalid persisted snapshot bounds');
    const chunks = [];
    let cursor = 0;
    for (const op of snapshot.operations) {
      chunks.push(this.#base.subarray(cursor, op.start), encode(op.replacement));
      cursor = op.end;
    }
    chunks.push(this.#base.subarray(cursor));
    if (snapshot.operations.length && sameBytes(concatBytes(chunks), this.#base)) throw new Error('Globally unchanged persisted operations');
  }
}
