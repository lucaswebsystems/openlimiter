#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { runCli } from "./cli.js";
import { readStandardInputText } from "./ingest.js";

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

const result = await runCli(process.argv.slice(2), {
  promptForSecret,
  readStandardInput: () => readStandardInputText()
});
if (result.stdout !== "") process.stdout.write(result.stdout + "\n");
if (result.stderr !== "") process.stderr.write(result.stderr + "\n");
process.exitCode = result.exitCode;
