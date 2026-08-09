import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, resolveStateDirectory } from "@openlimiter/core";
import { connectors } from "@openlimiter/connectors";
import type { CredentialStore } from "./credentials.js";

export const CONFIG_FILE_NAME = "openlimiter-config.json";

export interface OpenLimiterConfig {
  version: 1;
  connectors: readonly {
    id: string;
    enabled: true;
    detected: boolean;
  }[];
}

async function rejectSymlink(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Unsafe state path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function writeConfig(
  config: OpenLimiterConfig,
  directory = resolveStateDirectory()
): Promise<void> {
  await rejectSymlink(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rejectSymlink(directory);
  const target = path.join(directory, CONFIG_FILE_NAME);
  await rejectSymlink(target);
  const temporary = path.join(
    directory,
    CONFIG_FILE_NAME + "." + randomUUID() + ".tmp"
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(canonicalJson(config), "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function initialize(
  environment: Readonly<Record<string, string | undefined>>,
  credentialStore: CredentialStore,
  promptForSecret: () => Promise<string>,
  directory?: string
): Promise<{ config: OpenLimiterConfig; credentialStored: boolean }> {
  const config: OpenLimiterConfig = {
    version: 1,
    connectors: connectors.map((connector) => ({
      id: connector.id,
      enabled: true,
      detected: connector.detect(environment)
    }))
  };
  let credentialStored = false;
  const openrouter = config.connectors.find((connector) => connector.id === "openrouter");
  if (openrouter?.detected === true) {
    try {
      const existing = await credentialStore.get("openlimiter", "openrouter");
      if (existing === null) {
        const secret = await promptForSecret();
        if (secret.length > 0 && secret.length <= 8_192) {
          await credentialStore.set("openlimiter", "openrouter", secret);
          credentialStored = true;
        }
      }
    } catch {
      credentialStored = false;
    }
  }
  await writeConfig(config, directory);
  return { config, credentialStored };
}
