import { scanProject } from "./scanner.js";
import { runBaseRules } from "./rules/base.js";
import { runPushRules } from "./rules/push.js";
import { runPxRules } from "./rules/px.js";
import { runFlutterBaseRules } from "./rules/flutterBase.js";
import { runFlutterPushRules } from "./rules/flutterPush.js";
import { runFlutterPxRules } from "./rules/flutterPx.js";
import { runNativeBaseRules } from "./rules/nativeBase.js";
import { runNativePushRules } from "./rules/nativePush.js";
import { runNativePxRules } from "./rules/nativePx.js";
export async function planIntegration(options) {
    const scan = await scanProject(options.rootPath);
    const changes = [];
    if (options.parts.includes("base")) {
        if (options.appPlatform === "flutter") {
            const flutterChanges = await runFlutterBaseRules({
                scan,
                rootPath: options.rootPath,
                inputs: options.inputs,
                includePush: options.parts.includes("push")
            });
            changes.push(...flutterChanges);
        }
        else if (options.appPlatform === "android-native") {
            const nativeChanges = await runNativeBaseRules({
                scan,
                rootPath: options.rootPath,
                inputs: options.inputs
            });
            changes.push(...nativeChanges);
        }
        else {
            const baseChanges = await runBaseRules({
                scan,
                rootPath: options.rootPath,
                inputs: options.inputs
            });
            changes.push(...baseChanges);
        }
    }
    if (options.parts.includes("push")) {
        if (options.appPlatform === "flutter") {
            const flutterPushChanges = await runFlutterPushRules({
                scan,
                rootPath: options.rootPath,
                inputs: options.inputs
            });
            changes.push(...flutterPushChanges);
        }
        else if (options.appPlatform === "android-native") {
            const nativePushChanges = await runNativePushRules({
                scan,
                rootPath: options.rootPath,
                inputs: options.inputs
            });
            changes.push(...nativePushChanges);
        }
        else {
            const pushChanges = await runPushRules({
                scan,
                rootPath: options.rootPath,
                inputs: options.inputs
            });
            changes.push(...pushChanges);
        }
    }
    if (options.parts.includes("px")) {
        if (options.appPlatform === "flutter") {
            const flutterPxChanges = await runFlutterPxRules({
                scan,
                rootPath: options.rootPath,
                inputs: options.inputs
            });
            changes.push(...flutterPxChanges);
        }
        else if (options.appPlatform === "android-native") {
            const nativePxChanges = await runNativePxRules({
                scan,
                rootPath: options.rootPath,
                inputs: options.inputs
            });
            changes.push(...nativePxChanges);
        }
        else {
            const pxChanges = await runPxRules({
                scan,
                rootPath: options.rootPath,
                inputs: options.inputs
            });
            changes.push(...pxChanges);
        }
    }
    return {
        scan,
        parts: options.parts,
        changes
    };
}
