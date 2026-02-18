import path from "node:path";
import { promises as fs } from "node:fs";
import type { Change, IntegrationOptions, ProjectScan } from "@smartech/shared";
import { pathExists } from "../utils/fs.js";
import { createUnifiedDiff } from "../utils/diff.js";
import { resolveAndroidProjectLayout, type AndroidProjectLayout } from "../utils/androidProject.js";

const DEFAULT_PX_SDK_VERSION = "10.2.17";

type NativePxContext = {
  scan: ProjectScan;
  rootPath: string;
  inputs?: IntegrationOptions["inputs"];
};

type NativePxUiType = "xml" | "compose" | "mixed";

export async function runNativePxRules(context: NativePxContext): Promise<Change[]> {
  const changes: Change[] = [];
  const inputs = context.inputs ?? {};
  const androidLayout = await resolveAndroidProjectLayout(context.rootPath, "native");

  const uiType = normalizeUiType(inputs.nativePxUiType);
  const pxSdkVersion = inputs.pxSdkVersion?.trim() || DEFAULT_PX_SDK_VERSION;
  const pxScheme = inputs.pxScheme?.trim() ?? "";
  const hanselAppId = inputs.hanselAppId?.trim() ?? "";
  const hanselAppKey = inputs.hanselAppKey?.trim() ?? "";
  const useSdkEncryption = inputs.useSdkEncryption ?? false;

  const applicationClassPathInput = inputs.applicationClassPath?.trim();
  const mainActivityPathInput = inputs.mainActivityPath?.trim();
  const applicationClassPath = applicationClassPathInput
    ? resolveInputPath(context.rootPath, applicationClassPathInput)
    : "";
  const mainActivityPath = mainActivityPathInput
    ? resolveInputPath(context.rootPath, mainActivityPathInput)
    : "";

  const dependencyChange = await ensureNativePxDependency(androidLayout, pxSdkVersion, uiType);
  if (dependencyChange) changes.push(dependencyChange);

  const manifestPath = androidLayout.manifestPath;
  if (hanselAppId) {
    const appIdChange = await ensureManifestMetaData(manifestPath, "HANSEL_APP_ID", hanselAppId);
    if (appIdChange) changes.push(appIdChange);
  }
  if (hanselAppKey) {
    const appKeyChange = await ensureManifestMetaData(manifestPath, "HANSEL_APP_KEY", hanselAppKey);
    if (appKeyChange) changes.push(appKeyChange);
  }

  const encryptionChange = await ensureManifestMetaData(
    manifestPath,
    "SMT_USE_ENCRYPTION",
    useSdkEncryption ? "true" : "false"
  );
  if (encryptionChange) changes.push(encryptionChange);

  const activityName = await inferManifestActivityName(manifestPath, mainActivityPath || null);
  const intentFilterChange = await ensurePxIntentFilter(manifestPath, activityName, pxScheme);
  if (intentFilterChange) {
    changes.push(intentFilterChange);
  } else if (pxScheme && !activityName) {
    changes.push({
      id: "native-px-intent-filter-manual",
      title: "PX intent-filter not injected",
      filePath: manifestPath,
      kind: "insert",
      patch: "",
      summary: "Could not locate launcher/MainActivity in AndroidManifest.xml to add PX scheme intent-filter.",
      confidence: 0.2,
      manualSnippet: `<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="YOUR_CUSTOM_SCHEME" />
</intent-filter>`,
      module: "px"
    });
  }

  if (!mainActivityPath) {
    changes.push({
      id: "native-px-mainactivity-path-missing",
      title: "MainActivity path missing for PX pairing",
      filePath: context.rootPath,
      kind: "insert",
      patch: "",
      summary: "Provide MainActivity path to inject Hansel.pairTestDevice.",
      confidence: 0.2,
      module: "px"
    });
  } else {
    const mainActivityChange = await ensureMainActivityPairing(mainActivityPath);
    if (mainActivityChange) changes.push(mainActivityChange);
  }

  if (!applicationClassPath) {
    changes.push({
      id: "native-px-application-path-missing",
      title: "Application class path missing for PX listeners",
      filePath: context.rootPath,
      kind: "insert",
      patch: "",
      summary: "Provide Application class path to inject Hansel listener and debug hooks.",
      confidence: 0.2,
      module: "px"
    });
  } else {
    const appHooksChange = await ensureApplicationPxHooks(applicationClassPath);
    if (appHooksChange) changes.push(appHooksChange);
  }

  return changes;
}

function buildChange(input: Omit<Change, "patch">): Change {
  const patch = createUnifiedDiff(input.filePath, input.originalContent ?? "", input.newContent ?? "");
  return { module: "px", ...input, patch };
}

function normalizeUiType(value: string | undefined): NativePxUiType {
  if (value === "compose" || value === "mixed") return value;
  return "xml";
}

function resolveInputPath(rootPath: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.join(rootPath, inputPath);
}

async function ensureNativePxDependency(
  androidLayout: AndroidProjectLayout,
  version: string,
  uiType: NativePxUiType
): Promise<Change | null> {
  const filePath = (await pathExists(androidLayout.appBuildGradleKts))
    ? androidLayout.appBuildGradleKts
    : androidLayout.appBuildGradle;
  if (!(await pathExists(filePath))) return null;

  const isKotlin = filePath.endsWith(".kts");
  const artifact = uiType === "xml" ? "smartech-nudges" : "smartech-nudges-compose";
  const depLine = isKotlin
    ? `implementation(\"com.netcore.android:${artifact}:${version}\")`
    : `implementation 'com.netcore.android:${artifact}:${version}'`;

  const originalContent = await fs.readFile(filePath, "utf-8");
  const dependencyRegex = isKotlin
    ? /implementation\s*\(\s*["']com\.netcore\.android:smartech-nudges(?:-compose)?:[^"']+["']\s*\)/g
    : /implementation\s+["']com\.netcore\.android:smartech-nudges(?:-compose)?:[^"']+["']/g;

  let newContent = originalContent;
  const matches = [...originalContent.matchAll(dependencyRegex)];
  if (matches.length > 0) {
    let replaced = false;
    newContent = originalContent.replace(dependencyRegex, () => {
      if (!replaced) {
        replaced = true;
        return depLine;
      }
      return "";
    });
    newContent = newContent.replace(/\n{3,}/g, "\n\n");
  } else if (/dependencies\s*\{/.test(originalContent)) {
    newContent = originalContent.replace(/dependencies\s*\{/, (match) => `${match}\n    ${depLine}`);
  } else {
    newContent = `${originalContent.trimEnd()}\n\ndependencies {\n    ${depLine}\n}\n`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "native-px-dependency",
    title: "Add Smartech PX native dependency",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add/update Smartech nudges dependency based on selected UI type (XML or Compose).",
    confidence: 0.45
  });
}

async function ensureManifestMetaData(
  manifestPath: string,
  name: string,
  value: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath))) return null;
  const originalContent = await fs.readFile(manifestPath, "utf-8");
  const line = `    <meta-data\n        android:name=\"${name}\"\n        android:value=\"${value}\" />`;

  let newContent = originalContent;
  const metaRegex = new RegExp(
    `<meta-data[^>]*android:name\\s*=\\s*\"${escapeRegex(name)}\"[^>]*\\/?>`,
    "m"
  );

  if (metaRegex.test(originalContent)) {
    newContent = originalContent.replace(metaRegex, line);
  } else if (/<application[^>]*>/.test(originalContent)) {
    newContent = originalContent.replace(/<application[^>]*>/, (match) => `${match}\n${line}`);
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: `native-px-meta-${name.toLowerCase()}`,
    title: `Set ${name} meta-data`,
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: `Add or update ${name} in AndroidManifest.xml.`,
    confidence: 0.4
  });
}

async function ensurePxIntentFilter(
  manifestPath: string,
  activityName: string | null,
  scheme: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath)) || !activityName || !scheme) return null;

  const originalContent = await fs.readFile(manifestPath, "utf-8");
  const activityBlock = findActivityBlockByName(originalContent, activityName);
  if (!activityBlock) return null;

  const pxFilterRegex = /<intent-filter[\s\S]*?<\/intent-filter>/g;
  const filters = activityBlock.match(pxFilterRegex) ?? [];

  let pxFilter: string | null = null;
  for (const filter of filters) {
    const hasView = /android\.intent\.action\.VIEW/.test(filter);
    const hasDefault = /android\.intent\.category\.DEFAULT/.test(filter);
    const hasBrowsable = /android\.intent\.category\.BROWSABLE/.test(filter);
    const hasHost = /android:host\s*=/.test(filter);
    const hasDataTag = /<data[^>]*>/.test(filter) || /<data[^>]*\/>/.test(filter);
    if (hasView && hasDefault && hasBrowsable && hasDataTag && !hasHost) {
      pxFilter = filter;
      break;
    }
  }

  let updatedActivityBlock = activityBlock;
  if (pxFilter) {
    let updatedFilter = pxFilter;
    if (/android:scheme\s*=/.test(updatedFilter)) {
      updatedFilter = updatedFilter.replace(/android:scheme=\"[^\"]*\"/, `android:scheme=\"${scheme}\"`);
    } else if (/<data[^>]*\/>/.test(updatedFilter)) {
      updatedFilter = updatedFilter.replace(/<data([^>]*)\/>/, `<data$1 android:scheme=\"${scheme}\" />`);
    } else {
      updatedFilter = updatedFilter.replace(
        /<\/intent-filter>/,
        `    <data android:scheme=\"${scheme}\" />\n</intent-filter>`
      );
    }
    updatedActivityBlock = activityBlock.replace(pxFilter, updatedFilter);
  } else {
    const pxIntentFilter = `        <intent-filter>\n            <action android:name=\"android.intent.action.VIEW\" />\n            <category android:name=\"android.intent.category.DEFAULT\" />\n            <category android:name=\"android.intent.category.BROWSABLE\" />\n            <data android:scheme=\"${scheme}\" />\n        </intent-filter>`;
    updatedActivityBlock = activityBlock.replace(/<activity[^>]*>/, (match) => `${match}\n${pxIntentFilter}`);
  }

  const newContent = originalContent.replace(activityBlock, updatedActivityBlock);
  if (newContent === originalContent) return null;

  return buildChange({
    id: "native-px-manifest-intent-filter",
    title: "Add Hansel deeplink intent filter",
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add/update PX intent-filter with scheme in launcher/MainActivity.",
    confidence: 0.45
  });
}

async function ensureMainActivityPairing(filePath: string): Promise<Change | null> {
  if (!(await pathExists(filePath))) {
    return {
      id: "native-px-mainactivity-not-found",
      title: "MainActivity not found for PX pairing",
      filePath,
      kind: "insert",
      patch: "",
      summary: "Provided MainActivity path does not exist.",
      confidence: 0.2,
      module: "px"
    };
  }

  const isKotlin = filePath.endsWith(".kt");
  const pairLine = isKotlin
    ? "Hansel.pairTestDevice(intent?.dataString)"
    : "Hansel.pairTestDevice(getIntent().getDataString());";
  const importLine = "io.hansel.hanselsdk.Hansel";

  const originalContent = await fs.readFile(filePath, "utf-8");
  let updated = isKotlin
    ? ensureKotlinImports(originalContent, [importLine])
    : ensureJavaImports(originalContent, [importLine]);

  if (!/Hansel\.pairTestDevice\s*\(/.test(updated)) {
    if (/onCreate\s*\(/.test(updated)) {
      updated = insertAfterSuperOnCreate(updated, [pairLine]);
    } else {
      updated = addActivityOnCreateMethod(updated, pairLine, isKotlin);
    }
  }

  if (updated === originalContent) return null;

  return buildChange({
    id: "native-px-mainactivity-pairing",
    title: "Add Hansel pairTestDevice in MainActivity",
    filePath,
    kind: "insert",
    originalContent,
    newContent: updated,
    summary: "Ensure Hansel.pairTestDevice is added under super.onCreate() in MainActivity.",
    confidence: 0.5
  });
}

async function ensureApplicationPxHooks(filePath: string): Promise<Change | null> {
  if (!(await pathExists(filePath))) {
    return {
      id: "native-px-application-not-found",
      title: "Application class not found for PX hooks",
      filePath,
      kind: "insert",
      patch: "",
      summary: "Provided Application class path does not exist.",
      confidence: 0.2,
      module: "px"
    };
  }

  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kt");
  let updated = originalContent;

  updated = isKotlin
    ? ensureKotlinImports(updated, [
        "java.lang.ref.WeakReference",
        "java.util.HashMap",
        "com.netcore.android.Smartech",
        "io.hansel.core.logger.HSLLogLevel",
        "io.hansel.hanselsdk.Hansel",
        "io.hansel.hanselsdk.HanselDeepLinkListener",
        "io.hansel.ujmtracker.HanselInternalEventsListener",
        "io.hansel.ujmtracker.HanselTracker"
      ])
    : ensureJavaImports(updated, [
        "java.lang.ref.WeakReference",
        "java.util.HashMap",
        "com.netcore.android.Smartech",
        "io.hansel.core.logger.HSLLogLevel",
        "io.hansel.hanselsdk.Hansel",
        "io.hansel.hanselsdk.HanselDeepLinkListener",
        "io.hansel.ujmtracker.HanselInternalEventsListener",
        "io.hansel.ujmtracker.HanselTracker"
      ]);

  const hasInternalListener = /HanselTracker\.registerListener\s*\(/.test(updated);
  const hasDeepLinkListener = /registerHanselDeeplinkListener\s*\(/.test(updated);
  const hasDebugLogs = /Hansel\.enableDebugLogs\s*\(\s*\)/.test(updated);

  const blocks: string[] = [];
  if (!hasInternalListener) blocks.push(isKotlin ? kotlinInternalEventBlock() : javaInternalEventBlock());
  if (!hasDeepLinkListener) blocks.push(isKotlin ? kotlinDeepLinkBlock() : javaDeepLinkBlock());
  if (!hasDebugLogs) blocks.push(isKotlin ? kotlinDebugBlock() : javaDebugBlock());

  if (blocks.length > 0) {
    updated = insertApplicationBlocks(updated, blocks.join("\n\n"), isKotlin);
  }

  if (updated === originalContent) return null;

  return buildChange({
    id: "native-px-application-hooks",
    title: "Add Hansel listeners and debug hooks in Application",
    filePath,
    kind: "insert",
    originalContent,
    newContent: updated,
    summary:
      "Ensure Hansel internal event listener, deeplink listener, and debug logging are registered after SDK init.",
    confidence: 0.5
  });
}

function javaInternalEventBlock(): string {
  return [
    "        HanselInternalEventsListener hanselInternalEventsListener =",
    "                (eventName, dataFromHansel) -> {",
    "                    Smartech.getInstance(new WeakReference<>(getApplicationContext()))",
    "                            .trackEvent(eventName, (HashMap<String, Object>) dataFromHansel);",
    "                    // Add other analytics platform if needed",
    "                };",
    "",
    "        HanselTracker.registerListener(hanselInternalEventsListener);"
  ].join("\n");
}

function kotlinInternalEventBlock(): string {
  return [
    "        val hanselInternalEventsListener =",
    "            HanselInternalEventsListener { eventName, dataFromHansel ->",
    "                Smartech.getInstance(WeakReference(applicationContext))",
    "                    .trackEvent(eventName, dataFromHansel as HashMap<String, Any>)",
    "                // Add other analytics platform",
    "            }",
    "",
    "        HanselTracker.registerListener(hanselInternalEventsListener)"
  ].join("\n");
}

function javaDeepLinkBlock(): string {
  return [
    "        HanselDeepLinkListener hanselDeepLinkListener = (url) -> {",
    "            // deeplink redirection for hansel",
    "        };",
    "",
    "        Hansel.registerHanselDeeplinkListener(hanselDeepLinkListener);"
  ].join("\n");
}

function kotlinDeepLinkBlock(): string {
  return [
    "        val hanselDeepLinkListener = HanselDeepLinkListener { url ->",
    "            // deeplink redirection for hansel",
    "        }",
    "",
    "        Hansel.registerHanselDeeplinkListener(hanselDeepLinkListener)"
  ].join("\n");
}

function javaDebugBlock(): string {
  return [
    "        HSLLogLevel.all.setEnabled(true);",
    "        HSLLogLevel.mid.setEnabled(true);",
    "        HSLLogLevel.debug.setEnabled(true);",
    "        Hansel.enableDebugLogs();"
  ].join("\n");
}

function kotlinDebugBlock(): string {
  return [
    "        HSLLogLevel.all.setEnabled(true)",
    "        HSLLogLevel.mid.setEnabled(true)",
    "        HSLLogLevel.debug.setEnabled(true)",
    "        Hansel.enableDebugLogs()"
  ].join("\n");
}

function insertApplicationBlocks(source: string, block: string, isKotlin: boolean): string {
  if (!block.trim()) return source;
  const anchors = [
    /Smartech\.getInstance\([^\n]+\)\.(trackAppInstallUpdateBySmartech\([^\n]*\))\s*;?/,
    /Smartech\.getInstance\([^\n]+\)\.(initializeSdk\([^\n]*\))\s*;?/,
    /super\.onCreate\s*\(\s*[^\)]*\)\s*;?/
  ];

  for (const anchor of anchors) {
    if (anchor.test(source)) {
      return source.replace(anchor, (match) => `${match}\n\n${block}`);
    }
  }

  if (/onCreate\s*\(/.test(source)) return source;

  return addApplicationOnCreateMethod(source, block, isKotlin);
}

function addApplicationOnCreateMethod(source: string, block: string, isKotlin: boolean): string {
  if (isKotlin) {
    return source.replace(
      /class\s+\w+[^{]*\{/,
      (match) => `${match}\n\n    override fun onCreate() {\n        super.onCreate()\n\n${block}\n    }\n`
    );
  }

  return source.replace(
    /class\s+\w+[^{]*\{/,
    (match) =>
      `${match}\n\n    @Override\n    public void onCreate() {\n        super.onCreate();\n\n${block}\n    }\n`
  );
}

function insertAfterSuperOnCreate(source: string, lines: string[]): string {
  if (lines.length === 0) return source;
  const regex = /super\.onCreate\s*\(\s*[^\)]*\)\s*;?/;
  if (!regex.test(source)) return source;
  const block = lines.map((line) => `        ${line}`).join("\n");
  return source.replace(regex, (match) => `${match}\n${block}`);
}

function addActivityOnCreateMethod(source: string, pairLine: string, isKotlin: boolean): string {
  if (isKotlin) {
    return source.replace(
      /class\s+\w+[^{]*\{/,
      (match) =>
        `${match}\n\n    override fun onCreate(savedInstanceState: android.os.Bundle?) {\n        super.onCreate(savedInstanceState)\n        ${pairLine}\n    }\n`
    );
  }

  return source.replace(
    /class\s+\w+[^{]*\{/,
    (match) =>
      `${match}\n\n    @Override\n    protected void onCreate(android.os.Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        ${pairLine}\n    }\n`
  );
}

function ensureJavaImports(source: string, imports: string[]): string {
  let updated = source;
  for (const imp of imports) {
    if (!updated.includes(`import ${imp};`)) {
      updated = updated.replace(/(package\s+[^;]+;\s*)/m, `$1\nimport ${imp};\n`);
    }
  }
  return updated;
}

function ensureKotlinImports(source: string, imports: string[]): string {
  let updated = source;
  for (const imp of imports) {
    if (!updated.includes(`import ${imp}`)) {
      updated = updated.replace(/(package\s+[^\n]+\n)/, `$1import ${imp}\n`);
    }
  }
  return updated;
}

async function inferManifestActivityName(
  manifestPath: string,
  mainActivityPath: string | null
): Promise<string | null> {
  if (!(await pathExists(manifestPath))) return null;
  const manifest = await fs.readFile(manifestPath, "utf-8");

  if (mainActivityPath && (await pathExists(mainActivityPath))) {
    const source = await fs.readFile(mainActivityPath, "utf-8");
    const manifestPackage = readManifestPackage(manifest);
    const classPackage = readPackageName(source);
    const className = path.basename(mainActivityPath, path.extname(mainActivityPath));
    const candidates = [
      className,
      `.${className}`,
      classPackage ? `${classPackage}.${className}` : null,
      manifestPackage ? `${manifestPackage}.${className}` : null
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (findActivityBlockByName(manifest, candidate)) return candidate;
    }
  }

  const launcherBlocks = manifest.match(/<activity[\s\S]*?<\/activity>/g) ?? [];
  for (const block of launcherBlocks) {
    if (!block.includes("android.intent.action.MAIN") || !block.includes("android.intent.category.LAUNCHER")) {
      continue;
    }
    const nameMatch = block.match(/android:name=\"([^\"]+)\"/);
    if (nameMatch?.[1]) return nameMatch[1];
  }

  return null;
}

function findActivityBlockByName(manifest: string, activityName: string): string | null {
  const blocks = manifest.match(/<activity[\s\S]*?<\/activity>/g) ?? [];
  for (const block of blocks) {
    const nameMatch = block.match(/android:name=\"([^\"]+)\"/);
    if (nameMatch?.[1] === activityName) return block;
  }
  return null;
}

function readManifestPackage(manifest: string): string | null {
  const match = manifest.match(/package\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function readPackageName(source: string): string | null {
  const match = source.match(/package\s+([^\s;]+)/);
  return match ? match[1] : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
