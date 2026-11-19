/**
 * Window lifecycle predicates (M4).
 *
 * Closing the window must only quit the app when there is no tray icon to
 * restore it from. The old handler always called `app.quit()`, so the
 * "minimise to tray" setting was effectively ignored on the last window.
 * The predicate is pure so it has a unit test.
 */

/** True when the last window closing should terminate SkipNet. */
export function shouldQuitOnWindowAllClosed(trayActive: boolean, disableTray: boolean): boolean {
  return !(trayActive && !disableTray)
}
