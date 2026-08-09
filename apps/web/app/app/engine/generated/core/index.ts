/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */

/*
 * The core barrel, for the browser.
 *
 * Same surface as the package barrel with one substitution: the snapshot
 * cache lives on a disk, and a browser has none, so readSnapshotCache comes
 * from the browser shim and reports the same missing cache result the core
 * reports for a file that is not there.
 */
export * from "./types";
export * from "./format";
export * from "./forecast";
export * from "./freshness";
export * from "./merge";
export * from "./normalizer";
export * from "./policy";
export { readSnapshotCache, type CacheReadResult } from "../../browser-cache";
