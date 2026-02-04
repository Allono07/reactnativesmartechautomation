import type { Change, ProjectScan } from "@smartech/shared";

export type PxRuleContext = {
  scan: ProjectScan;
  rootPath: string;
};

export async function runPxRules(_context: PxRuleContext): Promise<Change[]> {
  return [
    {
      id: "px-placeholder",
      title: "PX integration rules not implemented",
      filePath: "",
      kind: "insert",
      patch: "",
      summary: "PX integration scaffolding is ready. Add concrete rules for PX module setup.",
      confidence: 0.1,
      module: "px"
    }
  ];
}
