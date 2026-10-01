export function freshestObservation(snapshots) {
  const instants = snapshots.map((snapshot) => Date.parse(snapshot.observedAt)).filter(Number.isFinite);
  return instants.length ? new Date(Math.max(...instants)).toISOString() : null;
}

/* The button is an icon with an accessible name; while a read runs it says so
   through aria-busy and turns its icon, and never changes its words. */
export function bindHomeRefresh({ button, status, readNow, repaint }) {
  const run = async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    status.textContent = "";
    try {
      const result = await readNow();
      const painted = await repaint();
      if ((!result?.ok || result.value?.succeeded === false || painted === false) && !status.textContent) {
        status.textContent = "Some readings could not refresh; try again shortly.";
      }
    } catch {
      if (!status.textContent) status.textContent = "The readings could not refresh; try again shortly.";
    } finally {
      button.disabled = false;
      button.setAttribute("aria-busy", "false");
    }
  };
  button.addEventListener("click", run);
  return run;
}
