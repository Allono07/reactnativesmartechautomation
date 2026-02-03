import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
type BaseRuleContext = {
    scan: ProjectScan;
    rootPath: string;
    inputs?: IntegrationOptions["inputs"];
};
export declare function runBaseRules(context: BaseRuleContext): Promise<Change[]>;
export {};
