import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
type FlutterPxContext = {
    scan: ProjectScan;
    rootPath: string;
    inputs?: IntegrationOptions["inputs"];
};
export declare function runFlutterPxRules(context: FlutterPxContext): Promise<Change[]>;
export {};
