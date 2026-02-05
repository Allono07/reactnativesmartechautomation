import path from "node:path";
import { promises as fs } from "node:fs";
import { pathExists } from "../utils/fs.js";
import { createUnifiedDiff } from "../utils/diff.js";
const ANDROID_SRC = path.join("android", "app", "src", "main");
const JAVA_SRC = path.join(ANDROID_SRC, "java");
const KOTLIN_SRC = path.join(ANDROID_SRC, "kotlin");
const MANIFEST_RELATIVE = path.join(ANDROID_SRC, "AndroidManifest.xml");
const GRADLE_PROPERTIES_RELATIVE = path.join("android", "gradle.properties");
const DEFAULT_FLUTTER_PX_VERSION = "^1.1.0";
const DEFAULT_ANDROID_PX_VERSION = "10.2.12";
const PX_IMPORT = "package:smartech_nudges/smartech_nudges.dart";
const FLUTTER_PX_REGISTRATION_SNIPPET = `// In main(), after initialization:
NetcorePX.instance.registerPxDeeplinkListener(_PxDeeplinkListenerImpl());
NetcorePX.instance.registerPxInternalEventsListener(_PxInternalEventsListener());
`;
const FLUTTER_PX_WIDGET_SNIPPET = `// Wrap your top-level app widget
return SmartechPxWidget(
  child: MaterialApp(
    navigatorObservers: [PxNavigationObserver()],
    home: const MyHomePage(),
  ),
);
`;
export async function runFlutterPxRules(context) {
    const changes = [];
    if (!context.scan.platforms.includes("android"))
        return changes;
    const rootPath = context.rootPath;
    const androidMain = path.join(rootPath, ANDROID_SRC);
    const javaRoot = path.join(androidMain, "java");
    const kotlinRoot = path.join(androidMain, "kotlin");
    const manifestPath = path.join(rootPath, MANIFEST_RELATIVE);
    const sourceRoots = [];
    if (await pathExists(javaRoot))
        sourceRoots.push(javaRoot);
    if (await pathExists(kotlinRoot))
        sourceRoots.push(kotlinRoot);
    if (sourceRoots.length === 0) {
        changes.push({
            id: "flutter-px-android-no-src",
            title: "Android source root not found",
            filePath: androidMain,
            kind: "insert",
            patch: "",
            summary: "Expected android/app/src/main/java or kotlin to exist. PX integration requires Android sources.",
            confidence: 0.2,
            module: "px"
        });
        return changes;
    }
    const flutterPxVersion = context.inputs?.flutterPxSdkVersion ?? DEFAULT_FLUTTER_PX_VERSION;
    const androidPxVersion = context.inputs?.pxSdkVersion ?? DEFAULT_ANDROID_PX_VERSION;
    const hanselAppId = context.inputs?.hanselAppId ?? "";
    const hanselAppKey = context.inputs?.hanselAppKey ?? "";
    const pxScheme = context.inputs?.pxScheme ?? "";
    const mainDartPath = context.inputs?.mainDartPath ?? path.join(rootPath, "lib", "main.dart");
    const gradlePropChange = await ensureGradleProperty(rootPath, androidPxVersion);
    if (gradlePropChange)
        changes.push(gradlePropChange);
    const pubspecChange = await ensurePubspecDependency(rootPath, flutterPxVersion);
    if (pubspecChange)
        changes.push(pubspecChange);
    const metaChange = await ensureHanselMeta(manifestPath, hanselAppId, hanselAppKey);
    if (metaChange)
        changes.push(metaChange);
    const libDir = path.join(rootPath, "lib");
    const listenerStatus = await findPxListeners(libDir);
    const shouldCreateListeners = !listenerStatus.hasAny;
    if (shouldCreateListeners) {
        const listenerFile = path.join(libDir, "smartech_px_listeners.dart");
        if (await pathExists(listenerFile)) {
            const existing = await fs.readFile(listenerFile, "utf-8");
            if (!/PxDeeplinkListener/.test(existing) && !/PxInternalEventsListener/.test(existing)) {
                changes.push(buildPxListenerAppendChange(listenerFile, existing));
            }
        }
        else {
            changes.push(buildPxListenerFileChange(rootPath));
        }
    }
    const mainDartChange = await ensureMainDartPx(mainDartPath, shouldCreateListeners);
    if (mainDartChange)
        changes.push(mainDartChange);
    if (!shouldCreateListeners && (await pathExists(mainDartPath))) {
        const mainContent = await fs.readFile(mainDartPath, "utf-8");
        const hasRegistrations = /registerPxDeeplinkListener/.test(mainContent) &&
            /registerPxInternalEventsListener/.test(mainContent);
        if (!hasRegistrations) {
            changes.push({
                id: "flutter-px-listener-registration-missing",
                title: "PX listener registration missing",
                filePath: mainDartPath,
                kind: "insert",
                patch: "",
                summary: "Existing PX listener classes were found, but registration calls are missing. Register them in main().",
                confidence: 0.2,
                manualSnippet: FLUTTER_PX_REGISTRATION_SNIPPET,
                module: "px"
            });
        }
    }
    const launcher = await findLauncherActivity(manifestPath, sourceRoots);
    if (launcher) {
        const intentChange = await ensurePxIntentFilter(manifestPath, launcher.manifestName, pxScheme);
        if (intentChange)
            changes.push(intentChange);
        const mainActivityChange = await ensurePxMainActivity(launcher.filePath);
        if (mainActivityChange)
            changes.push(mainActivityChange);
    }
    return changes;
}
function buildChange(input) {
    const patch = createUnifiedDiff(input.filePath, input.originalContent ?? "", input.newContent ?? "");
    return { module: "px", ...input, patch };
}
async function ensureGradleProperty(rootPath, version) {
    const filePath = path.join(rootPath, GRADLE_PROPERTIES_RELATIVE);
    if (!(await pathExists(filePath)))
        return null;
    const originalContent = await fs.readFile(filePath, "utf-8");
    let newContent = originalContent;
    if (/SMARTECH_PX_SDK_VERSION\s*=/.test(originalContent)) {
        newContent = originalContent.replace(/SMARTECH_PX_SDK_VERSION\s*=\s*[^\n]+/, `SMARTECH_PX_SDK_VERSION=${version}`);
    }
    else {
        newContent = `${originalContent.trimEnd()}\nSMARTECH_PX_SDK_VERSION=${version}\n`;
    }
    if (newContent === originalContent)
        return null;
    return buildChange({
        id: "flutter-gradle-properties-smartech-px",
        title: "Add Smartech PX SDK version to gradle.properties",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Add or update SMARTECH_PX_SDK_VERSION in gradle.properties.",
        confidence: 0.4
    });
}
async function ensurePubspecDependency(rootPath, version) {
    const filePath = path.join(rootPath, "pubspec.yaml");
    if (!(await pathExists(filePath)))
        return null;
    const originalContent = await fs.readFile(filePath, "utf-8");
    if (/smartech_nudges\s*:/.test(originalContent)) {
        const newContent = originalContent.replace(/smartech_nudges\s*:\s*[^\n]+/, `smartech_nudges: ${version}`);
        if (newContent === originalContent)
            return null;
        return buildChange({
            id: "flutter-pubspec-smartech-nudges",
            title: "Update smartech_nudges dependency",
            filePath,
            kind: "update",
            originalContent,
            newContent,
            summary: "Update smartech_nudges dependency in pubspec.yaml.",
            confidence: 0.4
        });
    }
    const lines = originalContent.split("\n");
    const depIndex = lines.findIndex((line) => /^dependencies:\s*$/.test(line));
    if (depIndex === -1)
        return null;
    const indent = "  ";
    lines.splice(depIndex + 1, 0, `${indent}smartech_nudges: ${version}`);
    const newContent = lines.join("\n");
    return buildChange({
        id: "flutter-pubspec-smartech-nudges",
        title: "Add smartech_nudges dependency",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Add smartech_nudges dependency to pubspec.yaml.",
        confidence: 0.4
    });
}
async function ensureHanselMeta(manifestPath, hanselAppId, hanselAppKey) {
    if (!(await pathExists(manifestPath)))
        return null;
    if (!hanselAppId || !hanselAppKey)
        return null;
    const originalContent = await fs.readFile(manifestPath, "utf-8");
    let newContent = originalContent;
    newContent = ensureManifestMeta(newContent, "HANSEL_APP_ID", hanselAppId);
    newContent = ensureManifestMeta(newContent, "HANSEL_APP_KEY", hanselAppKey);
    if (newContent === originalContent)
        return null;
    return buildChange({
        id: "flutter-manifest-hansel-meta",
        title: "Add Hansel meta-data",
        filePath: manifestPath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Add or update HANSEL_APP_ID and HANSEL_APP_KEY in AndroidManifest.xml.",
        confidence: 0.4
    });
}
function ensureManifestMeta(content, name, value) {
    const metaData = `    <meta-data\n        android:name=\"${name}\"\n        android:value=\"${value}\" />`;
    if (content.includes(`android:name=\"${name}\"`)) {
        return content.replace(new RegExp(`<meta-data[^>]*android:name=\\"${name}\\"[^>]*android:value=\\"[^\\"]*\\"[^>]*\\/>`), metaData);
    }
    if (/<application[^>]*>/.test(content)) {
        return content.replace(/<application[^>]*>/, (match) => `${match}\n${metaData}`);
    }
    return content;
}
async function ensureMainDartPx(filePath, includeListenerImport) {
    if (!(await pathExists(filePath))) {
        return buildChange({
            id: "flutter-main-dart-missing",
            title: "main.dart not found",
            filePath,
            kind: "insert",
            originalContent: "",
            newContent: "",
            summary: "main.dart file not found at provided path.",
            confidence: 0.2
        });
    }
    const originalContent = await fs.readFile(filePath, "utf-8");
    let newContent = originalContent;
    newContent = ensureDartImports(newContent, [PX_IMPORT, "package:flutter/foundation.dart"]);
    if (includeListenerImport) {
        newContent = ensureDartImports(newContent, ["smartech_px_listeners.dart"]);
    }
    const wrapResult = wrapAppWithPxWidget(newContent);
    newContent = wrapResult.content;
    const observerResult = ensurePxNavigatorObserver(newContent);
    newContent = observerResult.content;
    const registerResult = ensurePxRegistrations(newContent, includeListenerImport);
    newContent = registerResult.content;
    if (newContent === originalContent) {
        const missingSignals = !originalContent.includes("SmartechPxWidget") ||
            !originalContent.includes("PxNavigationObserver") ||
            !originalContent.includes("registerPxDeeplinkListener") ||
            !originalContent.includes("registerPxInternalEventsListener");
        if (missingSignals) {
            return buildChange({
                id: "flutter-main-dart-px-missing",
                title: "PX hooks not injected",
                filePath,
                kind: "insert",
                originalContent,
                newContent: originalContent,
                summary: "Could not safely wrap the top-level app widget or inject PX hooks. Please add PX hooks manually.",
                confidence: 0.2,
                manualSnippet: FLUTTER_PX_WIDGET_SNIPPET
            });
        }
        return null;
    }
    return buildChange({
        id: "flutter-main-dart-px",
        title: "Add Smartech PX setup in main.dart",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Wrap app with SmartechPxWidget and register PX listeners.",
        confidence: 0.35
    });
}
function ensureDartImports(source, imports) {
    let updated = source;
    const missing = imports.filter((imp) => !updated.includes(`import '${imp}';`));
    if (missing.length === 0)
        return updated;
    const importBlock = missing.map((imp) => `import '${imp}';`).join("\n");
    const lastImportMatch = [...updated.matchAll(/import\s+['"][^'"]+['"];\n/g)].pop();
    if (lastImportMatch) {
        const index = lastImportMatch.index ?? 0;
        const end = index + lastImportMatch[0].length;
        updated = `${updated.slice(0, end)}${importBlock}\n${updated.slice(end)}`;
    }
    else {
        updated = `${importBlock}\n\n${updated}`;
    }
    return updated;
}
async function findPxListeners(libDir) {
    if (!(await pathExists(libDir)))
        return { hasAny: false };
    const files = await walkFiles(libDir, [".dart"]);
    for (const filePath of files) {
        const contents = await fs.readFile(filePath, "utf-8");
        if (/extends\s+PxDeeplinkListener/.test(contents)) {
            return { hasAny: true };
        }
        if (/extends\s+PxInternalEventsListener/.test(contents)) {
            return { hasAny: true };
        }
    }
    return { hasAny: false };
}
function buildPxListenerFileChange(rootPath) {
    const filePath = path.join(rootPath, "lib", "smartech_px_listeners.dart");
    const content = `import 'package:flutter/foundation.dart';\nimport 'package:smartech_nudges/smartech_nudges.dart';\n\nclass _PxDeeplinkListenerImpl extends PxDeeplinkListener {\n  @override\n  void onLaunchUrl(String url) {\n    debugPrint('PXDeeplink: $url');\n  }\n}\n\nclass _PxInternalEventsListener extends PxInternalEventsListener {\n  @override\n  void onEvent(String eventName, Map dataFromHansel) {\n    debugPrint('PXEvent: $eventName eventData : $dataFromHansel');\n  }\n}\n`;
    return buildChange({
        id: "flutter-px-listeners",
        title: "Add PX listener implementations",
        filePath,
        kind: "create",
        originalContent: "",
        newContent: content,
        summary: "Create PX deeplink and internal events listener classes.",
        confidence: 0.35
    });
}
function buildPxListenerAppendChange(filePath, originalContent) {
    const content = `\nimport 'package:flutter/foundation.dart';\nimport 'package:smartech_nudges/smartech_nudges.dart';\n\nclass _PxDeeplinkListenerImpl extends PxDeeplinkListener {\n  @override\n  void onLaunchUrl(String url) {\n    debugPrint('PXDeeplink: $url');\n  }\n}\n\nclass _PxInternalEventsListener extends PxInternalEventsListener {\n  @override\n  void onEvent(String eventName, Map dataFromHansel) {\n    debugPrint('PXEvent: $eventName eventData : $dataFromHansel');\n  }\n}\n`;
    const newContent = `${originalContent.trimEnd()}\n${content}`;
    return buildChange({
        id: "flutter-px-listeners-append",
        title: "Append PX listener implementations",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Append PX deeplink and internal events listener classes.",
        confidence: 0.3
    });
}
function wrapAppWithPxWidget(source) {
    if (source.includes("SmartechPxWidget("))
        return { updated: false, content: source };
    const widgetNames = ["MaterialApp", "CupertinoApp", "WidgetsApp"];
    for (const widget of widgetNames) {
        const match = source.match(new RegExp(`return\\s+${widget}\\s*\\(`));
        if (!match || match.index === undefined)
            continue;
        const returnIndex = match.index;
        const widgetStart = source.indexOf(`${widget}(`, returnIndex);
        const openIndex = source.indexOf("(", widgetStart);
        if (openIndex === -1)
            continue;
        let depth = 0;
        let endIndex = -1;
        for (let i = openIndex; i < source.length; i += 1) {
            if (source[i] === "(")
                depth += 1;
            if (source[i] === ")")
                depth -= 1;
            if (depth === 0) {
                endIndex = i;
                break;
            }
        }
        if (endIndex === -1)
            continue;
        const lineStart = source.lastIndexOf("\n", returnIndex) + 1;
        const indent = source.slice(lineStart, returnIndex);
        const widgetCall = source.slice(widgetStart, endIndex + 1);
        const wrapped = `${indent}return SmartechPxWidget(\n${indent}  child: ${widgetCall}\n${indent});`;
        const beforeReturn = source.slice(0, lineStart);
        let afterReturn = source.slice(endIndex + 1);
        if (afterReturn.trimStart().startsWith(";")) {
            afterReturn = afterReturn.replace(/^\s*;/, "");
        }
        return { updated: true, content: `${beforeReturn}${wrapped}${afterReturn}` };
    }
    return { updated: false, content: source };
}
function ensurePxNavigatorObserver(source) {
    if (source.includes("PxNavigationObserver"))
        return { updated: false, content: source };
    if (source.includes("GoRouter(")) {
        return {
            updated: true,
            content: source.replace(/GoRouter\s*\(/, "GoRouter(\n  observers: [PxNavigationObserver.instance],")
        };
    }
    const appMatch = source.match(/(MaterialApp|CupertinoApp|WidgetsApp)\s*\(/);
    if (!appMatch || appMatch.index === undefined)
        return { updated: false, content: source };
    const insertAt = appMatch.index + appMatch[0].length;
    const insert = "\n      navigatorObservers: [PxNavigationObserver()],";
    return { updated: true, content: `${source.slice(0, insertAt)}${insert}${source.slice(insertAt)}` };
}
function ensurePxRegistrations(source, shouldRegister) {
    if (!shouldRegister)
        return { updated: false, content: source };
    let updated = source;
    const hasDeeplinkReg = /registerPxDeeplinkListener/.test(source);
    const hasInternalReg = /registerPxInternalEventsListener/.test(source);
    if (hasDeeplinkReg && hasInternalReg)
        return { updated: false, content: source };
    const mainMatch = updated.match(/(Future<void>\s+main\(\)\s*(async\s*)?\{|void\s+main\(\)\s*(async\s*)?\{)/);
    if (!mainMatch || mainMatch.index === undefined)
        return { updated: false, content: source };
    const braceIndex = updated.indexOf("{", mainMatch.index);
    if (braceIndex === -1)
        return { updated: false, content: source };
    const lines = [];
    if (!hasDeeplinkReg) {
        lines.push("  NetcorePX.instance.registerPxDeeplinkListener(_PxDeeplinkListenerImpl());");
    }
    if (!hasInternalReg) {
        lines.push("  NetcorePX.instance.registerPxInternalEventsListener(_PxInternalEventsListener());");
    }
    if (lines.length === 0)
        return { updated: false, content: source };
    const insertBlock = `${lines.join("\n")}\n`;
    updated = `${updated.slice(0, braceIndex + 1)}\n${insertBlock}${updated.slice(braceIndex + 1)}`;
    return { updated: true, content: updated };
}
async function findLauncherActivity(manifestPath, sourceRoots) {
    if (!(await pathExists(manifestPath)))
        return null;
    const manifest = await fs.readFile(manifestPath, "utf-8");
    const activityBlocks = manifest.match(/<activity[\s\S]*?<\/activity>/g) ?? [];
    let launcherName = null;
    for (const block of activityBlocks) {
        if (!block.includes("android.intent.action.MAIN") || !block.includes("android.intent.category.LAUNCHER")) {
            continue;
        }
        const nameMatch = block.match(/android:name=\"([^\"]+)\"/);
        if (!nameMatch)
            continue;
        const manifestName = nameMatch[1];
        launcherName = manifestName;
        const fqcn = resolveActivityClass(manifestName, manifest);
        const found = await locateJavaOrKotlinFile(sourceRoots, fqcn);
        if (found)
            return { filePath: found, manifestName };
    }
    if (launcherName) {
        const fallback = await findFlutterActivityClass(sourceRoots);
        if (fallback) {
            return { filePath: fallback.filePath, manifestName: launcherName };
        }
    }
    return null;
}
async function ensurePxIntentFilter(manifestPath, activityName, scheme) {
    if (!(await pathExists(manifestPath)) || !scheme)
        return null;
    const originalContent = await fs.readFile(manifestPath, "utf-8");
    let newContent = originalContent;
    const dataTagRegex = /<data[^>]*android:scheme=\"([^\"]+)\"(?![^>]*android:host)[^>]*\/?>/;
    const dataMatch = originalContent.match(dataTagRegex);
    if (dataMatch) {
        const currentScheme = dataMatch[1];
        if (currentScheme === scheme) {
            return null;
        }
        newContent = originalContent.replace(dataTagRegex, (match) => match.replace(/android:scheme=\"[^\"]+\"/, `android:scheme=\"${scheme}\"`));
    }
    const intentFilter = `        <intent-filter>\n            <action android:name=\"android.intent.action.VIEW\" />\n            <category android:name=\"android.intent.category.DEFAULT\" />\n            <category android:name=\"android.intent.category.BROWSABLE\" />\n            <data android:scheme=\"${scheme}\" />\n        </intent-filter>`;
    const activityPattern = new RegExp(`<activity[^>]*android:name=\\"${escapeRegex(activityName)}\\"[^>]*>`);
    if (!dataMatch && activityPattern.test(newContent)) {
        newContent = newContent.replace(activityPattern, (match) => `${match}\n${intentFilter}`);
    }
    if (newContent === originalContent)
        return null;
    return buildChange({
        id: "flutter-manifest-px-intent",
        title: "Add PX deeplink intent filter",
        filePath: manifestPath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Add PX deeplink intent filter to launcher activity.",
        confidence: 0.4
    });
}
async function ensurePxMainActivity(filePath) {
    const originalContent = await fs.readFile(filePath, "utf-8");
    const isKotlin = filePath.endsWith(".kt");
    const importLine = isKotlin
        ? "import io.hansel.hanselsdk.Hansel"
        : "import io.hansel.hanselsdk.Hansel;";
    let newContent = originalContent;
    if (!newContent.includes(importLine)) {
        newContent = newContent.replace(/(package\s+[^;\n]+;?\n)/, `$1${importLine}\n`);
    }
    if (newContent.includes("Hansel.pairTestDevice")) {
        return null;
    }
    if (isKotlin) {
        if (/fun\s+onCreate\s*\(/.test(newContent)) {
            newContent = newContent.replace(/super\.onCreate\s*\(\s*.*\)/, (match) => `${match}\n        Hansel.pairTestDevice(intent?.dataString)`);
        }
        else {
            newContent = newContent.replace(/class\s+\w+\s*:\s*\w+\s*\(\s*\)\s*\{/, (match) => `${match}\n\n    override fun onCreate(savedInstanceState: android.os.Bundle?) {\n        super.onCreate(savedInstanceState)\n        Hansel.pairTestDevice(intent?.dataString)\n    }\n`);
        }
    }
    else {
        if (/void\s+onCreate\s*\(/.test(newContent)) {
            newContent = newContent.replace(/super\.onCreate\s*\(\s*[^\)]*\)\s*;?/, (match) => `${match}\n        Hansel.pairTestDevice(getIntent().getDataString());`);
        }
        else {
            newContent = newContent.replace(/class\s+\w+\s+extends\s+\w+\s*\{/, (match) => `${match}\n\n    @Override\n    protected void onCreate(android.os.Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        Hansel.pairTestDevice(getIntent().getDataString());\n    }\n`);
        }
    }
    if (newContent === originalContent)
        return null;
    return buildChange({
        id: "flutter-mainactivity-hansel",
        title: "Add Hansel pairTestDevice in MainActivity",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Call Hansel.pairTestDevice after super.onCreate in launcher activity.",
        confidence: 0.4
    });
}
function resolveActivityClass(name, manifest) {
    const packageMatch = manifest.match(/package\s*=\s*"([^"]+)"/);
    const manifestPackage = packageMatch ? packageMatch[1] : "";
    if (name.startsWith(".")) {
        return manifestPackage ? `${manifestPackage}${name}` : name.slice(1);
    }
    if (name.includes(".")) {
        return name;
    }
    return `${manifestPackage}.${name}`;
}
async function locateJavaOrKotlinFile(sourceRoots, fqcn) {
    const pathSegments = fqcn.split(".");
    const className = pathSegments.pop() ?? "";
    const packagePath = pathSegments.join(path.sep);
    for (const root of sourceRoots) {
        const javaPath = path.join(root, packagePath, `${className}.java`);
        const kotlinPath = path.join(root, packagePath, `${className}.kt`);
        if (await pathExists(javaPath))
            return javaPath;
        if (await pathExists(kotlinPath))
            return kotlinPath;
    }
    if (className) {
        const fallback = await findByClassName(sourceRoots, className);
        if (fallback)
            return fallback;
    }
    return null;
}
async function findFlutterActivityClass(sourceRoots) {
    for (const root of sourceRoots) {
        const candidates = await walkFiles(root, [".java", ".kt"]);
        for (const filePath of candidates) {
            const contents = await fs.readFile(filePath, "utf-8");
            if (/extends\s+FlutterActivity/.test(contents)) {
                return { filePath };
            }
            if (/class\s+\w+\s*:\s*FlutterActivity/.test(contents)) {
                return { filePath };
            }
        }
    }
    return null;
}
async function findByClassName(sourceRoots, className) {
    for (const root of sourceRoots) {
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(root, entry.name);
            if (entry.isDirectory()) {
                const found = await findByClassName([fullPath], className);
                if (found)
                    return found;
                continue;
            }
            if (entry.name === `${className}.java` || entry.name === `${className}.kt`) {
                return fullPath;
            }
        }
    }
    return null;
}
async function walkFiles(root, extensions) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await walkFiles(fullPath, extensions)));
            continue;
        }
        if (extensions.some((ext) => entry.name.endsWith(ext))) {
            files.push(fullPath);
        }
    }
    return files;
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
