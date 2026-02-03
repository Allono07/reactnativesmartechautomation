import { pathExists, readJsonIfExists } from "./utils/fs.js";
import path from "node:path";
export async function scanProject(rootPath) {
    const platforms = [];
    const notes = [];
    const androidPath = path.join(rootPath, "android");
    const iosPath = path.join(rootPath, "ios");
    if (await pathExists(androidPath)) {
        platforms.push("android");
    }
    if (await pathExists(iosPath)) {
        platforms.push("ios");
    }
    const packageJson = await readJsonIfExists(path.join(rootPath, "package.json"));
    const reactNativeVersion = packageJson?.dependencies?.["react-native"] ??
        packageJson?.devDependencies?.["react-native"];
    if (!reactNativeVersion) {
        notes.push("react-native dependency not found in package.json");
    }
    if (platforms.length === 0) {
        notes.push("No android or ios folders detected. Is this a React Native project?");
    }
    return {
        rootPath,
        reactNativeVersion,
        platforms,
        notes
    };
}
