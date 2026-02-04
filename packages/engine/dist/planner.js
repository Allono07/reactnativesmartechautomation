import { scanProject } from "./scanner.js";
import { runBaseRules } from "./rules/base.js";
import { runPushRules } from "./rules/push.js";
import { runPxRules } from "./rules/px.js";
export async function planIntegration(options) {
    const scan = await scanProject(options.rootPath);
    const changes = [];
    if (options.parts.includes("base")) {
        const baseChanges = await runBaseRules({
            scan,
            rootPath: options.rootPath,
            inputs: options.inputs
        });
        changes.push(...baseChanges);
    }
    if (options.parts.includes("push")) {
        const pushChanges = await runPushRules({
            scan,
            rootPath: options.rootPath,
            inputs: options.inputs
        });
        changes.push(...pushChanges);
    }
    if (options.parts.includes("px")) {
        const pxChanges = await runPxRules({
            scan,
            rootPath: options.rootPath,
            inputs: options.inputs
        });
        changes.push(...pxChanges);
    }
    return {
        scan,
        parts: options.parts,
        changes
    };
}
