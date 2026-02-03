import type { Change } from "@smartech/shared";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./utils/fs.js";

export type ApplyResult = {
  changeId: string;
  applied: boolean;
  message: string;
};

export async function applyChanges(changes: Change[], dryRun = true): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];

  for (const change of changes) {
    if (dryRun) {
      results.push({
        changeId: change.id,
        applied: false,
        message: "Dry run: no changes applied."
      });
      continue;
    }

    if (!change.newContent) {
      results.push({
        changeId: change.id,
        applied: false,
        message: "No new content available for this change yet."
      });
      continue;
    }

    const dir = path.dirname(change.filePath);
    if (!(await pathExists(dir))) {
      await fs.mkdir(dir, { recursive: true });
    }

    await fs.writeFile(change.filePath, change.newContent, "utf-8");

    results.push({
      changeId: change.id,
      applied: true,
      message: "Applied change."
    });
  }

  return results;
}
