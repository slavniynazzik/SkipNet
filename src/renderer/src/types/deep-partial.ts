/**
 * Recursive optional projection of a type.
 *
 * `app:patchConfig` accepts a partial tree: the main-process schema validates
 * every supplied leaf (unknown keys are rejected) and `deepMerge` merges the
 * result into the persisted config. The renderer therefore sends
 * `{ tgws: { autoStart: true } }` instead of `{ tgws: { ...currentTgws } }`,
 * which would overwrite any value another writer changed in between.
 *
 * Arrays are projected element-wise, functions are kept as-is so this can be
 * applied to any config-like shape.
 */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepPartial<U>>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T
