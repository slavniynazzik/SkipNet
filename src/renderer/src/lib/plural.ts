/**
 * Russian pluralisation helper.
 *
 * `pluralRu(1, ['сервис','сервиса','сервисов'])` → «сервис»
 * `pluralRu(3, …)` → «сервиса», `pluralRu(11, …)` → «сервисов».
 */
export function pluralRu(
  count: number,
  forms: readonly [string, string, string]
): string {
  const abs = Math.abs(Math.trunc(count)) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return forms[2]
  if (last === 1) return forms[0]
  if (last >= 2 && last <= 4) return forms[1]
  return forms[2]
}
