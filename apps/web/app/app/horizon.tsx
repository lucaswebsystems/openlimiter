/**
 * The band horizon, this surface's one signature moment.
 *
 * It is drawn from the product's own primitive and from nothing else: a lit
 * mesh mixed out of the accent and three of the quota bands, and five bare
 * bars at the five band widths sitting on top of it. Behind an empty screen it
 * says, without a word or a number, what this screen is for.
 *
 * It carries no reading. There is no provider name, no percentage, no reset
 * time and no label of any kind, and the whole thing is hidden from assistive
 * technology, because the one thing this product may never draw is a number
 * nobody measured. Every value it uses is a token, so both themes follow, and
 * every animation stops under a reduced motion preference. See theme.css.
 */

/** The five bands, in the order the ramp runs. */
const BANDS = ["green", "yellow", "orange", "red", "stale"] as const;

/**
 * The two moods this composition has.
 *
 * `bands` is the ramp as the product draws it. `locked` is the same
 * composition with every bar hatched and the light pulled back, which is the
 * hatch the meters already use for a window with no trustworthy reading: it is
 * the shape of a screen somebody used to have. It is the same primitive
 * either way, so the locked state cannot drift into a second picture.
 */
export type HorizonTone = "bands" | "locked";

export function BandHorizon({ tone = "bands" }: { tone?: HorizonTone }) {
  return (
    <div className="ol-horizon" data-tone={tone} aria-hidden="true">
      <div className="ol-horizon-mesh" />
      <div className="ol-horizon-bars">
        {BANDS.map((band) => (
          <span key={band} className="ol-horizon-bar" data-band={band}>
            <span />
          </span>
        ))}
      </div>
    </div>
  );
}
