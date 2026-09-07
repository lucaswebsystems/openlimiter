#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { HOOK_INPUT_MAX_BYTES } from "@openlimiter/adapters";
import { runCli, runtimeDependencies } from "./cli.js";
import { readStandardInputBuffer, readStandardInputText } from "./ingest.js";
import {
  decodeWrappedStatuslineCommand,
  runStatuslineWrapper
} from "./statusline-wrapper.js";

async function promptForSecret(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "";
  const interfaceHandle = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    return await interfaceHandle.question("OpenRouter key: ");
  } finally {
    interfaceHandle.close();
  }
}

/**
 * Everything that reaches the world, built once and used by BOTH entry paths.
 *
 * The wrapped status line is the configuration most people end up with, because
 * it is what the installer writes for anyone who already had a status line of
 * their own. It used to call the command line tool with only a standard input
 * reader, so it rendered bars from the cache and never started the refresh that
 * keeps them true: the one path that most needed acquisition was the one path
 * that had none.
 */
const runtime = runtimeDependencies();

const argumentsList = process.argv.slice(2);
const wrapIndex = argumentsList.indexOf("--wrap");
const wrapperRequested = argumentsList[0] === "statusline" && wrapIndex !== -1;
const wrapped = wrapperRequested
  ? decodeWrappedStatuslineCommand(argumentsList[wrapIndex + 1] ?? "")
  : null;

if (wrapperRequested && wrapped === null) {
  /* A damaged wrapper command must fail invisibly, never fall through to the
     OpenLimiter renderer and replace the user's visible status line. */
  process.exitCode = 0;
} else if (wrapped !== null) {
  const hostIndex = argumentsList.indexOf("--host");
  const hostArgs = hostIndex !== -1 && argumentsList[hostIndex + 1]
    ? ["--host", argumentsList[hostIndex + 1]!]
    : [];
  const payload = await readStandardInputBuffer();
  const result = await runStatuslineWrapper(payload, wrapped, {
    ingest: async (buffer) => {
      await runCli(["statusline", ...hostArgs], {
        ...runtime,
        readStandardInput: async () => buffer.toString("utf8")
      });
    }
  });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} else {
  const result = await runCli(argumentsList, {
    ...runtime,
    promptForSecret,
    readStandardInput: (signal) => argumentsList[0] === "hook"
      ? readStandardInputText(process.stdin, HOOK_INPUT_MAX_BYTES, undefined, signal)
      : readStandardInputText()
  });
  if (result.stdout !== "") process.stdout.write(result.stdout + "\n");
  if (result.stderr !== "") process.stderr.write(result.stderr + "\n");
  process.exitCode = result.exitCode;
}
