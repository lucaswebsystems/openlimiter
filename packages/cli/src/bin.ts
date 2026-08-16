#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { runCli } from "./cli.js";
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

const argumentsList = process.argv.slice(2);
const wrapperRequested =
  argumentsList[0] === "statusline" && argumentsList[1] === "--wrap";
const wrapped = wrapperRequested
  ? decodeWrappedStatuslineCommand(argumentsList[2] ?? "")
  : null;

if (wrapperRequested && wrapped === null) {
  /* A damaged wrapper command must fail invisibly, never fall through to the
     OpenLimiter renderer and replace the user's visible status line. */
  process.exitCode = 0;
} else if (wrapped !== null) {
  const payload = await readStandardInputBuffer();
  const result = await runStatuslineWrapper(payload, wrapped, {
    ingest: async (buffer) => {
      await runCli(["statusline"], {
        readStandardInput: async () => buffer.toString("utf8")
      });
    }
  });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} else {
  const result = await runCli(argumentsList, {
    promptForSecret,
    readStandardInput: () => readStandardInputText()
  });
  if (result.stdout !== "") process.stdout.write(result.stdout + "\n");
  if (result.stderr !== "") process.stderr.write(result.stderr + "\n");
  process.exitCode = result.exitCode;
}
