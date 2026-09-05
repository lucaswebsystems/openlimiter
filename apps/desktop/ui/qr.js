/**
 * The pairing symbol, drawn from the encoder the command line tool ships.
 *
 * `openlimiter serve` already prints a QR code, and its encoder is pure: byte
 * mode, error correction level M, no imports and no node surface. It is copied
 * into the engine by scripts/build-ui.mjs, so this window draws the same
 * symbol rather than carrying a second encoder that could disagree with it.
 *
 * The only thing added here is a rendering. The terminal renders a matrix with
 * half block characters; a window renders it as one SVG path, which stays
 * crisp at any size and needs no image, no canvas and no network.
 *
 * Both colours come from the desktop token sheet and neither follows the
 * theme. A scanner needs dark modules on a light field, so a dark themed
 * window that inverted the symbol would be a window whose pairing code no
 * phone can read. The card around it is themed; the symbol inside it is not.
 */
import { encodeQr } from "./engine/cli/qr.js";

/** Modules of light margin around the symbol. Four is the published minimum. */
const QUIET_ZONE = 4;

/**
 * One SVG element carrying the symbol for `text`.
 *
 * Built through the DOM rather than through a markup string, because this is
 * the one place in the window where a value that came back from the network
 * decides what is drawn, and a path built from booleans can carry nothing else.
 */
export function qrElement(text, label) {
  const matrix = encodeQr(String(text));
  const span = matrix.size + QUIET_ZONE * 2;
  const commands = [];
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (matrix.modules[row][column] !== true) continue;
      commands.push(
        "M" + String(column + QUIET_ZONE) + " " + String(row + QUIET_ZONE) + "h1v1h-1z",
      );
    }
  }

  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 " + String(span) + " " + String(span));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", String(label ?? "Pairing code"));
  svg.setAttribute("shape-rendering", "crispEdges");

  const ground = document.createElementNS(namespace, "rect");
  ground.setAttribute("width", String(span));
  ground.setAttribute("height", String(span));
  ground.setAttribute("fill", "var(--ol-qr-ground)");
  svg.append(ground);

  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", commands.join(""));
  path.setAttribute("fill", "var(--ol-qr-ink)");
  svg.append(path);
  return svg;
}
