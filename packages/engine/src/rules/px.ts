import path from "node:path";
import { promises as fs } from "node:fs";
import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
import { pathExists } from "../utils/fs.js";
import { createUnifiedDiff } from "../utils/diff.js";

const GRADLE_PROPERTIES_RELATIVE = path.join("android", "gradle.properties");
const APP_BUILD_GRADLE = path.join("android", "app", "build.gradle");
const APP_BUILD_GRADLE_KTS = path.join("android", "app", "build.gradle.kts");
const MANIFEST_PATH = path.join("android", "app", "src", "main", "AndroidManifest.xml");
const ANDROID_SRC = path.join("android", "app", "src", "main");

const DEFAULT_PX_SDK_VERSION = "10.2.12";
const DEFAULT_RN_PX_VERSION = "^3.7.0";

const PX_DEP_GROOVY = "implementation \"com.netcore.android:smartech-nudges:${SMARTECH_PX_SDK_VERSION}\"";
const PX_DEP_KTS =
  "implementation(\"com.netcore.android:smartech-nudges:\" + project.property(\"SMARTECH_PX_SDK_VERSION\"))";

const PX_IMPORT = "import { HanselTrackerRn } from 'smartech-reactnative-nudges';";
const BASE_REACT_IMPORT = "import SmartechBaseReact from 'smartech-base-react-native';";

const PX_USE_EFFECT = `useEffect(() => {\n  HanselTrackerRn.addListener('HanselInternalEvent', (e) => {\n    console.log('Event Detail:', e);\n    SmartechBaseReact.trackEvent(e.eventName, e.properties);\n  });\n\n  HanselTrackerRn.addListener('HanselDeepLinkListener', (e) => {\n    console.log('DeepLink Listener URL:', e.deeplink);\n  });\n\n  HanselTrackerRn.registerHanselTrackerListener();\n\n  HanselTrackerRn.registerHanselDeeplinkListener();\n}, []);`;

const RN_PX_MANUAL_SNIPPET = `import { HanselTrackerRn } from 'smartech-reactnative-nudges';
import SmartechBaseReact from 'smartech-base-react-native';

useEffect(() => {
  HanselTrackerRn.addListener('HanselInternalEvent', (e) => {
    console.log('Event Detail:', e);
    SmartechBaseReact.trackEvent(e.eventName, e.properties);
  });

  HanselTrackerRn.addListener('HanselDeepLinkListener', (e) => {
    console.log('DeepLink Listener URL:', e.deeplink);
  });

  HanselTrackerRn.registerHanselTrackerListener();

  HanselTrackerRn.registerHanselDeeplinkListener();
}, []);
`;

const RN_PX_MAINACTIVITY_SNIPPET = `// Kotlin MainActivity
import io.hansel.hanselsdk.Hansel

override fun onCreate(savedInstanceState: Bundle?) {
  super.onCreate(savedInstanceState)
  Hansel.pairTestDevice(intent?.dataString)
}

// AndroidManifest.xml (launcher activity)
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="YOUR_CUSTOM_SCHEME" />
</intent-filter>
`;

const RN_PX_NATIVE_SNIPPET = `// MainApplication (Kotlin)
// Uncomment these blocks only if your use case requires dynamic/ignore view mapping.
import android.view.View
import com.facebook.react.uimanager.util.ReactFindViewUtil
import io.hansel.react.HanselRn
import YOUR.PACKAGE.R

override fun onCreate() {
  super.onCreate()
  // val nativeIdSetDynamic: MutableSet<String> = HashSet()
  // nativeIdSetDynamic.add("hansel_dynamic_view")
  //
  // ReactFindViewUtil.addViewsListener(
  //   ReactFindViewUtil.OnMultipleViewsFoundListener { view, nativeID ->
  //     if (nativeID == "hansel_dynamic_view") {
  //       val values = view.tag.toString().split("#")
  //       val hanselIndex = values[0]
  //       val n = if (values.size < 2 || values[1].isEmpty()) 0 else values[1].toInt()
  //       HanselRn.setDynamicHanselIndex(view, hanselIndex, n)
  //     }
  //   },
  //   nativeIdSetDynamic
  // )
  //
  // val nativeIdSetIgnore: MutableSet<String> = HashSet()
  // nativeIdSetIgnore.add("hansel_ignore_view_overlay")
  // nativeIdSetIgnore.add("hansel_ignore_view")
  //
  // ReactFindViewUtil.addViewsListener(
  //   ReactFindViewUtil.OnMultipleViewsFoundListener { view, nativeID ->
  //     if (nativeID == "hansel_ignore_view_overlay") {
  //       val values = view.tag.toString().split("#")
  //       val parentsLayerCount = values[0].toInt()
  //       val childLayerIndex =
  //           if (values.size < 2 || values[1].isEmpty()) 0 else values[1].toInt()
  //       HanselRn.setHanselIgnoreViewTag(view, parentsLayerCount, childLayerIndex)
  //     } else {
  //       view.setTag(R.id.hansel_ignore_view, true)
  //     }
  //   },
  //   nativeIdSetIgnore
  // )
}

// res/values/tags.xml
<resources>
  <item name="hansel_ignore_view" type="id"/>
</resources>
`;

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
  const androidMain = path.join(context.rootPath, ANDROID_SRC);
  const javaRoot = path.join(androidMain, "java");
  const manifestPackage = await readManifestPackage(manifestFile);
  const metaChange = await ensureHanselMeta(manifestFile, hanselAppId, hanselAppKey);
  if (metaChange) changes.push(metaChange);

  const launcher = await findLauncherActivity(manifestFile);
  if (launcher) {
    const intentChange = await ensurePxIntentFilter(manifestFile, launcher, pxScheme);
    if (intentChange) changes.push(intentChange);
  }
  if (!launcher) {
    changes.push({
      id: "android-manifest-px-intent-manual",
      title: "Hansel deeplink intent filter not injected",
      filePath: manifestFile,
      kind: "insert",
      patch: "",
      summary: "Launcher activity not found. Add Hansel intent filter manually.",
      confidence: 0.2,
      manualSnippet: RN_PX_MAINACTIVITY_SNIPPET,
      module: "px"
    });
  }

  const appFile = await findAppEntryFile(context.rootPath);
  if (appFile) {
    const appChange = await ensurePxUseEffect(appFile);
    if (appChange) changes.push(appChange);
  } else {
    changes.push({
      id: "rn-app-px-manual",
      title: "PX hooks not injected",
      filePath: path.join(context.rootPath, "App.js"),
      kind: "insert",
      patch: "",
      summary: "App entry file not found. Add Hansel listeners manually.",
      confidence: 0.2,
      manualSnippet: RN_PX_MANUAL_SNIPPET,
      module: "px"
    });
  }

  const mainActivity = await findMainActivityFile(context.rootPath, launcher);
  if (mainActivity) {
    const mainChange = await ensurePxMainActivity(mainActivity);
    if (mainChange) changes.push(mainChange);
  } else {
    changes.push({
      id: "android-mainactivity-hansel-manual",
      title: "Hansel pairTestDevice not injected",
      filePath: path.join(context.rootPath, "android", "app", "src", "main"),
      kind: "insert",
      patch: "",
      summary: "MainActivity not found. Add Hansel.pairTestDevice manually.",
      confidence: 0.2,
      manualSnippet: RN_PX_MAINACTIVITY_SNIPPET,
      module: "px"
    });
  }

  if (await pathExists(javaRoot)) {
    const appClass = await findAndroidApplicationClass(javaRoot);
    if (appClass) {
      const appChange = await ensureHanselNativeEnhancements(appClass.filePath, manifestPackage);
      if (appChange) changes.push(appChange);
    } else {
      changes.push({
        id: "android-hansel-native-manual",
        title: "Hansel native enhancements not injected",
        filePath: javaRoot,
        kind: "insert",
        patch: "",
        summary:
          "Application class not found. Add Hansel dynamic view mapping and ignore view handling manually.",
        confidence: 0.2,
        manualSnippet: RN_PX_NATIVE_SNIPPET,
        module: "px"
      });
    }
  }

  const tagsChange = await ensureHanselTagsXml(context.rootPath);
  if (tagsChange) changes.push(tagsChange);

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
    newContent = originalContent
      .replace(/[A-Za-z_]+\s*\([^\n]*com\.netcore\.android:smartech-nudges[^\n]*\)/, depLine)
      .replace(
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
  if (!newContent.includes(BASE_REACT_IMPORT)) {
    newContent = `${BASE_REACT_IMPORT}\n${newContent}`;
  }

  if (!newContent.includes("useEffect")) {
    newContent = ensureReactUseEffectImport(newContent);
  }

  const hasInternalListener = /HanselInternalEvent/.test(newContent);
  const hasTrackEvent = /SmartechBaseReact\.trackEvent/.test(newContent);
  if (hasInternalListener && !hasTrackEvent) {
    newContent = ensureHanselTrackEvent(newContent);
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

function ensureHanselTrackEvent(source: string): string {
  const listenerRegex =
    /HanselTrackerRn\.addListener\('HanselInternalEvent',\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/;
  const match = source.match(listenerRegex);
  if (!match) return source;

  const body = match[1];
  if (body.includes("SmartechBaseReact.trackEvent")) return source;

  const lines = body.split("\n");
  const insertLine = "    SmartechBaseReact.trackEvent(e.eventName, e.properties);";
  const consoleIndex = lines.findIndex((line) => line.includes("console.log('Event Detail'"));

  if (consoleIndex >= 0) {
    lines.splice(consoleIndex + 1, 0, insertLine);
  } else {
    lines.push(insertLine);
  }

  const rebuilt = `HanselTrackerRn.addListener('HanselInternalEvent', (e) => {${lines.join("\n")}\n  });`;
  return source.replace(listenerRegex, rebuilt);
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
    lines.push("    SmartechBaseReact.trackEvent(e.eventName, e.properties);");
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

async function ensureHanselTagsXml(rootPath: string): Promise<Change | null> {
  const valuesDir = path.join(rootPath, "android", "app", "src", "main", "res", "values");
  const filePath = path.join(valuesDir, "tags.xml");
  const tagLine = "    <item name=\"hansel_ignore_view\" type=\"id\"/>";

  if (!(await pathExists(valuesDir))) {
    return null;
  }

  if (!(await pathExists(filePath))) {
    const newContent = `<resources>\n${tagLine}\n</resources>\n`;
    return buildChange({
      id: "android-tags-xml",
      title: "Add Hansel tags.xml",
      filePath,
      kind: "create",
      originalContent: "",
      newContent,
      summary: "Create tags.xml with hansel_ignore_view id.",
      confidence: 0.35
    });
  }

  const originalContent = await fs.readFile(filePath, "utf-8");
  if (originalContent.includes("hansel_ignore_view")) {
    return null;
  }

  let newContent = originalContent;
  if (/<resources[^>]*>/.test(originalContent)) {
    newContent = originalContent.replace(/<resources[^>]*>/, (match) => `${match}\n${tagLine}`);
  } else {
    newContent = `${originalContent.trimEnd()}\n<resources>\n${tagLine}\n</resources>\n`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "android-tags-xml",
    title: "Add Hansel tags.xml entry",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add hansel_ignore_view id entry to tags.xml.",
    confidence: 0.35
  });
}

async function ensureHanselNativeEnhancements(
  filePath: string,
  manifestPackage: string | null
): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kt");
  const packageName = manifestPackage ?? readPackageName(originalContent);
  let updated = originalContent;

  const imports = isKotlin
    ? [
        "android.view.View",
        "com.facebook.react.uimanager.util.ReactFindViewUtil",
        "io.hansel.react.HanselRn",
        packageName ? `${packageName}.R` : null
      ]
    : [
        "android.view.View",
        "com.facebook.react.uimanager.util.ReactFindViewUtil",
        "java.util.Set",
        "java.util.HashSet",
        "io.hansel.react.HanselRn",
        packageName ? `${packageName}.R` : null
      ];

  updated = isKotlin ? ensureKotlinImports(updated, imports) : ensureJavaImports(updated, imports);

  const hasDynamicMarker = /hansel_dynamic_view/.test(updated);
  const hasIgnoreMarker = /hansel_ignore_view_overlay/.test(updated);
  const hasDynamic = hasDynamicMarker && /setDynamicHanselIndex/.test(updated);
  const hasIgnore = hasIgnoreMarker && /setHanselIgnoreViewTag/.test(updated);

  const needsDynamic = !hasDynamic;
  const needsIgnore = !hasIgnore;

  if (needsDynamic || needsIgnore) {
    if (/onCreate\s*\(/.test(updated)) {
      if (needsDynamic && needsIgnore && !hasDynamicMarker && !hasIgnoreMarker) {
        const combined = `${buildIgnoreBlock(isKotlin)}\n\n${buildDynamicBlock(isKotlin)}`;
        updated = insertAfterAnchor(updated, combined) ?? insertAfterSuper(updated, combined);
      } else {
        if (needsIgnore) {
          updated = upsertHanselBlock(updated, buildIgnoreBlock(isKotlin), "hansel_ignore_view_overlay");
        }
        if (needsDynamic) {
          updated = upsertHanselBlock(updated, buildDynamicBlock(isKotlin), "hansel_dynamic_view");
        }
      }
    } else {
      const blocks: string[] = [];
      if (needsIgnore) blocks.push(buildIgnoreBlock(isKotlin));
      if (needsDynamic) blocks.push(buildDynamicBlock(isKotlin));
      updated = addOnCreateWithBlocks(updated, blocks, isKotlin);
    }
  }

  if (updated === originalContent) return null;

  return buildChange({
    id: "android-hansel-native",
    title: "Add Hansel native view handling",
    filePath,
    kind: "insert",
    originalContent,
    newContent: updated,
    summary: "Inject Hansel dynamic view mapping and ignore view handling in Application.onCreate.",
    confidence: 0.4
  });
}

function buildDynamicBlock(isKotlin: boolean): string {
  if (isKotlin) {
    const lines = [
      "val nativeIdSetDynamic: MutableSet<String> = HashSet()",
      "nativeIdSetDynamic.add(\"hansel_dynamic_view\")",
      "",
      "ReactFindViewUtil.addViewsListener(",
      "    ReactFindViewUtil.OnMultipleViewsFoundListener { view, nativeID ->",
      "        if (nativeID == \"hansel_dynamic_view\") {",
      "            val values = view.tag.toString().split(\"#\")",
      "            val hanselIndex = values[0]",
      "            val n = if (values.size < 2 || values[1].isEmpty()) {",
      "                0",
      "            } else {",
      "                values[1].toInt()",
      "            }",
      "            HanselRn.setDynamicHanselIndex(view, hanselIndex, n)",
      "        }",
      "    },",
      "    nativeIdSetDynamic",
      ")"
    ];
    return commentBlock(lines, "Hansel dynamic view mapping (uncomment if needed)");
  }

  const lines = [
    "Set<String> nativeIdSetDynamic = new HashSet<>();",
    "nativeIdSetDynamic.add(\"hansel_dynamic_view\");",
    "",
    "ReactFindViewUtil.addViewsListener(",
    "    new ReactFindViewUtil.OnMultipleViewsFoundListener() {",
    "        @Override",
    "        public void onViewFound(final View view, String nativeID) {",
    "            if (nativeID.equals(\"hansel_dynamic_view\")) {",
    "                String[] values1 = view.getTag().toString().split(\"#\");",
    "                String hanselIndex = values1[0];",
    "                int N;",
    "                if (values1.length < 2 || values1[1].isEmpty()) {",
    "                    N = 0;",
    "                } else {",
    "                    N = Integer.parseInt(values1[1]);",
    "                }",
    "                HanselRn.setDynamicHanselIndex(view, hanselIndex, N);",
    "            }",
    "        }",
    "    },",
    "    nativeIdSetDynamic",
    ");"
  ];
  return commentBlock(lines, "Hansel dynamic view mapping (uncomment if needed)");
}

function buildIgnoreBlock(isKotlin: boolean): string {
  if (isKotlin) {
    const lines = [
      "val nativeIdSetIgnore: MutableSet<String> = HashSet()",
      "nativeIdSetIgnore.add(\"hansel_ignore_view_overlay\")",
      "nativeIdSetIgnore.add(\"hansel_ignore_view\")",
      "",
      "ReactFindViewUtil.addViewsListener(",
      "    ReactFindViewUtil.OnMultipleViewsFoundListener { view, nativeID ->",
      "        if (nativeID == \"hansel_ignore_view_overlay\") {",
      "            val values = view.tag.toString().split(\"#\")",
      "            val parentsLayerCount = values[0].toInt()",
      "            val childLayerIndex =",
      "                if (values.size < 2 || values[1].isEmpty()) 0 else values[1].toInt()",
      "            HanselRn.setHanselIgnoreViewTag(",
      "                view,",
      "                parentsLayerCount,",
      "                childLayerIndex",
      "            )",
      "        } else {",
      "            view.setTag(R.id.hansel_ignore_view, true)",
      "        }",
      "    },",
      "    nativeIdSetIgnore",
      ")"
    ];
    return commentBlock(lines, "Hansel ignore view handling (uncomment if needed)");
  }

  const lines = [
    "Set<String> nativeIdSetIgnore = new HashSet<>();",
    "nativeIdSetIgnore.add(\"hansel_ignore_view_overlay\");",
    "nativeIdSetIgnore.add(\"hansel_ignore_view\");",
    "",
    "ReactFindViewUtil.addViewsListener(",
    "    new ReactFindViewUtil.OnMultipleViewsFoundListener() {",
    "        @Override",
    "        public void onViewFound(final View view, String nativeID) {",
    "            if (nativeID.equals(\"hansel_ignore_view_overlay\")) {",
    "                String[] values = view.getTag().toString().split(\"#\");",
    "                int parentsLayerCount = Integer.parseInt(values[0]);",
    "                int childLayerIndex;",
    "                if (values.length < 2 || values[1].isEmpty()) {",
    "                    childLayerIndex = 0;",
    "                } else {",
    "                    childLayerIndex = Integer.parseInt(values[1]);",
    "                }",
    "                HanselRn.setHanselIgnoreViewTag(",
    "                    view,",
    "                    parentsLayerCount,",
    "                    childLayerIndex",
    "                );",
    "            } else {",
    "                view.setTag(R.id.hansel_ignore_view, true);",
    "            }",
    "        }",
    "    },",
    "    nativeIdSetIgnore",
    ");"
  ];
  return commentBlock(lines, "Hansel ignore view handling (uncomment if needed)");
}

function addOnCreateWithBlocks(source: string, blocks: string[], isKotlin: boolean): string {
  if (blocks.length === 0) return source;
  const body = blocks.join("\n\n");

  if (isKotlin) {
    return source.replace(
      /class\s+\w+\s*:\s*[^\{]+\{/,
      (match) =>
        `${match}\n\n    override fun onCreate() {\n        super.onCreate()\n${indentBlock(
          body,
          "        "
        )}\n    }\n`
    );
  }

  return source.replace(
    /class\s+\w+\s+extends\s+\w+\s*\{/,
    (match) =>
      `${match}\n\n    @Override\n    public void onCreate() {\n        super.onCreate();\n${indentBlock(
        body,
        "        "
      )}\n    }\n`
  );
}

function upsertHanselBlock(source: string, block: string, marker: string): string {
  const lines = source.split("\n");
  const markerIndex = lines.findIndex((line) => line.includes(marker));
  if (markerIndex === -1) {
    return insertAfterAnchor(source, block) ?? insertAfterSuper(source, block);
  }

  let startIndex = -1;
  for (let i = markerIndex; i >= 0; i -= 1) {
    if (lines[i].includes("nativeIdSet")) {
      startIndex = i;
      break;
    }
    if (lines[i].includes("ReactFindViewUtil.addViewsListener")) {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    return insertAfterSuper(source, block);
  }

  let endIndex = -1;
  for (let i = markerIndex; i < lines.length; i += 1) {
    if (lines[i].trim() === ");" || lines[i].trim() === ")" || lines[i].trim().endsWith(");")) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return insertAfterAnchor(source, block) ?? insertAfterSuper(source, block);
  }

  const indent = (lines[startIndex].match(/^\s*/) ?? [""])[0];
  const blockLines = indentBlock(block, indent).split("\n");
  const next = [...lines.slice(0, startIndex), ...blockLines, "", ...lines.slice(endIndex + 1)];
  return next.join("\n");
}

function insertAfterAnchor(source: string, block: string): string | null {
  const anchorRegexes = [
    /smartechBasePlugin\.init\s*\(\s*this\s*\)/,
    /smartechBasePlugin\.init\s*\(\s*this\s*\)\s*;/,
    /val\s+smartechBasePlugin\s*=\s*SmartechBasePlugin\.getInstance\(\)/,
    /SmartechBasePlugin\.getInstance\(\)/,
    /SmartechBasePlugin\.instance/,
    /SmartechBasePlugin\.getInstance\(\)\s*;/
  ];

  for (const regex of anchorRegexes) {
    const match = source.match(regex);
    if (!match) continue;
    const indent = (match[0].match(/^\s*/) ?? [""])[0];
    const blockIndented = indentBlock(block, indent);
    return source.replace(regex, (m) => `${m}\n${blockIndented}\n`);
  }
  return null;
}

function insertAfterSuper(source: string, block: string): string {
  const superRegex = /super\.onCreate\s*\([^\)]*\)\s*;?/;
  const match = source.match(superRegex);
  if (!match) return source;
  const indent = (match[0].match(/^\s*/) ?? [""])[0];
  const blockIndented = indentBlock(block, indent);
  return source.replace(superRegex, (m) => `${m}\n${blockIndented}\n`);
}

function indentBlock(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line) => (line.trim().length === 0 ? line : `${indent}${line}`))
    .join("\n");
}

function commentBlock(lines: string[], header: string): string {
  const commented = [`// ${header}`];
  for (const line of lines) {
    if (line.trim().length === 0) {
      commented.push("//");
    } else {
      commented.push(`// ${line}`);
    }
  }
  commented.push("//");
  return commented.join("\n");
}

function ensureJavaImports(source: string, imports: (string | null)[]): string {
  let updated = source;
  for (const imp of imports) {
    if (!imp) continue;
    if (!updated.includes(`import ${imp};`)) {
      updated = updated.replace(/(package\s+[^;]+;\s*)/m, `$1\nimport ${imp};\n`);
    }
  }
  return updated;
}

function ensureKotlinImports(source: string, imports: (string | null)[]): string {
  let updated = source;
  for (const imp of imports) {
    if (!imp) continue;
    if (!updated.includes(`import ${imp}`)) {
      updated = updated.replace(/(package\s+[^\n]+\n)/, `$1import ${imp}\n`);
    }
  }
  return updated;
}

function readPackageName(source: string): string | null {
  const match = source.match(/package\s+([^\s;]+)/);
  return match ? match[1] : null;
}

async function readManifestPackage(manifestPath: string): Promise<string | null> {
  if (!(await pathExists(manifestPath))) return null;
  const contents = await fs.readFile(manifestPath, "utf-8");
  const match = contents.match(/package\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

async function findAndroidApplicationClass(javaRoot: string): Promise<
  | {
      filePath: string;
      className: string;
    }
  | null
> {
  const candidates = await walkFiles(javaRoot, [".java", ".kt"]);
  for (const filePath of candidates) {
    const contents = await fs.readFile(filePath, "utf-8");
    const classMatch = contents.match(/class\s+(\w+)\s+extends\s+(Application|ReactApplication)/);
    if (classMatch) {
      return { filePath, className: classMatch[1] };
    }
    const kotlinMatch = contents.match(/class\s+(\w+)\s*:\s*(Application|ReactApplication)/);
    if (kotlinMatch) {
      return { filePath, className: kotlinMatch[1] };
    }
  }
  return null;
}

async function walkFiles(root: string, extensions: string[]): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
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
