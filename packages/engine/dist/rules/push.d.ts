import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
type PushRuleContext = {
    scan: ProjectScan;
    rootPath: string;
    inputs?: IntegrationOptions["inputs"];
};
export declare function runPushRules(context: PushRuleContext): Promise<Change[]>;
export {};
