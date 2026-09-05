/**
 * The one alert card per provider that failed to read.
 *
 * It lives apart from the window for one reason: everything it draws came off
 * a file on disk. The provider identifier arrives from the snapshot cache, the
 * category from whatever the core could make of it, and a category with no
 * sentence in the table shows its own code. None of those is a value this
 * window produced, and app.js opens by promising that nothing read off disk
 * ever reaches innerHTML.
 *
 * So this builds nodes and sets text. There is no markup string here to escape
 * correctly, which is the only kind of escaping that cannot be got wrong.
 */

/**
 * One failure card.
 *
 * `providerName` and `sentence` are resolved by the caller, because the name
 * table and the sentence table both belong to the window. What this owns is
 * that whatever those two turn out to be, they arrive as text.
 */
export function buildFailureRow(providerName, sentence) {
  const row = document.createElement("div");
  row.className = "alert";
  row.setAttribute("role", "status");

  const name = document.createElement("strong");
  name.textContent = String(providerName);
  row.append(name);

  const body = document.createElement("p");
  body.textContent = String(sentence);
  row.append(body);
  return row;
}
