import type { Change, ProjectScan } from "@smartech/shared";
export type PushRuleContext = {
    scan: ProjectScan;
    rootPath: string;
};
export declare function runPushRules(_context: PushRuleContext): Promise<Change[]>;
