import path from "node:path";
import { promises as fs } from "node:fs";
import type { Change, IntegrationOptions, ProjectScan } from "@smartech/shared";
import { pathExists } from "../utils/fs.js";
import { createUnifiedDiff } from "../utils/diff.js";
import { resolveAndroidProjectLayout, type AndroidProjectLayout } from "../utils/androidProject.js";

const SMARTECH_MAVEN = "https://artifacts.netcore.co.in/artifactory/android";
const DEFAULT_BASE_SDK_VERSION = "3.7.6";

const JAVA_INIT_LINES = [
  "Smartech.getInstance(new WeakReference<>(getApplicationContext())).initializeSdk(this);",
  "Smartech.getInstance(new WeakReference<>(getApplicationContext())).setDebugLevel(9);",
  "Smartech.getInstance(new WeakReference<>(getApplicationContext())).trackAppInstallUpdateBySmartech();"
];

const KOTLIN_INIT_LINES = [
  "Smartech.getInstance(WeakReference(applicationContext)).initializeSdk(this)",
  "Smartech.getInstance(WeakReference(applicationContext)).setDebugLevel(9)",
  "Smartech.getInstance(WeakReference(applicationContext)).trackAppInstallUpdateBySmartech()"
];

const JAVA_DEEPLINK_LINES = [
  "boolean isSmartechHandledDeeplink =",
  "        Smartech.getInstance(new WeakReference<>(this))",
  "                .isDeepLinkFromSmartech(getIntent());",
  "",
  "if (!isSmartechHandledDeeplink) {",
  "    // Handle deeplink",
  "}"
];

const KOTLIN_DEEPLINK_LINES = [
  "val isSmartechHandledDeeplink =",
  "    Smartech.getInstance(WeakReference(this))",
  "        .isDeepLinkFromSmartech(intent)",
  "",
  "if (!isSmartechHandledDeeplink) {",
  "    // Handle deeplink",
  "}"
];

type NativeBaseContext = {
  scan: ProjectScan;
  rootPath: string;
  inputs?: IntegrationOptions["inputs"];
};

export async function runNativeBaseRules(context: NativeBaseContext): Promise<Change[]> {
  const changes: Change[] = [];

  const rootPath = context.rootPath;
  const androidLayout = await resolveAndroidProjectLayout(rootPath, "native");
  const manifestPath = androidLayout.manifestPath;
  const inputs = context.inputs ?? {};

  const appId = inputs.smartechAppId ?? "";
  const scheme = inputs.deeplinkScheme ?? "";
  const baseSdkVersion = inputs.baseSdkVersion ?? DEFAULT_BASE_SDK_VERSION;

  const applicationClassPathInput = inputs.applicationClassPath?.trim();
  const mainActivityPathInput = inputs.mainActivityPath?.trim();

  if (!applicationClassPathInput || !mainActivityPathInput) {
    changes.push({
      id: "native-input-paths-missing",
      title: "Application/MainActivity paths missing",
      filePath: rootPath,
      kind: "insert",
      patch: "",
      summary: "Provide both Application class path and MainActivity path for Native Android Base integration.",
      confidence: 0.2,
      module: "base"
    });
    return changes;
  }

  const applicationClassPath = resolveInputPath(rootPath, applicationClassPathInput);
  const mainActivityPath = resolveInputPath(rootPath, mainActivityPathInput);

  const mavenChange = await ensureMavenRepo(androidLayout);
  if (mavenChange) changes.push(mavenChange);

  const dependencyChange = await ensureBaseDependency(androidLayout, baseSdkVersion);
  if (dependencyChange) changes.push(dependencyChange);

  const appIdChange = await ensureManifestMetaData(manifestPath, "SMT_APP_ID", appId);
  if (appIdChange) changes.push(appIdChange);

  if (typeof inputs.autoFetchLocation === "boolean") {
    const locationChange = await ensureManifestMetaData(
      manifestPath,
      "SMT_IS_AUTO_FETCHED_LOCATION",
      inputs.autoFetchLocation ? "1" : "0"
    );
    if (locationChange) changes.push(locationChange);
  }

  const backupChanges = await ensureBackupConfig(androidLayout, manifestPath);
  changes.push(...backupChanges);

  const targetSdk = await detectTargetSdk(androidLayout);
  const appClassChange = await ensureApplicationInitializationAndReceiver(
    applicationClassPath,
    targetSdk
  );
  if (appClassChange) changes.push(appClassChange);

  const receiverChange = await ensureDeeplinkReceiver(applicationClassPath);
  if (receiverChange) changes.push(receiverChange);

  const activityChange = await ensureMainActivityDeeplink(mainActivityPath);
  if (activityChange) changes.push(activityChange);

  const activityName = await inferManifestActivityName(manifestPath, mainActivityPath);
  const intentChange = await ensureManifestIntentFilter(manifestPath, activityName, scheme);
  if (intentChange) changes.push(intentChange);

  return changes;
}

function buildChange(input: Omit<Change, "patch">): Change {
  const patch = createUnifiedDiff(input.filePath, input.originalContent ?? "", input.newContent ?? "");
  return { module: "base", ...input, patch };
}

function resolveInputPath(rootPath: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.join(rootPath, inputPath);
}

async function ensureMavenRepo(androidLayout: AndroidProjectLayout): Promise<Change | null> {
  const candidates = [
    androidLayout.rootBuildGradle,
    androidLayout.appBuildGradle,
    androidLayout.settingsGradle,
    androidLayout.rootBuildGradleKts,
    androidLayout.appBuildGradleKts,
    androidLayout.settingsGradleKts
  ];

  for (const filePath of candidates) {
    if (!(await pathExists(filePath))) continue;
    const change = await ensureMavenRepoInFile(filePath);
    return change;
  }

  return null;
}

async function ensureMavenRepoInFile(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  if (originalContent.includes(SMARTECH_MAVEN)) return null;

  const isKotlin = filePath.endsWith(".kts");
  const repoLine = isKotlin
    ? `maven { url = uri(\"${SMARTECH_MAVEN}\") }`
    : `maven { url '${SMARTECH_MAVEN}' }`;

  let newContent = originalContent;
  if (/repositories\s*\{/.test(originalContent)) {
    newContent = originalContent.replace(/repositories\s*\{/, (match) => `${match}\n    ${repoLine}`);
  } else {
    newContent = `${originalContent.trimEnd()}\n\nrepositories {\n    ${repoLine}\n}\n`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "native-maven-repo",
    title: "Add Smartech Maven repository",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add Smartech Maven repository for native Android Base integration.",
    confidence: 0.4
  });
}

async function ensureBaseDependency(
  androidLayout: AndroidProjectLayout,
  version: string
): Promise<Change | null> {
  const ktsPath = androidLayout.appBuildGradleKts;
  const groovyPath = androidLayout.appBuildGradle;
  const filePath = (await pathExists(ktsPath)) ? ktsPath : groovyPath;
  if (!(await pathExists(filePath))) return null;

  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kts");
  const depLine = isKotlin
    ? `implementation(\"com.netcore.android:smartech-sdk:${version}\")`
    : `implementation 'com.netcore.android:smartech-sdk:${version}'`;

  let newContent = originalContent;
  if (isKotlin) {
    if (/implementation\s*\(\s*["']com\.netcore\.android:smartech-sdk:[^"']+["']\s*\)/.test(originalContent)) {
      newContent = originalContent.replace(
        /implementation\s*\(\s*["']com\.netcore\.android:smartech-sdk:[^"']+["']\s*\)/,
        depLine
      );
    } else if (/dependencies\s*\{/.test(originalContent)) {
      newContent = originalContent.replace(/dependencies\s*\{/, (match) => `${match}\n    ${depLine}`);
    } else {
      newContent = `${originalContent.trimEnd()}\n\ndependencies {\n    ${depLine}\n}\n`;
    }
  } else {
    if (/implementation\s+["']com\.netcore\.android:smartech-sdk:[^"']+["']/.test(originalContent)) {
      newContent = originalContent.replace(
        /implementation\s+["']com\.netcore\.android:smartech-sdk:[^"']+["']/,
        depLine
      );
    } else if (/dependencies\s*\{/.test(originalContent)) {
      newContent = originalContent.replace(/dependencies\s*\{/, (match) => `${match}\n    ${depLine}`);
    } else {
      newContent = `${originalContent.trimEnd()}\n\ndependencies {\n    ${depLine}\n}\n`;
    }
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "native-base-dependency",
    title: "Add Smartech Base SDK dependency",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add or update Smartech Base dependency in app build.gradle(.kts).",
    confidence: 0.45
  });
}

async function ensureManifestMetaData(
  manifestPath: string,
  name: string,
  value: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath)) || !value) return null;

  const originalContent = await fs.readFile(manifestPath, "utf-8");
  const line = `    <meta-data\n        android:name=\"${name}\"\n        android:value=\"${value}\" />`;

  let newContent = originalContent;
  if (originalContent.includes(`android:name=\"${name}\"`)) {
    newContent = originalContent.replace(
      new RegExp(`<meta-data[^>]*android:name=\\\"${escapeRegex(name)}\\\"[^>]*android:value=\\\"[^\\\"]*\\\"[^>]*\\/>`),
      line
    );
  } else if (/<application[^>]*>/.test(originalContent)) {
    newContent = originalContent.replace(/<application[^>]*>/, (match) => `${match}\n${line}`);
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: `native-manifest-meta-${name.toLowerCase()}`,
    title: `Set ${name} meta-data`,
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: `Add or update ${name} in AndroidManifest.xml.`,
    confidence: 0.4
  });
}

async function ensureApplicationInitializationAndReceiver(
  filePath: string,
  targetSdk: number | null
): Promise<Change | null> {
  if (!(await pathExists(filePath))) {
    return {
      id: "native-application-path-not-found",
      title: "Application class not found",
      filePath,
      kind: "insert",
      patch: "",
      summary: "Provided Application class path does not exist.",
      confidence: 0.2,
      module: "base"
    };
  }

  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kt");
  const mode: "legacy" | "modern" = targetSdk !== null && targetSdk <= 33 ? "legacy" : "modern";

  let updated = originalContent;
  updated = isKotlin
    ? ensureKotlinImports(updated, [
        "java.lang.ref.WeakReference",
        "android.content.Context",
        "android.content.IntentFilter",
        "android.os.Build",
        "com.netcore.android.Smartech"
      ])
    : ensureJavaImports(updated, [
        "java.lang.ref.WeakReference",
        "android.content.Context",
        "android.content.IntentFilter",
        "android.os.Build",
        "com.netcore.android.Smartech"
      ]);

  const missingInit = isKotlin ? getMissingKotlinInitLines(updated) : getMissingJavaInitLines(updated);
  const hasOnCreate = /onCreate\s*\(/.test(updated);

  if (!hasOnCreate) {
    const initLines = isKotlin ? KOTLIN_INIT_LINES : JAVA_INIT_LINES;
    const receiverBlock = isKotlin ? buildKotlinReceiverBlock(mode) : buildJavaReceiverBlock(mode);
    updated = addOnCreateMethod(updated, initLines, receiverBlock, isKotlin);
  } else {
    if (missingInit.length > 0) {
      updated = insertAfterSuperOnCreate(updated, missingInit, isKotlin);
    }

    updated = normalizeReceiverRegistration(updated, isKotlin, mode);

    if (!hasReceiverRegistration(updated)) {
      const receiverBlock = isKotlin ? buildKotlinReceiverBlock(mode) : buildJavaReceiverBlock(mode);
      updated = insertReceiverAfterSmartechInit(updated, receiverBlock, isKotlin);
    }
  }

  if (updated === originalContent) return null;

  return buildChange({
    id: "native-application-init-receiver",
    title: "Initialize Smartech and register deeplink receiver",
    filePath,
    kind: "insert",
    originalContent,
    newContent: updated,
    summary:
      "Ensure SDK init calls and DeeplinkReceiver registration are present in Application.onCreate().",
    confidence: 0.5
  });
}

function getMissingJavaInitLines(source: string): string[] {
  const missing: string[] = [];
  if (!/initializeSdk\(/.test(source)) missing.push(JAVA_INIT_LINES[0]);
  if (!/setDebugLevel\(/.test(source)) missing.push(JAVA_INIT_LINES[1]);
  if (!/trackAppInstallUpdateBySmartech\(/.test(source)) missing.push(JAVA_INIT_LINES[2]);
  return missing;
}

function getMissingKotlinInitLines(source: string): string[] {
  const missing: string[] = [];
  if (!/initializeSdk\(/.test(source)) missing.push(KOTLIN_INIT_LINES[0]);
  if (!/setDebugLevel\(/.test(source)) missing.push(KOTLIN_INIT_LINES[1]);
  if (!/trackAppInstallUpdateBySmartech\(/.test(source)) missing.push(KOTLIN_INIT_LINES[2]);
  return missing;
}

function insertAfterSuperOnCreate(source: string, lines: string[], isKotlin: boolean): string {
  if (lines.length === 0) return source;
  const regex = /super\.onCreate\s*\(\s*[^\)]*\)\s*;?/;
  if (!regex.test(source)) return source;
  const block = lines.map((line) => `        ${line}`).join("\n");
  return source.replace(regex, (match) => `${match}\n${block}`);
}

function insertReceiverAfterSmartechInit(source: string, receiverBlock: string, isKotlin: boolean): string {
  const trackRegex = /Smartech\.getInstance\([^\n]+\)\.(trackAppInstallUpdateBySmartech\([^\n]*\))\s*;?/;
  if (trackRegex.test(source)) {
    return source.replace(trackRegex, (match) => `${match}\n${receiverBlock}`);
  }

  const initRegex = /Smartech\.getInstance\([^\n]+\)\.(initializeSdk\([^\n]*\))\s*;?/;
  if (initRegex.test(source)) {
    return source.replace(initRegex, (match) => `${match}\n${receiverBlock}`);
  }

  const superRegex = /super\.onCreate\s*\(\s*[^\)]*\)\s*;?/;
  if (superRegex.test(source)) {
    return source.replace(superRegex, (match) => `${match}\n${receiverBlock}`);
  }

  return source;
}

function normalizeReceiverRegistration(
  source: string,
  isKotlin: boolean,
  mode: "legacy" | "modern"
): string {
  let updated = source;

  if (isKotlin) {
    if (mode === "legacy") {
      updated = updated.replace(
        /if\s*\(\s*Build\.VERSION\.SDK_INT\s*>=\s*Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE\s*\)\s*\{[\s\S]*?\}\s*else\s*\{[\s\S]*?\}/,
        "registerReceiver(deeplinkReceiver, filter)"
      );
    } else if (/registerReceiver\(deeplinkReceiver,\s*filter\)/.test(updated) && !/RECEIVER_EXPORTED/.test(updated)) {
      updated = updated.replace(
        /registerReceiver\(deeplinkReceiver,\s*filter\)/,
        "if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {\n            registerReceiver(deeplinkReceiver, filter, Context.RECEIVER_EXPORTED)\n        } else {\n            registerReceiver(deeplinkReceiver, filter)\n        }"
      );
    }
  } else {
    if (mode === "legacy") {
      updated = updated.replace(
        /if\s*\(\s*Build\.VERSION\.SDK_INT\s*>=\s*Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE\s*\)\s*\{[\s\S]*?\}\s*else\s*\{[\s\S]*?\}/,
        "registerReceiver(deeplinkReceiver, filter);"
      );
    } else if (/registerReceiver\(deeplinkReceiver,\s*filter\);/.test(updated) && !/RECEIVER_EXPORTED/.test(updated)) {
      updated = updated.replace(
        /registerReceiver\(deeplinkReceiver,\s*filter\);/,
        "if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {\n            registerReceiver(deeplinkReceiver, filter, Context.RECEIVER_EXPORTED);\n        } else {\n            registerReceiver(deeplinkReceiver, filter);\n        }"
      );
    }
  }

  return updated;
}

function hasReceiverRegistration(source: string): boolean {
  return (
    /EVENT_PN_INBOX_CLICK/.test(source) &&
    /registerReceiver\s*\(\s*deeplinkReceiver\s*,\s*filter/.test(source)
  );
}

function buildJavaReceiverBlock(mode: "legacy" | "modern"): string {
  const lines = [
    "        DeeplinkReceiver deeplinkReceiver = new DeeplinkReceiver();",
    '        IntentFilter filter = new IntentFilter("com.smartech.EVENT_PN_INBOX_CLICK");'
  ];

  if (mode === "legacy") {
    lines.push("        registerReceiver(deeplinkReceiver, filter);");
    return lines.join("\n");
  }

  lines.push("        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {");
  lines.push("            registerReceiver(deeplinkReceiver, filter, Context.RECEIVER_EXPORTED);");
  lines.push("        } else {");
  lines.push("            registerReceiver(deeplinkReceiver, filter);");
  lines.push("        }");
  return lines.join("\n");
}

function buildKotlinReceiverBlock(mode: "legacy" | "modern"): string {
  const lines = [
    "        val deeplinkReceiver = DeeplinkReceiver()",
    '        val filter = IntentFilter("com.smartech.EVENT_PN_INBOX_CLICK")'
  ];

  if (mode === "legacy") {
    lines.push("        registerReceiver(deeplinkReceiver, filter)");
    return lines.join("\n");
  }

  lines.push("        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {");
  lines.push("            registerReceiver(deeplinkReceiver, filter, Context.RECEIVER_EXPORTED)");
  lines.push("        } else {");
  lines.push("            registerReceiver(deeplinkReceiver, filter)");
  lines.push("        }");
  return lines.join("\n");
}

function addOnCreateMethod(
  source: string,
  initLines: string[],
  receiverBlock: string,
  isKotlin: boolean
): string {
  if (isKotlin) {
    return source.replace(
      /class\s+\w+[^{]*\{/,
      (match) =>
        `${match}\n\n    override fun onCreate() {\n        super.onCreate()\n        ${initLines.join(
          "\n        "
        )}\n${receiverBlock}\n    }\n`
    );
  }

  return source.replace(
    /class\s+\w+[^{]*\{/,
    (match) =>
      `${match}\n\n    @Override\n    public void onCreate() {\n        super.onCreate();\n        ${initLines.join(
        "\n        "
      )}\n${receiverBlock}\n    }\n`
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

async function ensureDeeplinkReceiver(applicationClassPath: string): Promise<Change | null> {
  if (!(await pathExists(applicationClassPath))) return null;

  const isKotlinApp = applicationClassPath.endsWith(".kt");
  const receiverPath = path.join(
    path.dirname(applicationClassPath),
    `DeeplinkReceiver.${isKotlinApp ? "kt" : "java"}`
  );

  const appSource = await fs.readFile(applicationClassPath, "utf-8");
  const packageName = readPackageName(appSource) ?? "com.smartech.app";
  const receiverContent = isKotlinApp
    ? buildKotlinReceiverClass(packageName)
    : buildJavaReceiverClass(packageName);

  if (!(await pathExists(receiverPath))) {
    return buildChange({
      id: "native-deeplink-receiver-create",
      title: "Create DeeplinkReceiver class",
      filePath: receiverPath,
      kind: "create",
      originalContent: "",
      newContent: receiverContent,
      summary: "Create DeeplinkReceiver for Smartech deep link and payload callbacks.",
      confidence: 0.45
    });
  }

  const originalContent = await fs.readFile(receiverPath, "utf-8");
  const hasRequired =
    /SMT_KEY_DEEPLINK/.test(originalContent) &&
    /SMT_KEY_CUSTOM_PAYLOAD/.test(originalContent) &&
    /onReceive/.test(originalContent);

  if (hasRequired) return null;

  return buildChange({
    id: "native-deeplink-receiver-update",
    title: "Update DeeplinkReceiver class",
    filePath: receiverPath,
    kind: "update",
    originalContent,
    newContent: receiverContent,
    summary: "Ensure DeeplinkReceiver contains required Smartech bundle handling.",
    confidence: 0.4
  });
}

function buildJavaReceiverClass(packageName: string): string {
  return `package ${packageName};\n\nimport android.content.BroadcastReceiver;\nimport android.content.Context;\nimport android.content.Intent;\nimport android.os.Bundle;\nimport android.util.Log;\nimport com.netcore.android.SMTBundleKeys;\n\npublic class DeeplinkReceiver extends BroadcastReceiver {\n\n    @Override\n    public void onReceive(Context context, Intent intent) {\n        try {\n            Bundle bundleExtra = intent.getExtras();\n            if (bundleExtra != null) {\n                String deepLinkSource = bundleExtra.getString(SMTBundleKeys.SMT_KEY_DEEPLINK_SOURCE);\n                String deepLink = bundleExtra.getString(SMTBundleKeys.SMT_KEY_DEEPLINK);\n                String customPayload = bundleExtra.getString(SMTBundleKeys.SMT_KEY_CUSTOM_PAYLOAD);\n\n                if (deepLink != null && !deepLink.isEmpty()) {\n                    // handle deepLink\n                }\n\n                if (customPayload != null && !customPayload.isEmpty()) {\n                    // handle custom payload\n                }\n            }\n        } catch (Throwable t) {\n            Log.e(\"DeeplinkReceiver\", \"Error occurred in deeplink:\" + t.getLocalizedMessage());\n        }\n    }\n}\n`;
}

function buildKotlinReceiverClass(packageName: string): string {
  return `package ${packageName}\n\nimport android.content.BroadcastReceiver\nimport android.content.Context\nimport android.content.Intent\nimport android.util.Log\nimport com.netcore.android.SMTBundleKeys\n\nclass DeeplinkReceiver : BroadcastReceiver() {\n\n    override fun onReceive(context: Context, intent: Intent) {\n        try {\n            val bundleExtra = intent.extras\n            bundleExtra?.let {\n                val deepLinkSource =\n                    it.getString(SMTBundleKeys.SMT_KEY_DEEPLINK_SOURCE)\n                val deepLink =\n                    it.getString(SMTBundleKeys.SMT_KEY_DEEPLINK)\n                val customPayload =\n                    it.getString(SMTBundleKeys.SMT_KEY_CUSTOM_PAYLOAD)\n\n                if (!deepLink.isNullOrEmpty()) {\n                    // handle deepLink\n                }\n\n                if (!customPayload.isNullOrEmpty()) {\n                    // handle custom payload\n                }\n            }\n        } catch (t: Throwable) {\n            Log.e(\"DeeplinkReceiver\", \"Error occurred in deeplink:${'$'}{t.localizedMessage}\")\n        }\n    }\n}\n`;
}

function readPackageName(source: string): string | null {
  const match = source.match(/package\s+([^\s;]+)/);
  return match ? match[1] : null;
}

async function ensureMainActivityDeeplink(filePath: string): Promise<Change | null> {
  if (!(await pathExists(filePath))) {
    return {
      id: "native-mainactivity-path-not-found",
      title: "MainActivity not found",
      filePath,
      kind: "insert",
      patch: "",
      summary: "Provided MainActivity path does not exist.",
      confidence: 0.2,
      module: "base"
    };
  }

  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kt");

  let updated = originalContent;
  updated = isKotlin
    ? ensureKotlinImports(updated, ["java.lang.ref.WeakReference", "com.netcore.android.Smartech"])
    : ensureJavaImports(updated, ["java.lang.ref.WeakReference", "com.netcore.android.Smartech"]);

  const missing = isKotlin ? getMissingKotlinDeeplinkLines(updated) : getMissingJavaDeeplinkLines(updated);

  if (missing.length > 0) {
    if (/onCreate\s*\(/.test(updated)) {
      updated = insertAfterSuperOnCreate(updated, missing, isKotlin);
    } else {
      updated = addActivityOnCreateMethod(updated, missing, isKotlin);
    }
  }

  if (updated === originalContent) return null;

  return buildChange({
    id: "native-mainactivity-deeplink",
    title: "Add Smartech deeplink handling in MainActivity",
    filePath,
    kind: "insert",
    originalContent,
    newContent: updated,
    summary: "Ensure Smartech deeplink check is added under super.onCreate() in launcher activity.",
    confidence: 0.45
  });
}

function getMissingJavaDeeplinkLines(source: string): string[] {
  const hasVar = /isDeepLinkFromSmartech\s*\(/.test(source);
  const hasIf = /if\s*\(!isSmartechHandledDeeplink\)/.test(source);
  const lines: string[] = [];
  if (!hasVar) lines.push(...JAVA_DEEPLINK_LINES.slice(0, 4));
  if (!hasIf) lines.push(...JAVA_DEEPLINK_LINES.slice(4));
  return lines;
}

function getMissingKotlinDeeplinkLines(source: string): string[] {
  const hasVar = /isDeepLinkFromSmartech\s*\(/.test(source);
  const hasIf = /if\s*\(!isSmartechHandledDeeplink\)/.test(source);
  const lines: string[] = [];
  if (!hasVar) lines.push(...KOTLIN_DEEPLINK_LINES.slice(0, 4));
  if (!hasIf) lines.push(...KOTLIN_DEEPLINK_LINES.slice(4));
  return lines;
}

function addActivityOnCreateMethod(source: string, lines: string[], isKotlin: boolean): string {
  if (isKotlin) {
    return source.replace(
      /class\s+\w+[^{]*\{/,
      (match) =>
        `${match}\n\n    override fun onCreate(savedInstanceState: android.os.Bundle?) {\n        super.onCreate(savedInstanceState)\n        ${lines.join(
          "\n        "
        )}\n    }\n`
    );
  }

  return source.replace(
    /class\s+\w+[^{]*\{/,
    (match) =>
      `${match}\n\n    @Override\n    protected void onCreate(android.os.Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        ${lines.join(
        "\n        "
      )}\n    }\n`
  );
}

async function inferManifestActivityName(manifestPath: string, mainActivityPath: string): Promise<string | null> {
  if (!(await pathExists(manifestPath)) || !(await pathExists(mainActivityPath))) return null;

  const manifest = await fs.readFile(manifestPath, "utf-8");
  const classSource = await fs.readFile(mainActivityPath, "utf-8");

  const manifestPackageMatch = manifest.match(/package\s*=\s*"([^"]+)"/);
  const manifestPackage = manifestPackageMatch ? manifestPackageMatch[1] : null;

  const className = path.basename(mainActivityPath, path.extname(mainActivityPath));
  const classPackage = readPackageName(classSource);

  const candidates = [
    className,
    `.${className}`,
    classPackage ? `${classPackage}.${className}` : null,
    manifestPackage ? `${manifestPackage}.${className}` : null
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const regex = new RegExp(`<activity[^>]*android:name=\\"${escapeRegex(candidate)}\\"[^>]*>`);
    if (regex.test(manifest)) return candidate;
  }

  const launcherBlocks = manifest.match(/<activity[\s\S]*?<\/activity>/g) ?? [];
  for (const block of launcherBlocks) {
    if (!block.includes("android.intent.action.MAIN") || !block.includes("android.intent.category.LAUNCHER")) {
      continue;
    }
    const nameMatch = block.match(/android:name=\"([^\"]+)\"/);
    if (nameMatch) return nameMatch[1];
  }

  return candidates[1] ?? null;
}

async function ensureManifestIntentFilter(
  manifestPath: string,
  activityName: string | null,
  scheme: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath)) || !scheme || !activityName) return null;

  const originalContent = await fs.readFile(manifestPath, "utf-8");
  const activityBlock = findActivityBlockByName(originalContent, activityName);
  if (!activityBlock) return null;

  const intentFilter = `        <intent-filter>\n            <action android:name=\"android.intent.action.VIEW\" />\n            <category android:name=\"android.intent.category.DEFAULT\" />\n            <category android:name=\"android.intent.category.BROWSABLE\" />\n            <data\n                android:scheme=\"${scheme}\"\n                android:host=\"smartech_sdk_td\" />\n        </intent-filter>`;

  let updatedActivityBlock = activityBlock;
  if (/android:host=\"smartech_sdk_td\"/.test(activityBlock)) {
    updatedActivityBlock = activityBlock.replace(/<data[\s\S]*?\/>/g, (dataTag) => {
      if (!/android:host=\"smartech_sdk_td\"/.test(dataTag)) return dataTag;
      if (/android:scheme=\"[^\"]*\"/.test(dataTag)) {
        return dataTag.replace(/android:scheme=\"[^\"]*\"/, `android:scheme=\"${scheme}\"`);
      }
      return dataTag.replace(/android:host=\"smartech_sdk_td\"/, `android:scheme=\"${scheme}\" android:host=\"smartech_sdk_td\"`);
    });
  } else {
    updatedActivityBlock = activityBlock.replace(/<activity[^>]*>/, (match) => `${match}\n${intentFilter}`);
  }

  const newContent = originalContent.replace(activityBlock, updatedActivityBlock);

  if (newContent === originalContent) return null;

  return buildChange({
    id: "native-manifest-deeplink-intent",
    title: "Add Smartech deeplink intent filter",
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add or update Smartech deeplink intent filter on launcher activity.",
    confidence: 0.4
  });
}

function findActivityBlockByName(manifest: string, activityName: string): string | null {
  const activityBlocks = manifest.match(/<activity[\s\S]*?<\/activity>/g) ?? [];
  for (const block of activityBlocks) {
    const nameMatch = block.match(/android:name=\"([^\"]+)\"/);
    if (nameMatch?.[1] === activityName) return block;
  }
  return null;
}

async function ensureBackupConfig(
  androidLayout: AndroidProjectLayout,
  manifestPath: string
): Promise<Change[]> {
  const changes: Change[] = [];
  const xmlDir = androidLayout.resXmlDir;

  const backupFile = path.join(xmlDir, "my_backup_file.xml");
  const backupContent = `<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<full-backup-content>\n    <include domain=\"sharedpref\" path=\"smt_guid_preferences.xml\"/>\n    <include domain=\"sharedpref\" path=\"smt_preferences_guid.xml\"/>\n</full-backup-content>\n`;

  const backup31File = path.join(xmlDir, "my_backup_file_31.xml");
  const backup31Content = `<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<data-extraction-rules>\n    <cloud-backup disableIfNoEncryptionCapabilities=\"false\">\n        <include domain=\"sharedpref\" path=\"smt_guid_preferences.xml\" />\n        <include domain=\"sharedpref\" path=\"smt_preferences_guid.xml\" />\n    </cloud-backup>\n</data-extraction-rules>\n`;

  if (!(await pathExists(backupFile))) {
    changes.push(
      buildChange({
        id: "native-backup-xml",
        title: "Create my_backup_file.xml",
        filePath: backupFile,
        kind: "create",
        originalContent: "",
        newContent: backupContent,
        summary: "Create backup file for Smartech GUID persistence.",
        confidence: 0.4
      })
    );
  }

  if (!(await pathExists(backup31File))) {
    changes.push(
      buildChange({
        id: "native-backup-xml-31",
        title: "Create my_backup_file_31.xml",
        filePath: backup31File,
        kind: "create",
        originalContent: "",
        newContent: backup31Content,
        summary: "Create Android 12+ backup extraction rules file.",
        confidence: 0.4
      })
    );
  }

  const manifestChange = await ensureManifestBackupAttributes(manifestPath);
  if (manifestChange) changes.push(manifestChange);

  return changes;
}

async function ensureManifestBackupAttributes(manifestPath: string): Promise<Change | null> {
  if (!(await pathExists(manifestPath))) return null;
  const originalContent = await fs.readFile(manifestPath, "utf-8");
  let newContent = originalContent;

  if (!/android:allowBackup=/.test(newContent)) {
    newContent = newContent.replace(/<application/, `<application\n        android:allowBackup=\"true\"`);
  } else {
    newContent = newContent.replace(/android:allowBackup=\"[^\"]*\"/, `android:allowBackup=\"true\"`);
  }

  if (!/android:fullBackupContent=/.test(newContent)) {
    newContent = newContent.replace(
      /<application/,
      `<application\n        android:fullBackupContent=\"@xml/my_backup_file\"`
    );
  } else {
    newContent = newContent.replace(
      /android:fullBackupContent=\"[^\"]*\"/,
      `android:fullBackupContent=\"@xml/my_backup_file\"`
    );
  }

  if (!/android:dataExtractionRules=/.test(newContent)) {
    newContent = newContent.replace(
      /<application/,
      `<application\n        android:dataExtractionRules=\"@xml/my_backup_file_31\"`
    );
  } else {
    newContent = newContent.replace(
      /android:dataExtractionRules=\"[^\"]*\"/,
      `android:dataExtractionRules=\"@xml/my_backup_file_31\"`
    );
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "native-manifest-backup-attrs",
    title: "Configure backup attributes in manifest",
    filePath: manifestPath,
    kind: "update",
    originalContent,
    newContent,
    summary: "Ensure allowBackup, fullBackupContent and dataExtractionRules are configured.",
    confidence: 0.4
  });
}

async function detectTargetSdk(androidLayout: AndroidProjectLayout): Promise<number | null> {
  const candidates = [androidLayout.appBuildGradleKts, androidLayout.appBuildGradle];

  for (const filePath of candidates) {
    if (!(await pathExists(filePath))) continue;
    const content = await fs.readFile(filePath, "utf-8");
    const matches = [
      content.match(/targetSdkVersion\s+([0-9]+)/),
      content.match(/targetSdkVersion\s*=\s*([0-9]+)/),
      content.match(/targetSdk\s*=\s*([0-9]+)/)
    ];
    for (const match of matches) {
      if (match?.[1]) return Number(match[1]);
    }
  }

  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
