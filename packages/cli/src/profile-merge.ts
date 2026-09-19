/** JSON data from a published baseline or author configuration, never live secrets. */
export type ProfileJsonValue = null | boolean | number | string | ProfileJsonValue[] | ProfileJsonObject;
export interface ProfileJsonObject { [key: string]: ProfileJsonValue }

/** Absence is distinct from a present JSON null, including at the document root. */
export type ProfileMergeEntry = { present: false } | { present: true; value: ProfileJsonValue };

export interface ProfileMergeConflict {
  /** RFC 6901 JSON Pointer. The empty string identifies the entire document. */
  path: string;
  base: ProfileMergeEntry;
  local: ProfileMergeEntry;
  upstream: ProfileMergeEntry;
}

export type ProfileMergeResult =
  | { status: "resolved"; value: ProfileJsonValue | undefined; conflicts: [] }
  | { status: "conflicted"; conflicts: [ProfileMergeConflict, ...ProfileMergeConflict[]] };

const missing = Symbol("missing JSON entry");
type Node = ProfileJsonValue | typeof missing;

function isObject(value: Node): value is ProfileJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(object: ProfileJsonObject, key: string): Node {
  return Object.hasOwn(object, key) ? object[key]! : missing;
}

function put(object: ProfileJsonObject, key: string, value: ProfileJsonValue): void {
  // Assignment to __proto__ would invoke the inherited prototype setter.
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
}

function clone(value: Node): Node {
  if (Array.isArray(value)) return value.map(item => clone(item) as ProfileJsonValue);
  if (isObject(value)) {
    const result: ProfileJsonObject = {};
    for (const key of Object.keys(value).sort()) put(result, key, clone(value[key]!) as ProfileJsonValue);
    return result;
  }
  return value;
}

function equal(left: Node, right: Node): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]!));
  }
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key]!, right[key]!));
  }
  return false;
}

function entry(value: Node): ProfileMergeEntry {
  return value === missing ? { present: false } : { present: true, value: clone(value) as ProfileJsonValue };
}

function childPath(path: string, key: string): string {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function mergeNode(base: Node, local: Node, upstream: Node, path: string, conflicts: ProfileMergeConflict[]): Node {
  if (equal(local, upstream)) return clone(local);
  if (equal(local, base)) return clone(upstream);
  if (equal(upstream, base)) return clone(local);

  // Two independently added objects can contribute disjoint fields. A change
  // from an existing scalar/array to different objects remains a conflict.
  if (isObject(local) && isObject(upstream) && (base === missing || isObject(base))) {
    const original: ProfileJsonObject = base === missing ? {} : base;
    const result: ProfileJsonObject = {};
    const keys = [...new Set([...Object.keys(original), ...Object.keys(local), ...Object.keys(upstream)])].sort();
    for (const key of keys) {
      const value = mergeNode(own(original, key), own(local, key), own(upstream, key), childPath(path, key), conflicts);
      if (value !== missing) put(result, key, value);
    }
    return result;
  }

  conflicts.push({ path, base: entry(base), local: entry(local), upstream: entry(upstream) });
  // This internal placeholder is never exposed: any conflict suppresses the
  // entire resolved value, rather than returning a partially installable file.
  return missing;
}

function assertJson(value: unknown, ancestors: Set<object>): void {
  const invalid = () => { throw new TypeError("Profile merge inputs must contain only JSON values"); };
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(); return; }
  if (typeof value !== "object" || !value) return invalid();
  if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) return invalid();
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid();
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (array && Object.keys(value).length !== value.length) return invalid();
  for (const key of Object.getOwnPropertyNames(value)) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) return invalid();
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return invalid();
    assertJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

/**
 * Merge JSON documents using the previous author's release as the base.
 * Pass undefined for an absent document; success with value=undefined deletes it.
 * Objects merge recursively; arrays are ATOMIC values. No array ordering,
 * package-manager, YAML or Cordis node semantics are inferred. A delete versus
 * an edit conflicts; identical edits (including deletions) resolve automatically.
 * Conflicts use stable, key-sorted JSON Pointer paths and expose NO candidate
 * value. Callers must check status before writing or installing anything.
 *
 * Inputs and returned values/snapshots never share mutable references. This is
 * an I/O-free primitive, not an upgrade operation or a confidentiality filter:
 * pass only reviewed shareable baseline/configuration, never unfiltered local
 * secrets. Conflict values are returned to the caller and are never logged.
 */
export function mergeProfileJson(
  base: ProfileJsonValue | undefined,
  local: ProfileJsonValue | undefined,
  upstream: ProfileJsonValue | undefined,
): ProfileMergeResult {
  for (const value of [base, local, upstream]) if (value !== undefined) assertJson(value, new Set());
  const conflicts: ProfileMergeConflict[] = [];
  const value = mergeNode(base === undefined ? missing : base, local === undefined ? missing : local,
    upstream === undefined ? missing : upstream, "", conflicts);
  const [first, ...rest] = conflicts;
  if (first) return { status: "conflicted", conflicts: [first, ...rest] };
  return { status: "resolved", value: value === missing ? undefined : value, conflicts: [] };
}
