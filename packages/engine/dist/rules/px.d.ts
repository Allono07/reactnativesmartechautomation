import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
type PxRuleContext = {
    scan: ProjectScan;
    rootPath: string;
    inputs?: IntegrationOptions["inputs"];
};
export declare function runPxRules(context: PxRuleContext): Promise<Change[]>;
export {};
