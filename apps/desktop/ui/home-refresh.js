export function freshestObservation(snapshots) {
  const instants = snapshots.map((snapshot) => Date.parse(snapshot.observedAt)).filter(Number.isFinite);
  return instants.length ? new Date(Math.max(...instants)).toISOString() : null;
}

export function paintObserved(clock, snapshots) {
  const instant = freshestObservation(snapshots);
  clock.textContent = instant ? "Observed " + new Date(instant).toLocaleTimeString() : "No reading yet";
  if (instant) clock.setAttribute("datetime", instant);
  else clock.removeAttribute("datetime");
}

export function bindHomeRefresh({ button, status, readNow, repaint }) {
  const run = async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "Refreshing…";
    button.setAttribute("aria-busy", "true");
    status.textContent = "";
    try {
      const result = await readNow();
      const painted = await repaint();
      if (!result?.ok || result.value?.succeeded === false || painted === false) {
        status.textContent = "Some readings could not refresh; try again shortly.";
      }
    } catch {
      status.textContent = "The readings could not refresh; try again shortly.";
    } finally {
      button.disabled = false;
      button.textContent = "Refresh";
      button.setAttribute("aria-busy", "false");
    }
  };
  button.addEventListener("click", run);
  return run;
}
