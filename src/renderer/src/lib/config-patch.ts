import type { DeepPartial } from '../types/deep-partial'

/**
 * Payload accepted by the `app:patchConfig` IPC channel.
 *
 * Everything under `AppConfig` becomes optional and recursively partial, so a
 * caller can express "change exactly this leaf" without spreading the current
 * object. The main-process validator accepts partial nested objects and
 * `deepMerge` merges them into the live config.
 */
export type AppConfigPatch = DeepPartial<AppConfig>

/**
 * Wrap one config section in a patch.
 *
 * Callers must pass only the leaves they actually change. Never spread the
 * current section into it: a stale `getAppConfig`, or a value written by the
 * main process (updater, secret regeneration) between the read and the patch,
 * would then be rolled back.
 */
function sectionPatch<T extends object>(
  section: 'tgws' | 'zapret' | 'wallpaper',
  patch: T
): AppConfigPatch {
  return { [section]: patch } as AppConfigPatch
}

export function tgwsPatch(patch: Partial<TgwsConfig>): AppConfigPatch {
  return sectionPatch('tgws', patch)
}

export function zapretPatch(patch: Partial<ZapretConfig>): AppConfigPatch {
  return sectionPatch('zapret', patch)
}

export function wallpaperPatch(patch: Partial<WallpaperConfig>): AppConfigPatch {
  return sectionPatch('wallpaper', patch)
}
