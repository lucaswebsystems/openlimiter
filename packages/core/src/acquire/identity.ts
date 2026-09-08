/**
 * Who OpenLimiter says it is on the wire.
 *
 * One string, one place, no exceptions. Every other quota monitor that reads a
 * vendor CLI's token also copies that CLI's user agent, so the vendor cannot
 * tell the two apart. That is impersonation, it is what the vendor terms
 * actually forbid, and it is the one line a product with a company behind it
 * may not cross. We identify as ourselves and accept whatever rate bucket that
 * puts us in.
 *
 * The version is a constant rather than a read of package.json, because this
 * module is bundled into a published package and a runtime file read would be
 * one more thing that can fail inside a status line. A test holds it to the
 * package's own version, so the constant cannot drift.
 */

/** The published version this build identifies as. */
export const ACQUISITION_CLIENT_VERSION = "1.3.4";

/** The only user agent any acquisition request may carry. */
export const OPENLIMITER_USER_AGENT =
  "OpenLimiter/" + ACQUISITION_CLIENT_VERSION + " (+https://openlimiter.com)";
