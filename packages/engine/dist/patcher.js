import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./utils/fs.js";
import { applyPatch } from "diff";
export async function applyChanges(changes, dryRun = true) {
    const results = [];
    const fileCache = new Map();
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
        const currentContent = fileCache.get(change.filePath) ??
            (await loadFileOrEmpty(change.filePath));
        const patched = applyPatch(currentContent, change.patch);
        if (patched === false) {
            if (change.newContent) {
                fileCache.set(change.filePath, change.newContent);
                results.push({
                    changeId: change.id,
                    applied: true,
                    message: "Applied change with fallback content."
                });
            }
            else {
                results.push({
                    changeId: change.id,
                    applied: false,
                    message: "Failed to apply patch."
                });
            }
            continue;
        }
        fileCache.set(change.filePath, patched);
        results.push({
            changeId: change.id,
            applied: true,
            message: "Applied change."
        });
    }
    for (const [filePath, content] of fileCache.entries()) {
        const dir = path.dirname(filePath);
        if (!(await pathExists(dir))) {
            await fs.mkdir(dir, { recursive: true });
        }
        await fs.writeFile(filePath, content, "utf-8");
    }
    return results;
}
async function loadFileOrEmpty(filePath) {
    try {
        return await fs.readFile(filePath, "utf-8");
    }
    catch {
        return "";
    }
}
