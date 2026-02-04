import path from "node:path";
import { promises as fs } from "node:fs";
import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
import { pathExists } from "../utils/fs.js";
import { createUnifiedDiff } from "../utils/diff.js";

const GRADLE_PROPERTIES_RELATIVE = path.join("android", "gradle.properties");
const APP_BUILD_GRADLE = path.join("android", "app", "build.gradle");
const APP_BUILD_GRADLE_KTS = path.join("android", "app", "build.gradle.kts");
const MANIFEST_PATH = path.join("android", "app", "src", "main", "AndroidManifest.xml");

const DEFAULT_PX_SDK_VERSION = "10.2.12";
const DEFAULT_RN_PX_VERSION = "^3.7.0";

const PX_DEP_GROOVY = "implementation 'com.netcore.android:smartech-nudges:${SMARTECH_PX_SDK_VERSION}'";
const PX_DEP_KTS =
  "implementation(\"com.netcore.android:smartech-nudges:${SMARTECH_PX_SDK_VERSION}\")";

const PX_IMPORT = "import { HanselTrackerRn } from 'smartech-reactnative-nudges';";

const PX_USE_EFFECT = `useEffect(() => {\n  HanselTrackerRn.addListener('HanselInternalEvent', (e) => {\n    console.log('Event Detail:', e);\n  });\n\n  HanselTrackerRn.addListener('HanselDeepLinkListener', (e) => {\n    console.log('DeepLink Listener URL:', e.deeplink);\n  });\n\n  HanselTrackerRn.registerHanselTrackerListener();\n\n  HanselTrackerRn.registerHanselDeeplinkListener();\n}, []);`;

type PxRuleContext = {
  scan: ProjectScan;
  rootPath: string;
  inputs?: IntegrationOptions["inputs"];
};

export async function runPxRules(context: PxRuleContext): Promise<Change[]> {
  const changes: Change[] = [];
  if (!context.scan.platforms.includes("android")) return changes;

  const pxSdkVersion = context.inputs?.pxSdkVersion ?? DEFAULT_PX_SDK_VERSION;
  const rnPxVersion = context.inputs?.rnPxVersion ?? DEFAULT_RN_PX_VERSION;
  const hanselAppId = context.inputs?.hanselAppId ?? "";
  const hanselAppKey = context.inputs?.hanselAppKey ?? "";
  const pxScheme = context.inputs?.pxScheme ?? "";

  const gradlePropChange = await ensureGradleProperty(context.rootPath, pxSdkVersion);
  if (gradlePropChange) changes.push(gradlePropChange);

  const depChange = await ensurePxDependency(context.rootPath);
  if (depChange) changes.push(depChange);

  const rnDepChange = await ensureReactNativePxDependency(context.rootPath, rnPxVersion);
  if (rnDepChange) changes.push(rnDepChange);

  const manifestFile = path.join(context.rootPath, MANIFEST_PATH);
  const metaChange = await ensureHanselMeta(manifestFile, hanselAppId, hanselAppKey);
  if (metaChange) changes.push(metaChange);

  const launcher = await findLauncherActivity(manifestFile);
  if (launcher) {
    const intentChange = await ensurePxIntentFilter(manifestFile, launcher, pxScheme);
    if (intentChange) changes.push(intentChange);
  }

  const appFile = await findAppEntryFile(context.rootPath);
  if (appFile) {
    const appChange = await ensurePxUseEffect(appFile);
    if (appChange) changes.push(appChange);
  }

  const mainActivity = await findMainActivityFile(context.rootPath, launcher);
  if (mainActivity) {
    const mainChange = await ensurePxMainActivity(mainActivity);
    if (mainChange) changes.push(mainChange);
  }

  return changes;
}

function buildChange(input: Omit<Change, "patch">): Change {
  const patch = createUnifiedDiff(input.filePath, input.originalContent ?? "", input.newContent ?? "");
  return { module: "px", ...input, patch };
}

async function ensureGradleProperty(rootPath: string, version: string): Promise<Change | null> {
  const filePath = path.join(rootPath, GRADLE_PROPERTIES_RELATIVE);
  if (!(await pathExists(filePath))) return null;

  const originalContent = await fs.readFile(filePath, "utf-8");
  let newContent = originalContent;

  if (/SMARTECH_PX_SDK_VERSION\s*=/.test(originalContent)) {
    newContent = originalContent.replace(
      /SMARTECH_PX_SDK_VERSION\s*=\s*[^\n]+/,
      `SMARTECH_PX_SDK_VERSION=${version}`
    );
  } else {
    newContent = `${originalContent.trimEnd()}\nSMARTECH_PX_SDK_VERSION=${version}\n`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "android-gradle-properties-smartech-px",
    title: "Add Smartech PX SDK version to gradle.properties",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add or update SMARTECH_PX_SDK_VERSION in gradle.properties.",
    confidence: 0.4
  });
}

async function ensurePxDependency(rootPath: string): Promise<Change | null> {
  const groovyPath = path.join(rootPath, APP_BUILD_GRADLE);
  const kotlinPath = path.join(rootPath, APP_BUILD_GRADLE_KTS);
  const filePath = (await pathExists(kotlinPath)) ? kotlinPath : groovyPath;
  if (!(await pathExists(filePath))) return null;

  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kts");
  const depLine = isKotlin ? PX_DEP_KTS : PX_DEP_GROOVY;

  let newContent = originalContent;
  if (originalContent.includes("com.netcore.android:smartech-nudges")) {
    newContent = originalContent.replace(
      /implementation\s*(\(|\s+)['\"]com\.netcore\.android:smartech-nudges:[^'\")]+['\"]\)?/,
      depLine
    );
  } else if (/dependencies\s*\{/.test(originalContent)) {
    newContent = originalContent.replace(/dependencies\s*\{/, (match) => `${match}\n    ${depLine}`);
  } else {
    newContent = `${originalContent}\n\ndependencies {\n    ${depLine}\n}`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "android-add-smartech-px-dependency",
    title: "Add Smartech PX SDK dependency",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add or update Smartech nudges dependency in app build.gradle(.kts).",
    confidence: 0.4
  });
}

async function ensureReactNativePxDependency(
  rootPath: string,
  rnPxVersion: string
): Promise<Change | null> {
  const filePath = path.join(rootPath, "package.json");
  if (!(await pathExists(filePath))) return null;

  const originalContent = await fs.readFile(filePath, "utf-8");
  let parsed: any;
  try {
    parsed = JSON.parse(originalContent);
  } catch {
    return null;
  }

  const dependencies = parsed.dependencies ?? {};
  const nextDependencies = { ...dependencies };
  if (nextDependencies["smartech-reactnative-nudges"] !== rnPxVersion) {
    nextDependencies["smartech-reactnative-nudges"] = rnPxVersion;
  }

  const nextParsed = { ...parsed, dependencies: nextDependencies };
  const newContent = JSON.stringify(nextParsed, null, 2) + "\n";

  if (newContent === originalContent) return null;

  return buildChange({
    id: "rn-add-smartech-px",
    title: "Add smartech-reactnative-nudges dependency",
    filePath,
    kind: "update",
    originalContent,
    newContent,
    summary: "Ensure smartech-reactnative-nudges is present in package.json.",
    confidence: 0.45
  });
}

async function ensureHanselMeta(
  manifestPath: string,
  appId: string,
  appKey: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath))) return null;
  const originalContent = await fs.readFile(manifestPath, "utf-8");
  let newContent = originalContent;

  if (appId) {
    const metaId = `    <meta-data\n        android:name=\"HANSEL_APP_ID\"\n        android:value=\"${appId}\" />`;
    if (newContent.includes("HANSEL_APP_ID")) {
      newContent = newContent.replace(
        /<meta-data[^>]*android:name=\"HANSEL_APP_ID\"[^>]*android:value=\"[^\"]*\"[^>]*\/>/,
        metaId
      );
    } else if (/<application[^>]*>/.test(newContent)) {
      newContent = newContent.replace(/<application[^>]*>/, (match) => `${match}\n${metaId}`);
    }
  }

  if (appKey) {
    const metaKey = `    <meta-data\n        android:name=\"HANSEL_APP_KEY\"\n        android:value=\"${appKey}\" />`;
    if (newContent.includes("HANSEL_APP_KEY")) {
      newContent = newContent.replace(
        /<meta-data[^>]*android:name=\"HANSEL_APP_KEY\"[^>]*android:value=\"[^\"]*\"[^>]*\/>/,
        metaKey
      );
    } else if (/<application[^>]*>/.test(newContent)) {
      newContent = newContent.replace(/<application[^>]*>/, (match) => `${match}\n${metaKey}`);
    }
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "android-manifest-hansel-meta",
    title: "Add Hansel meta-data",
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add or update HANSEL_APP_ID and HANSEL_APP_KEY in AndroidManifest.xml.",
    confidence: 0.4
  });
}

async function ensurePxIntentFilter(
  manifestPath: string,
  activityName: string,
  scheme: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath)) || !scheme) return null;

  const originalContent = await fs.readFile(manifestPath, "utf-8");
  let newContent = originalContent;

  const intentFilter = `        <intent-filter>\n            <action android:name=\"android.intent.action.VIEW\" />\n            <category android:name=\"android.intent.category.DEFAULT\" />\n            <category android:name=\"android.intent.category.BROWSABLE\" />\n            <data android:scheme=\"${scheme}\" />\n        </intent-filter>`;

  const activityPattern = new RegExp(
    `<activity[^>]*android:name=\\"${escapeRegex(activityName)}\\"[^>]*>`
  );

  if (activityPattern.test(newContent)) {
    const activityMatch = newContent.match(activityPattern);
    if (!activityMatch) {
      return null;
    }

    const activityBlock = activityMatch[0];
    const hasPxScheme = activityBlock.includes(`android:scheme=\"${scheme}\"`);
    if (hasPxScheme) {
      return null;
    }

    const updatedBlock = activityBlock.replace(activityPattern, (match) => `${match}\n${intentFilter}`);
    newContent = newContent.replace(activityBlock, updatedBlock);
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "android-manifest-px-intent",
    title: "Add Hansel deeplink intent filter",
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add Hansel deeplink intent filter to launcher activity.",
    confidence: 0.4
  });
}

async function ensurePxUseEffect(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  let newContent = originalContent;

  if (!newContent.includes(PX_IMPORT)) {
    newContent = `${PX_IMPORT}\n${newContent}`;
  }

  if (!newContent.includes("useEffect")) {
    newContent = ensureReactUseEffectImport(newContent);
  }

  const needsInternalListener = !/HanselInternalEvent/.test(newContent);
  const needsDeepLinkListener = !/HanselDeepLinkListener/.test(newContent);
  const needsTracker = !/registerHanselTrackerListener/.test(newContent);
  const needsDeeplink = !/registerHanselDeeplinkListener/.test(newContent);

  if (!needsInternalListener && !needsDeepLinkListener && !needsTracker && !needsDeeplink) {
    return null;
  }

  const block = buildPxUseEffectBlock(
    needsInternalListener,
    needsDeepLinkListener,
    needsTracker,
    needsDeeplink
  );

  if (/return\s*\(/.test(newContent)) {
    newContent = newContent.replace(/return\s*\(/, `${block}\n\n  return (`);
  } else {
    newContent = `${newContent}\n\n${block}`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "rn-app-px-logic",
    title: "Add Hansel listeners in App",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Inject HanselTrackerRn listeners and registrations in useEffect.",
    confidence: 0.35
  });
}

async function ensurePxMainActivity(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  let newContent = originalContent;

  const isKotlin = filePath.endsWith(".kt");
  const importLine = isKotlin
    ? "import io.hansel.hanselsdk.Hansel"
    : "import io.hansel.hanselsdk.Hansel;";

  if (!newContent.includes(importLine)) {
    newContent = newContent.replace(/(package\s+[^;\n]+;?\n)/, `$1${importLine}\n`);
  }

  if (newContent.includes("Hansel.pairTestDevice")) {
    return null;
  }

  if (isKotlin) {
    newContent = newContent.replace(
      /super\.onCreate\s*\(\s*.*\)/,
      (match) => `${match}\n        Hansel.pairTestDevice(intent.dataString)`
    );
  } else {
    newContent = newContent.replace(
      /super\.onCreate\s*\(\s*[^\)]*\)\s*;?/,
      (match) => `${match}\n        Hansel.pairTestDevice(getIntent().getDataString());`
    );
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "android-mainactivity-hansel",
    title: "Add Hansel pairTestDevice in MainActivity",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Call Hansel.pairTestDevice after super.onCreate in launcher activity.",
    confidence: 0.4
  });
}

async function findAppEntryFile(rootPath: string): Promise<string | null> {
  const candidates = [
    path.join(rootPath, "App.tsx"),
    path.join(rootPath, "App.jsx"),
    path.join(rootPath, "App.js")
  ];

  for (const file of candidates) {
    if (await pathExists(file)) return file;
  }

  return null;
}

async function findLauncherActivity(manifestPath: string): Promise<string | null> {
  if (!(await pathExists(manifestPath))) return null;
  const manifest = await fs.readFile(manifestPath, "utf-8");
  const activityBlocks = manifest.match(/<activity[\s\S]*?<\/activity>/g) ?? [];

  for (const block of activityBlocks) {
    if (!block.includes("android.intent.action.MAIN") || !block.includes("android.intent.category.LAUNCHER")) {
      continue;
    }

    const nameMatch = block.match(/android:name=\"([^\"]+)\"/);
    if (!nameMatch) continue;
    return nameMatch[1];
  }

  return null;
}

async function findMainActivityFile(rootPath: string, manifestName: string | null): Promise<string | null> {
  const manifestPath = path.join(rootPath, MANIFEST_PATH);
  const manifest = await fs.readFile(manifestPath, "utf-8");
  const packageMatch = manifest.match(/package\s*=\s*"([^"]+)"/);
  const manifestPackage = packageMatch ? packageMatch[1] : null;
  const javaRoot = path.join(rootPath, "android", "app", "src", "main", "java");

  if (manifestName) {
    const fqcn = resolveActivityClass(manifestName, manifestPackage);
    const found = await locateJavaOrKotlinFile(javaRoot, fqcn);
    if (found) return found;
  }

  const fallbackFqcn = `${manifestPackage ?? ""}.MainActivity`;
  return locateJavaOrKotlinFile(javaRoot, fallbackFqcn);
}

async function locateJavaOrKotlinFile(javaRoot: string, fqcn: string): Promise<string | null> {
  const pathSegments = fqcn.split(".");
  const className = pathSegments.pop() ?? "";
  const packagePath = pathSegments.join(path.sep);

  const javaPath = path.join(javaRoot, packagePath, `${className}.java`);
  const kotlinPath = path.join(javaRoot, packagePath, `${className}.kt`);

  if (await pathExists(javaPath)) return javaPath;
  if (await pathExists(kotlinPath)) return kotlinPath;

  const fallbackName = fqcn.split(".").pop() ?? "";
  if (!fallbackName) return null;
  const fallback = await findByClassName(javaRoot, fallbackName);
  return fallback;
}

function resolveActivityClass(name: string, manifestPackage: string | null): string {
  if (name.startsWith(".")) {
    return `${manifestPackage ?? ""}${name}`;
  }
  if (name.includes(".")) {
    return name;
  }
  return `${manifestPackage ?? ""}.${name}`;
}

async function findByClassName(root: string, className: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findByClassName(fullPath, className);
      if (found) return found;
      continue;
    }
    if (entry.name === `${className}.java` || entry.name === `${className}.kt`) {
      return fullPath;
    }
  }
  return null;
}

async function findIndexFile(rootPath: string): Promise<string | null> {
  const candidates = [path.join(rootPath, "index.tsx"), path.join(rootPath, "index.js")];
  for (const file of candidates) {
    if (await pathExists(file)) return file;
  }
  return null;
}

function ensureReactUseEffectImport(source: string): string {
  if (source.includes("useEffect")) return source;
  if (source.includes("from 'react'")) {
    return source.replace(
      /import\s+React\s*(,\s*\{[^}]*\})?\s*from\s+'react';/,
      (match) => {
        if (match.includes("{")) {
          if (match.includes("useEffect")) return match;
          return match.replace(/\{([^}]*)\}/, (m, group) => `{${group}, useEffect}`);
        }
        return "import React, { useEffect } from 'react';";
      }
    );
  }
  return `import React, { useEffect } from 'react';\n${source}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPxUseEffectBlock(
  needsInternalListener: boolean,
  needsDeepLinkListener: boolean,
  needsTracker: boolean,
  needsDeeplink: boolean
): string {
  const lines: string[] = ["useEffect(() => {"]; 

  if (needsInternalListener) {
    lines.push("  HanselTrackerRn.addListener('HanselInternalEvent', (e) => {");
    lines.push("    console.log('Event Detail:', e);");
    lines.push("  });");
    lines.push("");
  }

  if (needsDeepLinkListener) {
    lines.push("  HanselTrackerRn.addListener('HanselDeepLinkListener', (e) => {");
    lines.push("    console.log('DeepLink Listener URL:', e.deeplink);");
    lines.push("  });");
    lines.push("");
  }

  if (needsTracker) {
    lines.push("  HanselTrackerRn.registerHanselTrackerListener();");
    lines.push("");
  }

  if (needsDeeplink) {
    lines.push("  HanselTrackerRn.registerHanselDeeplinkListener();");
  }

  lines.push("}, []);");
  return lines.join("\n");
}
