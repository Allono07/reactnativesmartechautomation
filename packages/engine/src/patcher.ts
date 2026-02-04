import type { Change } from "@smartech/shared";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./utils/fs.js";
import { applyPatch } from "diff";

export type ApplyResult = {
  changeId: string;
  applied: boolean;
  message: string;
};

export async function applyChanges(changes: Change[], dryRun = true): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  const fileCache = new Map<string, { original: string; current: string }>();

  for (const change of changes) {
    if (dryRun) {
      results.push({
        changeId: change.id,
        applied: false,
        message: "Dry run: no changes applied."
      });
      continue;
    }

    if (!change.patch) {
      results.push({
        changeId: change.id,
        applied: false,
        message: "No patch available for this change."
      });
      continue;
    }

    const cached = fileCache.get(change.filePath);
    const original = cached?.original ?? (await loadFileOrEmpty(change.filePath));
    const current = cached?.current ?? original;

    const patched = applyPatch(current, change.patch, { fuzzFactor: 5 });
    if (patched === false) {
      if (change.newContent && current === original) {
        fileCache.set(change.filePath, { original, current: change.newContent });
        results.push({
          changeId: change.id,
          applied: true,
          message: "Applied change with fallback content."
        });
      } else {
        results.push({
          changeId: change.id,
          applied: false,
          message: "Failed to apply patch."
        });
      }
      continue;
    }

    fileCache.set(change.filePath, { original, current: patched });
    results.push({
      changeId: change.id,
      applied: true,
      message: "Applied change."
    });
  }

  for (const [filePath, payload] of fileCache.entries()) {
    const dir = path.dirname(filePath);
    if (!(await pathExists(dir))) {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(filePath, payload.current, "utf-8");
  }

  return results;
}

async function loadFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}
