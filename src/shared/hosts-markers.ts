/**
 * Markers that delimit the blocks SkipNet manages inside the Windows hosts
 * file.
 *
 * They are shared by three consumers that must never drift apart:
 *
 *  - `src/main/core/hosts-render.ts` (and the elevated writer in `hosts-file`)
 *    renders/strips the blocks;
 *  - `resources/uninstall-hosts-cleanup.ps1` strips the same blocks when the
 *    product is uninstalled;
 *  - the unit suite asserts the script really contains these exact strings.
 *
 * Changing a marker is a data migration, not a cosmetic edit: existing hosts
 * files still carry the old text.
 */

export const HOSTS_EDITOR_BLOCK_START = '# --- SkipNet hosts editor BEGIN ---'
export const HOSTS_EDITOR_BLOCK_END = '# --- SkipNet hosts editor END ---'
export const HOSTS_ADOBE_BLOCK_START = '# --- SkipNet Adobe activation block BEGIN ---'
export const HOSTS_ADOBE_BLOCK_END = '# --- SkipNet Adobe activation block END ---'
export const HOSTS_LEGACY_BLOCK_START = '# --- SkipNet (Zapret) hosts BEGIN ---'
export const HOSTS_LEGACY_BLOCK_END = '# --- SkipNet (Zapret) hosts END ---'
