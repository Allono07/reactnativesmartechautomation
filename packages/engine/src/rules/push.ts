import type { Change, ProjectScan } from "@smartech/shared";

export type PushRuleContext = {
  scan: ProjectScan;
  rootPath: string;
};

export async function runPushRules(_context: PushRuleContext): Promise<Change[]> {
  return [
    {
      id: "push-placeholder",
      title: "Push integration rules not implemented",
      filePath: "",
      kind: "insert",
      patch: "",
      summary: "Push integration scaffolding is ready. Add concrete rules for FCM/APNS setup.",
      confidence: 0.1
    }
  ];
}
