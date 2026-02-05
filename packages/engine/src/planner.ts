import type { IntegrationOptions, IntegrationPlan } from "@smartech/shared";
import { scanProject } from "./scanner.js";
import { runBaseRules } from "./rules/base.js";
import { runPushRules } from "./rules/push.js";
import { runPxRules } from "./rules/px.js";
import { runFlutterBaseRules } from "./rules/flutterBase.js";

export async function planIntegration(options: IntegrationOptions): Promise<IntegrationPlan> {
  const scan = await scanProject(options.rootPath);

  const changes = [] as IntegrationPlan["changes"];

  if (options.parts.includes("base")) {
    if (options.appPlatform === "flutter") {
      const flutterChanges = await runFlutterBaseRules({
        scan,
        rootPath: options.rootPath,
        inputs: options.inputs
      });
      changes.push(...flutterChanges);
    } else {
      const baseChanges = await runBaseRules({
        scan,
        rootPath: options.rootPath,
        inputs: options.inputs
      });
      changes.push(...baseChanges);
    }
  }

  if (options.appPlatform !== "flutter" && options.parts.includes("push")) {
    const pushChanges = await runPushRules({
      scan,
      rootPath: options.rootPath,
      inputs: options.inputs
    });
    changes.push(...pushChanges);
  }

  if (options.appPlatform !== "flutter" && options.parts.includes("px")) {
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
