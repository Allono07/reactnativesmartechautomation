import type { Change, ProjectScan } from "@smartech/shared";
export type PxRuleContext = {
    scan: ProjectScan;
    rootPath: string;
};
export declare function runPxRules(_context: PxRuleContext): Promise<Change[]>;
