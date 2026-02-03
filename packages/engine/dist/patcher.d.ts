import type { Change } from "@smartech/shared";
export type ApplyResult = {
    changeId: string;
    applied: boolean;
    message: string;
};
export declare function applyChanges(changes: Change[], dryRun?: boolean): Promise<ApplyResult[]>;
