import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
type FlutterBaseContext = {
    scan: ProjectScan;
    rootPath: string;
    inputs?: IntegrationOptions["inputs"];
};
export declare function runFlutterBaseRules(context: FlutterBaseContext): Promise<Change[]>;
export {};
