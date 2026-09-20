export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  const ancestors = new Set<object>();
  const encode = (input: unknown, depth: number): string => {
    if (depth > 128) throw new Error("invalid_json");
    if (input === null) return "null";
    if (typeof input === "string") return JSON.stringify(input).replace(/[<>&\u2028\u2029]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== "object" || ancestors.has(input)) throw new Error("invalid_json");
    const array = Array.isArray(input);
    if (!array && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      throw new Error("invalid_json");
    }
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== "string")) throw new Error("invalid_json");
    const read = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("invalid_json");
      return descriptor.value;
    };
    ancestors.add(input);
    try {
      if (array) {
        if (keys.length !== input.length + 1) throw new Error("invalid_json");
        const items: string[] = [];
        for (let index = 0; index < input.length; index++) items.push(encode(read(String(index)), depth + 1));
        return `[${items.join(",")}]`;
      }
      return `{${(keys as string[]).sort().map((key) => `${encode(key, depth + 1)}:${encode(read(key), depth + 1)}`).join(",")}}`;
    } finally {
      ancestors.delete(input);
    }
  };
  return encode(value, 0);
}

export function immutableSnapshot<S>(snapshot: S): Readonly<S> {
  const copies = new WeakMap<object, object>();
  const clone = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
    const existing = copies.get(value);
    if (existing) return existing;
    const copy = Array.isArray(value) ? [] : Object.create(prototype);
    copies.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) throw new Error("invalid_snapshot");
      Object.defineProperty(copy, key, { ...descriptor, value: clone(descriptor.value) });
    }
    if (Array.isArray(value)) copy.length = value.length;
    return Object.freeze(copy);
  };
  return clone(snapshot) as Readonly<S>;
}
