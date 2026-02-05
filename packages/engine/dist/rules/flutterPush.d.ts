import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
type FlutterPushContext = {
    scan: ProjectScan;
    rootPath: string;
    inputs?: IntegrationOptions["inputs"];
};
export declare function runFlutterPushRules(context: FlutterPushContext): Promise<Change[]>;
export {};
