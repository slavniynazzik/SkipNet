/**
 * Secret redaction for logs.
 *
 * SkipNet handles two credentials that must never reach the Logs page, a
 * support bundle or stdout: the MTProto `tgws.secret` and any `tg://proxy`
 * link built from it. Every log line passes through this module before it is
 * broadcast to the renderer.
 */

const MASK = '<redacted>'

// `--secret <value>` / `--secret=<value>`, optionally quoted.
const CLI_SECRET = /(--secret(?:\s+|=))(?:"[^"]*"|'[^']*'|\S+)/gi
// Query-string / key=value form: `secret=...` (also covers tg://proxy links).
const KEY_SECRET = /(\bsecret\s*=\s*)([^\s&;"'<>]+)/gi
// JSON-ish form: `"secret": "..."`.
const JSON_SECRET = /("secret"\s*:\s*")([^"]*)(")/gi
// A bare 32-hex MTProto key (the exact shape `tgws.secret` must have).
const STANDALONE_HEX = /\b[0-9a-fA-F]{32}\b/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Mask secrets in `text`.
 *
 * @param text raw log line
 * @param extraSecrets exact values to mask (e.g. the current `tgws.secret`);
 *   short values are ignored so a one-character path segment cannot destroy
 *   the whole log line.
 */
export function redactSecrets(text: string, extraSecrets?: readonly string[]): string {
  if (typeof text !== 'string' || text.length === 0) return text

  let out = text
  for (const secret of extraSecrets ?? []) {
    if (typeof secret !== 'string' || secret.length < 8) continue
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), MASK)
  }

  out = out
    .replace(JSON_SECRET, `$1${MASK}$3`)
    .replace(CLI_SECRET, `$1${MASK}`)
    .replace(KEY_SECRET, `$1${MASK}`)
    .replace(STANDALONE_HEX, MASK)

  return out
}
