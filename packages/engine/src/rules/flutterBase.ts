import path from "node:path";
import { promises as fs } from "node:fs";
import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
import { pathExists } from "../utils/fs.js";
import { createUnifiedDiff } from "../utils/diff.js";

const ANDROID_SRC = path.join("android", "app", "src", "main");
const MANIFEST_RELATIVE = path.join(ANDROID_SRC, "AndroidManifest.xml");
const JAVA_SRC = path.join(ANDROID_SRC, "java");
const KOTLIN_SRC = path.join(ANDROID_SRC, "kotlin");
const GRADLE_PROPERTIES_RELATIVE = path.join("android", "gradle.properties");
const APP_BUILD_GRADLE = path.join("android", "app", "build.gradle");
const APP_BUILD_GRADLE_KTS = path.join("android", "app", "build.gradle.kts");
const SETTINGS_GRADLE_KTS = path.join("android", "settings.gradle.kts");
const SETTINGS_GRADLE = path.join("android", "settings.gradle");
const PROJECT_BUILD_GRADLE = path.join("android", "build.gradle");

const SMARTECH_MAVEN = "https://artifacts.netcore.co.in/artifactory/android";
const DEFAULT_ANDROID_SDK_VERSION = "3.7.6";
const DEFAULT_FLUTTER_SDK_VERSION = "^3.5.0";

const SMARTECH_IMPORT = "com.netcore.android.Smartech";
const SMARTECH_FLUTTER_IMPORT = "com.netcore.android.smartech_base.SmartechBasePlugin";
const SMARTECH_PUSH_IMPORT = "com.netcore.android.smartech_push.SmartechPushPlugin";
const WEAKREF_IMPORT = "java.lang.ref.WeakReference";
const JAVA_BASE_PLUGIN_INIT = "SmartechBasePlugin.Companion.initializePlugin(this);";
const KOTLIN_BASE_PLUGIN_INIT = "SmartechBasePlugin.initializePlugin(this)";
const JAVA_PUSH_PLUGIN_INIT = "SmartechPushPlugin.Companion.initializePlugin(this);";
const KOTLIN_PUSH_PLUGIN_INIT = "SmartechPushPlugin.initializePlugin(this)";

const FLUTTER_PUBSPEC_DEP = "smartech_base";

const INIT_LINES_JAVA = [
  "Smartech.getInstance(new WeakReference<>(getApplicationContext())).initializeSdk(this);",
  "// Debug logs",
  "Smartech.getInstance(new WeakReference<>(getApplicationContext())).setDebugLevel(9);",
  "// Track install/update",
  "Smartech.getInstance(new WeakReference<>(getApplicationContext())).trackAppInstallUpdateBySmartech();",
  JAVA_BASE_PLUGIN_INIT
];

const INIT_LINES_KOTLIN = [
  "Smartech.getInstance(WeakReference(applicationContext)).initializeSdk(this)",
  "// Debug logs",
  "Smartech.getInstance(WeakReference(applicationContext)).setDebugLevel(9)",
  "// Track install/update",
  "Smartech.getInstance(WeakReference(applicationContext)).trackAppInstallUpdateBySmartech()",
  KOTLIN_BASE_PLUGIN_INIT
];

const DEEPLINK_LINES_JAVA = [
  "boolean isSmartechHandledDeeplink = Smartech.getInstance(new WeakReference<>(this)).isDeepLinkFromSmartech(getIntent());",
  "if (!isSmartechHandledDeeplink) {",
  "    // Handle app deeplink",
  "}"
];

const DEEPLINK_LINES_KOTLIN = [
  "val isSmartechHandledDeeplink = Smartech.getInstance(WeakReference(this)).isDeepLinkFromSmartech(intent)",
  "if (!isSmartechHandledDeeplink) {",
  "    // Handle app deeplink",
  "}"
];

type FlutterBaseContext = {
  scan: ProjectScan;
  rootPath: string;
  inputs?: IntegrationOptions["inputs"];
  includePush?: boolean;
};

export async function runFlutterBaseRules(context: FlutterBaseContext): Promise<Change[]> {
  const changes: Change[] = [];
  if (!context.scan.platforms.includes("android")) return changes;

  const rootPath = context.rootPath;
  const androidMain = path.join(rootPath, ANDROID_SRC);
  const javaRoot = path.join(androidMain, "java");
  const kotlinRoot = path.join(androidMain, "kotlin");
  const manifestPath = path.join(rootPath, MANIFEST_RELATIVE);

  const sourceRoots: string[] = [];
  if (await pathExists(javaRoot)) sourceRoots.push(javaRoot);
  if (await pathExists(kotlinRoot)) sourceRoots.push(kotlinRoot);

  if (sourceRoots.length === 0) {
    changes.push({
      id: "flutter-android-no-java-root",
      title: "Android source root not found",
      filePath: javaRoot,
      kind: "insert",
      patch: "",
      summary: "Expected android/app/src/main/java to exist. Integration requires Android sources.",
      confidence: 0.2,
      module: "base"
    });
    return changes;
  }

  const androidSdkVersion = context.inputs?.baseSdkVersion ?? DEFAULT_ANDROID_SDK_VERSION;
  const flutterSdkVersion = context.inputs?.flutterBaseSdkVersion ?? DEFAULT_FLUTTER_SDK_VERSION;

  const repoChange = await ensureMavenRepo(rootPath);
  if (repoChange) changes.push(repoChange);

  const gradlePropChange = await ensureGradleProperty(rootPath, androidSdkVersion);
  if (gradlePropChange) changes.push(gradlePropChange);

  const dependencyChange = await ensureAndroidDependency(rootPath);
  if (dependencyChange) changes.push(dependencyChange);

  const pubspecChange = await ensurePubspecDependency(rootPath, flutterSdkVersion);
  if (pubspecChange) changes.push(pubspecChange);

  const appClass = await findFlutterApplicationClass(sourceRoots);
  const manifestPackage = await readManifestPackage(manifestPath);

  if (!appClass) {
    const fallbackPackage = manifestPackage ?? "com.smartech.app";
    const className = "MyApplication";
    const useKotlin = sourceRoots.includes(kotlinRoot) && !sourceRoots.includes(javaRoot);
    const sourceDir = useKotlin ? KOTLIN_SRC : JAVA_SRC;
    const extension = useKotlin ? "kt" : "java";
    const relativePath = path.join(
      sourceDir,
      ...fallbackPackage.split("."),
      `${className}.${extension}`
    );
    const absolutePath = path.join(rootPath, relativePath);
    const newContent = useKotlin
      ? buildKotlinApplicationClass(fallbackPackage, className, Boolean(context.includePush))
      : buildJavaApplicationClass(fallbackPackage, className, Boolean(context.includePush));

    changes.push(
      buildChange({
        id: "flutter-create-application",
        title: "Create Application class with Smartech init",
        filePath: absolutePath,
        kind: "create",
        originalContent: "",
        newContent,
        summary:
          "No Application/FlutterApplication subclass detected. Create one, add Smartech init, and register it in AndroidManifest.xml.",
        confidence: 0.3
      })
    );

    const manifestChange = await ensureManifestApplicationName(
      manifestPath,
      className,
      fallbackPackage
    );
    if (manifestChange) changes.push(manifestChange);
  } else {
    const appChange = await ensureApplicationInit(appClass.filePath);
    if (appChange) changes.push(appChange);
  }

  const appId = context.inputs?.smartechAppId ?? "";
  const appIdChange = await ensureManifestMetaData(manifestPath, appId);
  if (appIdChange) changes.push(appIdChange);

  const autoFetchLocation = context.inputs?.autoFetchLocation;
  if (typeof autoFetchLocation === "boolean") {
    const locationChange = await ensureManifestFlagMeta(
      manifestPath,
      "SMT_IS_AUTO_FETCHED_LOCATION",
      autoFetchLocation ? "1" : "0"
    );
    if (locationChange) changes.push(locationChange);
  }

  const backupChanges = await ensureBackupConfig(rootPath, manifestPath);
  changes.push(...backupChanges);

  const deeplinkScheme = context.inputs?.deeplinkScheme ?? "";
  const launcherActivity = await findLauncherActivity(manifestPath, manifestPackage, sourceRoots);
  if (launcherActivity) {
    const activityChange = await ensureMainActivityDeeplink(launcherActivity.filePath);
    if (activityChange) changes.push(activityChange);

    const intentFilterChange = await ensureManifestDeeplinkIntent(
      manifestPath,
      launcherActivity.manifestName,
      deeplinkScheme
    );
    if (intentFilterChange) changes.push(intentFilterChange);
  }

  return changes;
}

function buildChange(input: Omit<Change, "patch">): Change {
  const patch = createUnifiedDiff(input.filePath, input.originalContent ?? "", input.newContent ?? "");
  return { module: "base", ...input, patch };
}

async function ensureMavenRepo(rootPath: string): Promise<Change | null> {
  const settingsKts = path.join(rootPath, SETTINGS_GRADLE_KTS);
  if (await pathExists(settingsKts)) {
    return ensureRepoInSettingsGradle(settingsKts);
  }
  const settingsGradle = path.join(rootPath, SETTINGS_GRADLE);
  if (await pathExists(settingsGradle)) {
    return ensureRepoInSettingsGradle(settingsGradle);
  }

  const buildGradle = path.join(rootPath, PROJECT_BUILD_GRADLE);
  if (!(await pathExists(buildGradle))) return null;
  return ensureRepoInBuildGradle(buildGradle);
}

async function ensureRepoInSettingsGradle(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  if (originalContent.includes(SMARTECH_MAVEN)) return null;

  const isKotlin = filePath.endsWith(".kts");
  const repoLine = isKotlin
    ? `maven { url = uri(\"${SMARTECH_MAVEN}\") }`
    : `maven { url '${SMARTECH_MAVEN}' }`;
  let newContent = originalContent;

  if (/repositories\s*\{/.test(originalContent)) {
    newContent = originalContent.replace(/repositories\s*\{/, (match) => `${match}\n        ${repoLine}`);
  } else {
    newContent = `${originalContent}\n\nrepositories {\n    ${repoLine}\n}`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-add-maven-repo",
    title: "Add Smartech Maven repository",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add Smartech Maven repo to settings.gradle(.kts) or build.gradle.",
    confidence: 0.4
  });
}

async function ensureRepoInBuildGradle(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  if (originalContent.includes(SMARTECH_MAVEN)) return null;

  const repoLine = `maven { url '${SMARTECH_MAVEN}' }`;
  let newContent = originalContent;

  if (/repositories\s*\{/.test(originalContent)) {
    newContent = originalContent.replace(/repositories\s*\{/, (match) => `${match}\n        ${repoLine}`);
  } else {
    newContent = `${originalContent}\n\nrepositories {\n    ${repoLine}\n}`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-add-maven-repo-build",
    title: "Add Smartech Maven repository",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add Smartech Maven repo to build.gradle repositories.",
    confidence: 0.35
  });
}

async function ensureGradleProperty(rootPath: string, version: string): Promise<Change | null> {
  const filePath = path.join(rootPath, GRADLE_PROPERTIES_RELATIVE);
  if (!(await pathExists(filePath))) return null;

  const originalContent = await fs.readFile(filePath, "utf-8");
  let newContent = originalContent;

  if (/SMARTECH_BASE_SDK_VERSION\s*=/.test(originalContent)) {
    newContent = originalContent.replace(
      /SMARTECH_BASE_SDK_VERSION\s*=\s*[^\n]+/,
      `SMARTECH_BASE_SDK_VERSION=${version}`
    );
  } else {
    newContent = `${originalContent.trimEnd()}\nSMARTECH_BASE_SDK_VERSION=${version}\n`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-gradle-properties-smartech",
    title: "Add Smartech SDK version to gradle.properties",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add SMARTECH_BASE_SDK_VERSION to gradle.properties.",
    confidence: 0.4
  });
}

async function ensureAndroidDependency(rootPath: string): Promise<Change | null> {
  const groovyPath = path.join(rootPath, APP_BUILD_GRADLE);
  const kotlinPath = path.join(rootPath, APP_BUILD_GRADLE_KTS);
  const filePath = (await pathExists(kotlinPath)) ? kotlinPath : groovyPath;
  if (!(await pathExists(filePath))) return null;

  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kts");
  const depLine = isKotlin
    ? "api(\"com.netcore.android:smartech-sdk:\" + project.property(\"SMARTECH_BASE_SDK_VERSION\"))"
    : "api \"com.netcore.android:smartech-sdk:${SMARTECH_BASE_SDK_VERSION}\"";

  let newContent = originalContent;
  if (originalContent.includes("com.netcore.android:smartech-sdk")) {
    newContent = originalContent
      .replace(/[A-Za-z_]+\s*\([^\n]*com\.netcore\.android:smartech-sdk[^\n]*\)/, depLine)
      .replace(
        /(api|implementation)\s*(\(|\s+)['\"]com\.netcore\.android:smartech-sdk:[^'\")]+['\"]\)?/,
        depLine
      );
  } else if (/dependencies\s*\{/.test(originalContent)) {
    newContent = originalContent.replace(/dependencies\s*\{/, (match) => `${match}\n    ${depLine}`);
  } else {
    newContent = `${originalContent}\n\ndependencies {\n    ${depLine}\n}`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-add-smartech-dependency",
    title: "Add Smartech SDK dependency",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add or update Smartech SDK dependency in app build.gradle(.kts).",
    confidence: 0.4
  });
}

async function ensurePubspecDependency(rootPath: string, version: string): Promise<Change | null> {
  const filePath = path.join(rootPath, "pubspec.yaml");
  if (!(await pathExists(filePath))) return null;

  const originalContent = await fs.readFile(filePath, "utf-8");
  if (/smartech_base\s*:/.test(originalContent)) {
    const newContent = originalContent.replace(
      /smartech_base\s*:\s*[^\n]+/,
      `smartech_base: ${version}`
    );
    if (newContent === originalContent) return null;
    return buildChange({
      id: "flutter-pubspec-smartech-base",
      title: "Update smartech_base dependency",
      filePath,
      kind: "update",
      originalContent,
      newContent,
      summary: "Update smartech_base dependency in pubspec.yaml.",
      confidence: 0.4
    });
  }

  const lines = originalContent.split("\n");
  const depIndex = lines.findIndex((line) => /^dependencies:\s*$/.test(line));
  if (depIndex === -1) return null;

  const indent = "  ";
  lines.splice(depIndex + 1, 0, `${indent}${FLUTTER_PUBSPEC_DEP}: ${version}`);
  const newContent = lines.join("\n");

  return buildChange({
    id: "flutter-pubspec-smartech-base",
    title: "Add smartech_base dependency",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add smartech_base dependency to pubspec.yaml.",
    confidence: 0.4
  });
}

async function readManifestPackage(manifestPath: string): Promise<string | null> {
  if (!(await pathExists(manifestPath))) return null;
  const contents = await fs.readFile(manifestPath, "utf-8");
  const match = contents.match(/package\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

async function findFlutterApplicationClass(sourceRoots: string[]): Promise<{ filePath: string } | null> {
  for (const root of sourceRoots) {
    const candidates = await walkFiles(root, [".java", ".kt"]);
    for (const filePath of candidates) {
      const contents = await fs.readFile(filePath, "utf-8");
      if (/extends\s+(Application|FlutterApplication)/.test(contents)) {
        return { filePath };
      }
      if (/class\s+\w+\s*:\s*(Application|FlutterApplication)/.test(contents)) {
        return { filePath };
      }
    }
  }
  return null;
}

async function ensureApplicationInit(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kt");
  const newContent = isKotlin ? injectKotlinInit(originalContent) : injectJavaInit(originalContent);
  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-application-init",
    title: "Inject Smartech init into Application.onCreate",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Ensure Smartech SDK initialization is called after super.onCreate in Application.",
    confidence: 0.5
  });
}

function injectJavaInit(source: string): string {
  let updated = source;

  updated = ensureJavaImports(updated, [WEAKREF_IMPORT, SMARTECH_IMPORT, SMARTECH_FLUTTER_IMPORT]);
  updated = normalizeJavaPluginInitCalls(updated);

  const missing = getMissingJavaInitLines(updated);
  if (missing.length === 0) return updated;

  if (/void\s+onCreate\s*\(/.test(updated)) {
    return updated.replace(
      /super\.onCreate\s*\(\s*\)\s*;?/,
      (match) => `${match}\n        ${missing.join("\n        ")}`
    );
  }

  return updated.replace(
    /class\s+\w+\s+extends\s+\w+\s*\{/,
    (match) =>
      `${match}\n\n    @Override\n    public void onCreate() {\n        super.onCreate();\n        ${missing.join(
      "\n        "
    )}\n    }\n`
  );
}

function injectKotlinInit(source: string): string {
  let updated = source;

  updated = ensureKotlinImports(updated, [WEAKREF_IMPORT, SMARTECH_IMPORT, SMARTECH_FLUTTER_IMPORT]);

  const missing = getMissingKotlinInitLines(updated);
  if (missing.length === 0) return updated;

  if (/fun\s+onCreate\s*\(/.test(updated)) {
    return updated.replace(
      /super\.onCreate\s*\(\s*.*\)/,
      (match) => `${match}\n        ${missing.join("\n        ")}`
    );
  }

  return updated.replace(
    /class\s+\w+\s*:\s*\w+\s*\(\s*\)\s*\{/,
    (match) =>
      `${match}\n\n    override fun onCreate() {\n        super.onCreate()\n        ${missing.join(
      "\n        "
    )}\n    }\n`
  );
}

function getMissingJavaInitLines(source: string): string[] {
  const hasInit = /initializeSdk\(/.test(source);
  const hasDebug = /setDebugLevel\(/.test(source);
  const hasTrack = /trackAppInstallUpdateBySmartech\(/.test(source);
  const hasPlugin = /SmartechBasePlugin(?:\.Companion)?\.initializePlugin\(/.test(source);

  const lines: string[] = [];
  if (!hasInit) lines.push(INIT_LINES_JAVA[0]);
  if (!hasDebug) lines.push(INIT_LINES_JAVA[1], INIT_LINES_JAVA[2]);
  if (!hasTrack) lines.push(INIT_LINES_JAVA[3], INIT_LINES_JAVA[4]);
  if (!hasPlugin) lines.push(INIT_LINES_JAVA[5]);
  return dedupeLines(lines);
}

function getMissingKotlinInitLines(source: string): string[] {
  const hasInit = /initializeSdk\(/.test(source);
  const hasDebug = /setDebugLevel\(/.test(source);
  const hasTrack = /trackAppInstallUpdateBySmartech\(/.test(source);
  const hasPlugin = /SmartechBasePlugin\.initializePlugin\(/.test(source);

  const lines: string[] = [];
  if (!hasInit) lines.push(INIT_LINES_KOTLIN[0]);
  if (!hasDebug) lines.push(INIT_LINES_KOTLIN[1], INIT_LINES_KOTLIN[2]);
  if (!hasTrack) lines.push(INIT_LINES_KOTLIN[3], INIT_LINES_KOTLIN[4]);
  if (!hasPlugin) lines.push(INIT_LINES_KOTLIN[5]);
  return dedupeLines(lines);
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = line.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeJavaPluginInitCalls(source: string): string {
  let updated = source;
  updated = updated.replace(
    /SmartechBasePlugin\s*\.\s*initializePlugin\s*\(\s*this\s*\)\s*;?/g,
    JAVA_BASE_PLUGIN_INIT
  );
  updated = updated.replace(
    /SmartechPushPlugin\s*\.\s*initializePlugin\s*\(\s*this\s*\)\s*;?/g,
    JAVA_PUSH_PLUGIN_INIT
  );
  return updated;
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

function buildJavaApplicationClass(
  packageName: string,
  className: string,
  includePush: boolean
): string {
  const imports = [
    "import android.app.Application;",
    `import ${SMARTECH_IMPORT};`,
    `import ${SMARTECH_FLUTTER_IMPORT};`,
    includePush ? `import ${SMARTECH_PUSH_IMPORT};` : "",
    `import ${WEAKREF_IMPORT};`
  ]
    .filter(Boolean)
    .join("\n");
  const initLines = includePush
    ? [...INIT_LINES_JAVA, JAVA_PUSH_PLUGIN_INIT]
    : INIT_LINES_JAVA;
  return `package ${packageName};\n\n${imports}\n\npublic class ${className} extends Application {\n    @Override\n    public void onCreate() {\n        super.onCreate();\n        ${initLines.join("\n        ")}\n    }\n}\n`;
}

function buildKotlinApplicationClass(
  packageName: string,
  className: string,
  includePush: boolean
): string {
  const imports = [
    "import android.app.Application",
    `import ${SMARTECH_IMPORT}`,
    `import ${SMARTECH_FLUTTER_IMPORT}`,
    includePush ? `import ${SMARTECH_PUSH_IMPORT}` : "",
    `import ${WEAKREF_IMPORT}`
  ]
    .filter(Boolean)
    .join("\n");
  const initLines = includePush
    ? [...INIT_LINES_KOTLIN, KOTLIN_PUSH_PLUGIN_INIT]
    : INIT_LINES_KOTLIN;
  return `package ${packageName}\n\n${imports}\n\nclass ${className} : Application() {\n    override fun onCreate() {\n        super.onCreate()\n        ${initLines.join("\n        ")}\n    }\n}\n`;
}

async function ensureManifestApplicationName(
  manifestPath: string,
  className: string,
  packageName: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath))) return null;
  const originalContent = await fs.readFile(manifestPath, "utf-8");
  const fullName = `${packageName}.${className}`;

  if (originalContent.includes(`android:name=\"${fullName}\"`)) return null;

  let newContent = originalContent;

  if (/<application[^>]*android:name=/.test(originalContent)) {
    newContent = originalContent.replace(
      /<application([^>]*?)android:name=\"[^\"]*\"/,
      `<application$1android:name=\"${fullName}\"`
    );
  } else {
    newContent = originalContent.replace(
      /<application/,
      `<application android:name=\"${fullName}\"`
    );
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-manifest-application-name",
    title: "Register Application class in AndroidManifest.xml",
    filePath: manifestPath,
    kind: "update",
    originalContent,
    newContent,
    summary: "Ensure AndroidManifest.xml points to the generated Application class.",
    confidence: 0.4
  });
}

async function ensureManifestMetaData(manifestPath: string, appId: string): Promise<Change | null> {
  if (!(await pathExists(manifestPath)) || !appId) return null;

  const originalContent = await fs.readFile(manifestPath, "utf-8");
  const metaData = `    <meta-data\n        android:name=\"SMT_APP_ID\"\n        android:value=\"${appId}\" />`;

  let newContent = originalContent;

  if (originalContent.includes("SMT_APP_ID")) {
    newContent = originalContent.replace(
      /<meta-data[^>]*android:name=\"SMT_APP_ID\"[^>]*android:value=\"[^\"]*\"[^>]*\/>/,
      metaData
    );
  } else if (/<application[^>]*>/.test(originalContent)) {
    newContent = originalContent.replace(/<application[^>]*>/, (match) => `${match}\n${metaData}`);
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-manifest-metadata-appid",
    title: "Add Smartech app id meta-data",
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add SMT_APP_ID meta-data entry to AndroidManifest.xml.",
    confidence: 0.4
  });
}

async function ensureManifestFlagMeta(
  manifestPath: string,
  name: string,
  value: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath))) return null;

  const originalContent = await fs.readFile(manifestPath, "utf-8");
  const metaData = `    <meta-data\n        android:name=\"${name}\"\n        android:value=\"${value}\" />`;

  let newContent = originalContent;

  if (originalContent.includes(`android:name=\"${name}\"`)) {
    newContent = originalContent.replace(
      new RegExp(`<meta-data[^>]*android:name=\\"${name}\\"[^>]*android:value=\\"[^\\"]*\\"[^>]*\\/>`),
      metaData
    );
  } else if (/<application[^>]*>/.test(originalContent)) {
    newContent = originalContent.replace(/<application[^>]*>/, (match) => `${match}\n${metaData}`);
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: `flutter-manifest-metadata-${name.toLowerCase()}`,
    title: `Set ${name} meta-data`,
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: `Set ${name} meta-data entry to ${value}.`,
    confidence: 0.4
  });
}

async function ensureBackupConfig(rootPath: string, manifestPath: string): Promise<Change[]> {
  const changes: Change[] = [];
  const xmlDir = path.join(rootPath, "android", "app", "src", "main", "res", "xml");

  const backupFile = path.join(xmlDir, "my_backup_file.xml");
  const backupContent = `<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<full-backup-content>\n    <include domain=\"sharedpref\" path=\"smt_guid_preferences.xml\"/>\n    <include domain=\"sharedpref\" path=\"smt_preferences_guid.xml\"/>\n</full-backup-content>\n`;

  const backup31File = path.join(xmlDir, "my_backup_file_31.xml");
  const backup31Content = `<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<data-extraction-rules>\n   <cloud-backup disableIfNoEncryptionCapabilities=\"false\">\n       <include  domain=\"sharedpref\" path=\"smt_guid_preferences.xml\" />\n       <include domain=\"sharedpref\" path=\"smt_preferences_guid.xml\" />\n   </cloud-backup>\n</data-extraction-rules>\n`;

  if (!(await pathExists(backupFile))) {
    changes.push(
      buildChange({
        id: "flutter-backup-xml",
        title: "Add Smartech backup configuration",
        filePath: backupFile,
        kind: "create",
        originalContent: "",
        newContent: backupContent,
        summary: "Create my_backup_file.xml for Smartech reinstall tracking.",
        confidence: 0.4
      })
    );
  }

  if (!(await pathExists(backup31File))) {
    changes.push(
      buildChange({
        id: "flutter-backup-xml-31",
        title: "Add Smartech backup configuration for Android 12+",
        filePath: backup31File,
        kind: "create",
        originalContent: "",
        newContent: backup31Content,
        summary: "Create my_backup_file_31.xml for data extraction rules.",
        confidence: 0.4
      })
    );
  }

  const manifestUpdate = await ensureManifestBackupAttributes(manifestPath);
  if (manifestUpdate) changes.push(manifestUpdate);

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
    id: "flutter-manifest-backup-attrs",
    title: "Configure Smartech backup attributes",
    filePath: manifestPath,
    kind: "update",
    originalContent,
    newContent,
    summary: "Ensure allowBackup true and register backup XML files in manifest.",
    confidence: 0.4
  });
}

async function ensureMainActivityDeeplink(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");

  const isKotlin = filePath.endsWith(".kt");
  const newContent = isKotlin
    ? injectKotlinDeeplink(originalContent)
    : injectJavaDeeplink(originalContent);

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-mainactivity-deeplink",
    title: "Add Smartech deeplink handling in MainActivity",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Ensure Smartech deeplink handling runs after super.onCreate in launcher activity.",
    confidence: 0.45
  });
}

function injectJavaDeeplink(source: string): string {
  let updated = source;
  updated = ensureJavaImports(updated, [SMARTECH_IMPORT, WEAKREF_IMPORT]);

  const missing = getMissingJavaDeeplinkLines(updated);
  if (missing.length === 0) return updated;

  if (/void\s+onCreate\s*\(/.test(updated)) {
    return updated.replace(
      /super\.onCreate\s*\(\s*[^\)]*\)\s*;?/,
      (match) => `${match}\n        ${missing.join("\n        ")}`
    );
  }

  return updated.replace(
    /class\s+\w+\s+extends\s+\w+\s*\{/,
    (match) =>
      `${match}\n\n    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        ${missing.join(
        "\n        "
      )}\n    }\n`
  );
}

function injectKotlinDeeplink(source: string): string {
  let updated = source;
  updated = ensureKotlinImports(updated, [SMARTECH_IMPORT, WEAKREF_IMPORT]);

  const missing = getMissingKotlinDeeplinkLines(updated);
  if (missing.length === 0) return updated;

  if (/fun\s+onCreate\s*\(/.test(updated)) {
    return updated.replace(
      /super\.onCreate\s*\(\s*[^\)]*\)/,
      (match) => `${match}\n        ${missing.join("\n        ")}`
    );
  }

  const classWithBodyPattern = /class\s+\w+\s*:\s*[^{\n]+\{/;
  if (classWithBodyPattern.test(updated)) {
    return updated.replace(
      classWithBodyPattern,
      (match) =>
        `${match}\n\n    override fun onCreate(savedInstanceState: android.os.Bundle?) {\n        super.onCreate(savedInstanceState)\n        ${missing.join(
          "\n        "
        )}\n    }\n`
    );
  }

  const classNoBodyPattern = /class\s+\w+\s*:\s*[^\n{]+/;
  if (classNoBodyPattern.test(updated)) {
    return updated.replace(
      classNoBodyPattern,
      (match) =>
        `${match} {\n\n    override fun onCreate(savedInstanceState: android.os.Bundle?) {\n        super.onCreate(savedInstanceState)\n        ${missing.join(
          "\n        "
        )}\n    }\n}`
    );
  }

  return updated;
}

function getMissingJavaDeeplinkLines(source: string): string[] {
  const hasVar = /isDeepLinkFromSmartech\s*\(/.test(source);
  const hasIf = /if\s*\(!isSmartechHandledDeeplink\)/.test(source);

  const lines: string[] = [];
  if (!hasVar) lines.push(DEEPLINK_LINES_JAVA[0]);
  if (!hasIf) lines.push(...DEEPLINK_LINES_JAVA.slice(1));
  return dedupeLines(lines);
}

function getMissingKotlinDeeplinkLines(source: string): string[] {
  const hasVar = /isDeepLinkFromSmartech\s*\(/.test(source);
  const hasIf = /if\s*\(!isSmartechHandledDeeplink\)/.test(source);

  const lines: string[] = [];
  if (!hasVar) lines.push(DEEPLINK_LINES_KOTLIN[0]);
  if (!hasIf) lines.push(...DEEPLINK_LINES_KOTLIN.slice(1));
  return dedupeLines(lines);
}

async function findLauncherActivity(
  manifestPath: string,
  manifestPackage: string | null,
  sourceRoots: string[]
): Promise<{ filePath: string; manifestName: string } | null> {
  if (!(await pathExists(manifestPath))) return null;
  const manifest = await fs.readFile(manifestPath, "utf-8");
  const activityBlocks = manifest.match(/<activity[\s\S]*?<\/activity>/g) ?? [];
  let launcherName: string | null = null;

  for (const block of activityBlocks) {
    if (!block.includes("android.intent.action.MAIN") || !block.includes("android.intent.category.LAUNCHER")) {
      continue;
    }

    const nameMatch = block.match(/android:name=\"([^\"]+)\"/);
    if (!nameMatch) continue;

    const manifestName = nameMatch[1];
    launcherName = manifestName;
    const fqcn = resolveActivityClass(manifestName, manifestPackage);
    const found = await locateJavaOrKotlinFile(sourceRoots, fqcn);
    if (found) return { filePath: found, manifestName };
  }

  if (launcherName) {
    const fallback = await findFlutterActivityClass(sourceRoots);
    if (fallback) {
      return { filePath: fallback.filePath, manifestName: launcherName };
    }
  }

  return null;
}

async function ensureManifestDeeplinkIntent(
  manifestPath: string,
  activityName: string,
  scheme: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath)) || !scheme) return null;

  const originalContent = await fs.readFile(manifestPath, "utf-8");
  let newContent = originalContent;

  if (originalContent.includes(`android:host=\"smartech_sdk_td\"`)) {
    newContent = originalContent.replace(
      /android:scheme=\"[^\"]+\"\s*\n\s*android:host=\"smartech_sdk_td\"/,
      `android:scheme=\"${scheme}\"\n                android:host=\"smartech_sdk_td\"`
    );
  }

  const intentFilter = `        <intent-filter>\n            <action android:name=\"android.intent.action.VIEW\" />\n            <category android:name=\"android.intent.category.DEFAULT\" />\n            <category android:name=\"android.intent.category.BROWSABLE\" />\n            <data android:scheme=\"${scheme}\"\n                android:host=\"smartech_sdk_td\" />\n        </intent-filter>`;

  const activityPattern = new RegExp(
    `<activity[^>]*android:name=\\"${escapeRegex(activityName)}\\"[^>]*>`
  );

  if (!originalContent.includes(`android:host=\"smartech_sdk_td\"`)) {
    if (activityPattern.test(newContent)) {
      newContent = newContent.replace(activityPattern, (match) => `${match}\n${intentFilter}`);
    }
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-manifest-deeplink-intent",
    title: "Add Smartech deeplink intent filter",
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add Smartech deeplink intent filter to launcher activity.",
    confidence: 0.4
  });
}

async function locateJavaOrKotlinFile(sourceRoots: string[], fqcn: string): Promise<string | null> {
  const pathSegments = fqcn.split(".");
  const className = pathSegments.pop() ?? "";
  const packagePath = pathSegments.join(path.sep);

  for (const root of sourceRoots) {
    const javaPath = path.join(root, packagePath, `${className}.java`);
    const kotlinPath = path.join(root, packagePath, `${className}.kt`);
    if (await pathExists(javaPath)) return javaPath;
    if (await pathExists(kotlinPath)) return kotlinPath;
  }

  if (className) {
    const fallback = await findByClassName(sourceRoots, className);
    if (fallback) return fallback;
  }

  return null;
}

function resolveActivityClass(name: string, manifestPackage: string | null): string {
  if (name.startsWith(".")) {
    return manifestPackage ? `${manifestPackage}${name}` : name.slice(1);
  }
  if (name.includes(".")) {
    return name;
  }
  return `${manifestPackage ?? ""}.${name}`;
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findFlutterActivityClass(sourceRoots: string[]): Promise<{ filePath: string } | null> {
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

async function findByClassName(sourceRoots: string[], className: string): Promise<string | null> {
  for (const root of sourceRoots) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const found = await findByClassName([fullPath], className);
        if (found) return found;
        continue;
      }
      if (entry.name === `${className}.java` || entry.name === `${className}.kt`) {
        return fullPath;
      }
    }
  }
  return null;
}
