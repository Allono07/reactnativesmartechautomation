export declare function pathExists(targetPath: string): Promise<boolean>;
export declare function readJsonIfExists<T = any>(filePath: string): Promise<T | null>;
