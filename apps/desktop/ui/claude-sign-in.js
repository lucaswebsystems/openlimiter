/**
 * The Claude row's one click: turn the disclosed direct check on, repaint the
 * menu switch from the same setting so both show it, then read once through
 * the ordinary check. Returns false when the setting could not be saved, which
 * the row shows as its "did not work" line.
 */
export async function useClaudeSignIn({ setPoll, repaintMenu, check }) {
  const saved = await setPoll(true);
  if (saved?.ok !== true) return false;
  await repaintMenu();
  return check("CLAUDE");
}
