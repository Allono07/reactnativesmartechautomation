import path from "node:path";
import { promises as fs } from "node:fs";
import { pathExists } from "../utils/fs.js";
import { createUnifiedDiff } from "../utils/diff.js";
const ANDROID_SRC = path.join("android", "app", "src", "main");
const MANIFEST_RELATIVE = path.join(ANDROID_SRC, "AndroidManifest.xml");
const GRADLE_PROPERTIES_RELATIVE = path.join("android", "gradle.properties");
const APP_BUILD_GRADLE = path.join("android", "app", "build.gradle");
const APP_BUILD_GRADLE_KTS = path.join("android", "app", "build.gradle.kts");
const SETTINGS_GRADLE = path.join("android", "settings.gradle");
const SETTINGS_GRADLE_KTS = path.join("android", "settings.gradle.kts");
const PROJECT_BUILD_GRADLE = path.join("android", "build.gradle");
const SMARTECH_MAVEN = "https://artifacts.netcore.co.in/artifactory/android";
const DEFAULT_BASE_SDK_VERSION = "3.7.6";
const SMARTECH_IMPORT = "com.netcore.android.Smartech";
const SMARTECH_BASE_PLUGIN_CLASS = "SmartechBasePlugin";
const SMARTECH_BASE_PLUGIN_IMPORT = "com.smartechbasereactnative.SmartechBasePlugin";
const SMARTECH_WEAKREF_IMPORT = "java.lang.ref.WeakReference";
const SMARTECH_INIT_LINES = [
    "Smartech.getInstance(WeakReference(applicationContext)).initializeSdk(this);",
    "// Add the below line for debugging logs",
    "Smartech.getInstance(WeakReference(applicationContext)).setDebugLevel(9);",
    "// Add the below line to track app install and update by smartech",
    "Smartech.getInstance(WeakReference(applicationContext)).trackAppInstallUpdateBySmartech();",
    "SmartechBasePlugin smartechBasePlugin = SmartechBasePlugin.getInstance();",
    "smartechBasePlugin.init(this);"
];
const SMARTECH_INIT_LINES_KOTLIN = [
    "Smartech.getInstance(WeakReference(applicationContext)).initializeSdk(this)",
    "// Add the below line for debugging logs",
    "Smartech.getInstance(WeakReference(applicationContext)).setDebugLevel(9)",
    "// Add the below line to track app install and update by smartech",
    "Smartech.getInstance(WeakReference(applicationContext)).trackAppInstallUpdateBySmartech()",
    "val smartechBasePlugin = SmartechBasePlugin.getInstance()",
    "smartechBasePlugin.init(this)"
];
const DEEPLINK_SNIPPET_JAVA = [
    "boolean isSmartechHandledDeeplink = Smartech.getInstance(new WeakReference<>(this)).isDeepLinkFromSmartech(getIntent());",
    "if (!isSmartechHandledDeeplink) {",
    "    // Handle deeplink on app side",
    "}"
];
const DEEPLINK_SNIPPET_KOTLIN = [
    "val isSmartechHandledDeeplink = Smartech.getInstance(WeakReference(this)).isDeepLinkFromSmartech(intent)",
    "if (!isSmartechHandledDeeplink) {",
    "    // Handle deeplink on app side",
    "}"
];
const BASE_DEEPLINK_MANUAL_SNIPPET = `// MainActivity onCreate (Kotlin)
override fun onCreate(savedInstanceState: Bundle?) {
  super.onCreate(savedInstanceState)
  val isSmartechHandledDeeplink =
      Smartech.getInstance(WeakReference(this)).isDeepLinkFromSmartech(intent)
  if (!isSmartechHandledDeeplink) {
    // Handle deeplink on app side
  }
}

// AndroidManifest.xml (launcher activity)
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data
      android:scheme="YOUR_CUSTOM_SCHEME"
      android:host="smartech_sdk_td" />
</intent-filter>
`;
export async function runBaseRules(context) {
    const changes = [];
    if (!context.scan.platforms.includes("android")) {
        return changes;
    }
    const androidMain = path.join(context.rootPath, ANDROID_SRC);
    const javaRoot = path.join(androidMain, "java");
    const manifestPath = path.join(context.rootPath, MANIFEST_RELATIVE);
    if (!(await pathExists(javaRoot))) {
        changes.push({
            id: "android-no-java-root",
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
    const baseSdkVersion = context.inputs?.baseSdkVersion ?? DEFAULT_BASE_SDK_VERSION;
    const repoChange = await ensureMavenRepo(context.rootPath);
    if (repoChange)
        changes.push(repoChange);
    const gradlePropChange = await ensureGradleProperty(context.rootPath, baseSdkVersion);
    if (gradlePropChange)
        changes.push(gradlePropChange);
    const dependencyChange = await ensureAppDependency(context.rootPath);
    if (dependencyChange)
        changes.push(dependencyChange);
    const rnDependencyChange = await ensureReactNativeDependency(context.rootPath);
    if (rnDependencyChange)
        changes.push(rnDependencyChange);
    const appClass = await findAndroidApplicationClass(javaRoot);
    const manifestPackage = await readManifestPackage(manifestPath);
    if (!appClass) {
        const fallbackPackage = manifestPackage ?? "com.smartech.app";
        const className = "SmartechApplication";
        const relativePath = path.join("android", "app", "src", "main", "java", ...fallbackPackage.split("."), `${className}.java`);
        const absolutePath = path.join(context.rootPath, relativePath);
        const newContent = buildJavaApplicationClass(fallbackPackage, className);
        changes.push(buildChange({
            id: "android-create-application",
            title: "Create Application class with Smartech init",
            filePath: absolutePath,
            kind: "create",
            originalContent: "",
            newContent,
            summary: "No Application subclass detected. We will create one, add Smartech init in onCreate, and register it in AndroidManifest.xml.",
            confidence: 0.3
        }));
        const manifestChange = await ensureManifestApplicationName(manifestPath, className, fallbackPackage);
        if (manifestChange)
            changes.push(manifestChange);
    }
    else {
        const appChange = await ensureApplicationInit(appClass.filePath);
        if (appChange)
            changes.push(appChange);
    }
    const appId = context.inputs?.smartechAppId ?? "";
    const appIdChange = await ensureManifestMetaData(manifestPath, appId);
    if (appIdChange)
        changes.push(appIdChange);
    const backupChanges = await ensureBackupConfig(context.rootPath, manifestPath);
    changes.push(...backupChanges);
    const autoFetchLocation = context.inputs?.autoFetchLocation;
    if (typeof autoFetchLocation === "boolean") {
        const locationChange = await ensureManifestFlagMeta(manifestPath, "SMT_IS_AUTO_FETCHED_LOCATION", autoFetchLocation ? "1" : "0");
        if (locationChange)
            changes.push(locationChange);
    }
    const deeplinkScheme = context.inputs?.deeplinkScheme ?? "";
    const launcherActivity = await findLauncherActivity(manifestPath, manifestPackage, javaRoot);
    if (launcherActivity) {
        const activityChange = await ensureMainActivityDeeplink(launcherActivity.filePath);
        if (activityChange)
            changes.push(activityChange);
        const intentFilterChange = await ensureManifestDeeplinkIntent(manifestPath, launcherActivity.manifestName, deeplinkScheme);
        if (intentFilterChange)
            changes.push(intentFilterChange);
    }
    else {
        changes.push({
            id: "android-launcher-activity-missing",
            title: "Launcher activity not found",
            filePath: manifestPath,
            kind: "insert",
            patch: "",
            summary: "Could not locate the launcher activity from AndroidManifest.xml. MainActivity deeplink integration was skipped.",
            confidence: 0.2,
            manualSnippet: BASE_DEEPLINK_MANUAL_SNIPPET,
            module: "base"
        });
    }
    return changes;
}
function buildChange(input) {
    const patch = createUnifiedDiff(input.filePath, input.originalContent ?? "", input.newContent ?? "");
    return { module: "base", ...input, patch };
}
async function findAndroidApplicationClass(javaRoot) {
    const candidates = await walkFiles(javaRoot, [".java", ".kt"]);
    for (const filePath of candidates) {
        const contents = await fs.readFile(filePath, "utf-8");
        const classMatch = contents.match(/class\s+(\w+)\s+extends\s+(Application|ReactApplication)/);
        if (classMatch) {
            return {
                filePath,
                className: classMatch[1]
            };
        }
        const kotlinMatch = contents.match(/class\s+(\w+)\s*:\s*(Application|ReactApplication)/);
        if (kotlinMatch) {
            return {
                filePath,
                className: kotlinMatch[1]
            };
        }
    }
    return null;
}
async function readManifestPackage(manifestPath) {
    if (!(await pathExists(manifestPath))) {
        return null;
    }
    const contents = await fs.readFile(manifestPath, "utf-8");
    const match = contents.match(/package\s*=\s*"([^"]+)"/);
    return match ? match[1] : null;
}
async function ensureApplicationInit(filePath) {
    const originalContent = await fs.readFile(filePath, "utf-8");
    const isKotlin = filePath.endsWith(".kt");
    const newContent = isKotlin
        ? injectKotlinInit(originalContent)
        : injectJavaInit(originalContent);
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: "android-inject-oncreate",
        title: "Inject Smartech init into Application.onCreate",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Application class found. We will ensure Smartech SDK initialization is called after super.onCreate() and avoid duplicates.",
        confidence: 0.5
    });
}
function injectJavaInit(source) {
    let updated = source;
    updated = ensureJavaImports(updated, [
        SMARTECH_WEAKREF_IMPORT,
        SMARTECH_IMPORT,
        SMARTECH_BASE_PLUGIN_IMPORT,
        "android.content.Context"
    ]);
    const missingLines = getMissingJavaInitLines(updated);
    if (missingLines.length === 0) {
        return updated;
    }
    if (/void\s+onCreate\s*\(/.test(updated)) {
        return updated.replace(/super\.onCreate\s*\(\s*\)\s*;?/, (match) => `${match}\n        ${missingLines.join("\n        ")}`);
    }
    return updated.replace(/class\s+\w+\s+extends\s+\w+\s*\{/, (match) => `${match}\n\n    @Override\n    public void onCreate() {\n        super.onCreate();\n        ${missingLines.join("\n        ")}\n    }\n`);
}
function injectKotlinInit(source) {
    let updated = source;
    updated = ensureKotlinImports(updated, [
        SMARTECH_WEAKREF_IMPORT,
        SMARTECH_IMPORT,
        SMARTECH_BASE_PLUGIN_IMPORT
    ]);
    const missingLines = getMissingKotlinInitLines(updated);
    if (missingLines.length === 0) {
        return updated;
    }
    if (/fun\s+onCreate\s*\(/.test(updated)) {
        return updated.replace(/super\.onCreate\s*\(\s*.*\)/, (match) => `${match}\n        ${missingLines.join("\n        ")}`);
    }
    return updated.replace(/class\s+\w+\s*:\s*\w+\s*\(\s*\)\s*\{/, (match) => `${match}\n\n    override fun onCreate(savedInstanceState: android.os.Bundle?) {\n        super.onCreate(savedInstanceState)\n        ${missingLines.join("\n        ")}\n    }\n`);
}
function ensureJavaImports(source, imports) {
    let updated = source;
    for (const imp of imports) {
        if (!updated.includes(`import ${imp};`)) {
            updated = updated.replace(/(package\s+[^;]+;\s*)/m, `$1\nimport ${imp};\n`);
        }
    }
    return updated;
}
function ensureKotlinImports(source, imports) {
    let updated = source;
    for (const imp of imports) {
        if (!updated.includes(`import ${imp}`)) {
            updated = updated.replace(/(package\s+[^\n]+\n)/, `$1import ${imp}\n`);
        }
    }
    return updated;
}
function getMissingJavaInitLines(source) {
    const hasInitialize = /Smartech\.getInstance\(.*\)\.initializeSdk\(/.test(source);
    const hasDebug = /Smartech\.getInstance\(.*\)\.setDebugLevel\(/.test(source);
    const hasTrack = /Smartech\.getInstance\(.*\)\.trackAppInstallUpdateBySmartech\(/.test(source);
    const hasPluginGet = /SmartechBasePlugin\.getInstance\(/.test(source);
    const hasPluginInit = /smartechBasePlugin\.init\(/.test(source);
    const hasPluginBlock = hasPluginGet || hasPluginInit;
    const missing = [];
    if (!hasInitialize)
        missing.push(SMARTECH_INIT_LINES[0]);
    if (!hasDebug)
        missing.push(SMARTECH_INIT_LINES[1], SMARTECH_INIT_LINES[2]);
    if (!hasTrack)
        missing.push(SMARTECH_INIT_LINES[3], SMARTECH_INIT_LINES[4], SMARTECH_INIT_LINES[5]);
    if (!hasPluginBlock) {
        if (!missing.includes(SMARTECH_INIT_LINES[4])) {
            missing.push(SMARTECH_INIT_LINES[4]);
        }
        if (!missing.includes(SMARTECH_INIT_LINES[5])) {
            missing.push(SMARTECH_INIT_LINES[5]);
        }
    }
    return dedupeLines(missing);
}
function getMissingKotlinInitLines(source) {
    const hasInitialize = /Smartech\.getInstance\(.*\)\.initializeSdk\(/.test(source);
    const hasDebug = /Smartech\.getInstance\(.*\)\.setDebugLevel\(/.test(source);
    const hasTrack = /Smartech\.getInstance\(.*\)\.trackAppInstallUpdateBySmartech\(/.test(source);
    const hasPluginGet = /SmartechBasePlugin\.(getInstance|instance)/.test(source);
    const hasPluginInit = /smartechBasePlugin\.init\(/.test(source);
    const hasPluginBlock = hasPluginGet || hasPluginInit;
    const missing = [];
    if (!hasInitialize)
        missing.push(SMARTECH_INIT_LINES_KOTLIN[0]);
    if (!hasDebug)
        missing.push(SMARTECH_INIT_LINES_KOTLIN[1], SMARTECH_INIT_LINES_KOTLIN[2]);
    if (!hasTrack)
        missing.push(SMARTECH_INIT_LINES_KOTLIN[3], SMARTECH_INIT_LINES_KOTLIN[4], SMARTECH_INIT_LINES_KOTLIN[5]);
    if (!hasPluginBlock) {
        if (!missing.includes(SMARTECH_INIT_LINES_KOTLIN[4])) {
            missing.push(SMARTECH_INIT_LINES_KOTLIN[4]);
        }
        if (!missing.includes(SMARTECH_INIT_LINES_KOTLIN[5])) {
            missing.push(SMARTECH_INIT_LINES_KOTLIN[5]);
        }
    }
    return dedupeLines(missing);
}
function dedupeLines(lines) {
    const seen = new Set();
    return lines.filter((line) => {
        const key = line.trim();
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function buildJavaApplicationClass(packageName, className) {
    return `package ${packageName};\n\nimport android.app.Application;\nimport ${SMARTECH_IMPORT};\nimport ${SMARTECH_WEAKREF_IMPORT};\nimport ${SMARTECH_BASE_PLUGIN_IMPORT};\n\npublic class ${className} extends Application {\n    @Override\n    public void onCreate() {\n        super.onCreate();\n        ${SMARTECH_INIT_LINES.join("\n        ")}\n    }\n}\n`;
}
async function ensureManifestApplicationName(manifestPath, className, packageName) {
    if (!(await pathExists(manifestPath))) {
        return null;
    }
    const originalContent = await fs.readFile(manifestPath, "utf-8");
    const fullName = `${packageName}.${className}`;
    if (originalContent.includes(`android:name=\"${fullName}\"`)) {
        return null;
    }
    let newContent = originalContent;
    if (/<application[^>]*android:name=/.test(originalContent)) {
        newContent = originalContent.replace(/<application([^>]*?)android:name=\"[^\"]*\"/, `<application$1android:name=\"${fullName}\"`);
    }
    else {
        newContent = originalContent.replace(/<application/, `<application android:name=\"${fullName}\"`);
    }
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: "android-manifest-application-name",
        title: "Register Application class in AndroidManifest.xml",
        filePath: manifestPath,
        kind: "update",
        originalContent,
        newContent,
        summary: "Ensure AndroidManifest.xml points to the generated Application class.",
        confidence: 0.4
    });
}
async function ensureManifestMetaData(manifestPath, appId) {
    if (!(await pathExists(manifestPath)) || !appId) {
        return null;
    }
    const originalContent = await fs.readFile(manifestPath, "utf-8");
    const metaData = `    <meta-data\n        android:name=\"SMT_APP_ID\"\n        android:value=\"${appId}\" />`;
    let newContent = originalContent;
    if (originalContent.includes("SMT_APP_ID")) {
        newContent = originalContent.replace(/<meta-data[^>]*android:name=\"SMT_APP_ID\"[^>]*android:value=\"[^\"]*\"[^>]*\/>/, metaData);
    }
    else if (/<application[^>]*>/.test(originalContent)) {
        newContent = originalContent.replace(/<application[^>]*>/, (match) => `${match}\n${metaData}`);
    }
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: "android-manifest-metadata-appid",
        title: "Add Smartech app id meta-data",
        filePath: manifestPath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Add SMT_APP_ID meta-data entry to AndroidManifest.xml.",
        confidence: 0.4
    });
}
async function ensureManifestFlagMeta(manifestPath, name, value) {
    if (!(await pathExists(manifestPath))) {
        return null;
    }
    const originalContent = await fs.readFile(manifestPath, "utf-8");
    const metaData = `    <meta-data\n        android:name=\"${name}\"\n        android:value=\"${value}\" />`;
    let newContent = originalContent;
    if (originalContent.includes(`android:name=\"${name}\"`)) {
        newContent = originalContent.replace(new RegExp(`<meta-data[^>]*android:name=\\\\\"${name}\\\\\"[^>]*android:value=\\\\\"[^\\\\\"]*\\\\\"[^>]*\\\\/>`), metaData);
    }
    else if (/<application[^>]*>/.test(originalContent)) {
        newContent = originalContent.replace(/<application[^>]*>/, (match) => `${match}\n${metaData}`);
    }
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: `android-manifest-metadata-${name.toLowerCase()}`,
        title: `Set ${name} meta-data`,
        filePath: manifestPath,
        kind: "insert",
        originalContent,
        newContent,
        summary: `Set ${name} meta-data entry to ${value}.`,
        confidence: 0.4
    });
}
async function ensureBackupConfig(rootPath, manifestPath) {
    const changes = [];
    const xmlDir = path.join(rootPath, "android", "app", "src", "main", "res", "xml");
    const backupFile = path.join(xmlDir, "my_backup_file.xml");
    const backupContent = `<?xml version="1.0" encoding="utf-8"?>\n<full-backup-content>\n    <include domain="sharedpref" path="smt_guid_preferences.xml"/>\n    <include domain="sharedpref" path="smt_preferences_guid.xml"/>\n</full-backup-content>\n`;
    const backup31File = path.join(xmlDir, "my_backup_file_31.xml");
    const backup31Content = `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n   <cloud-backup disableIfNoEncryptionCapabilities="false">\n       <include  domain="sharedpref" path="smt_guid_preferences.xml" />\n       <include domain="sharedpref" path="smt_preferences_guid.xml" />\n   </cloud-backup>\n</data-extraction-rules>\n`;
    const manifestWarnings = await detectBackupWarnings(manifestPath);
    changes.push(...manifestWarnings);
    if (!(await pathExists(backupFile))) {
        changes.push(buildChange({
            id: "android-backup-xml",
            title: "Add Smartech backup configuration",
            filePath: backupFile,
            kind: "create",
            originalContent: "",
            newContent: backupContent,
            summary: "Create my_backup_file.xml for Smartech reinstall tracking.",
            confidence: 0.4
        }));
    }
    if (!(await pathExists(backup31File))) {
        changes.push(buildChange({
            id: "android-backup-xml-31",
            title: "Add Smartech backup configuration for Android 12+",
            filePath: backup31File,
            kind: "create",
            originalContent: "",
            newContent: backup31Content,
            summary: "Create my_backup_file_31.xml for data extraction rules.",
            confidence: 0.4
        }));
    }
    const manifestUpdate = await ensureManifestBackupAttributes(manifestPath);
    if (manifestUpdate)
        changes.push(manifestUpdate);
    return changes;
}
async function detectBackupWarnings(manifestPath) {
    if (!(await pathExists(manifestPath)))
        return [];
    const warnings = [];
    const originalContent = await fs.readFile(manifestPath, "utf-8");
    if (/android:allowBackup=\"false\"/.test(originalContent)) {
        warnings.push({
            id: "android-manifest-allowbackup-warning",
            title: "allowBackup is false in manifest",
            filePath: manifestPath,
            kind: "insert",
            patch: "",
            summary: "Manifest sets android:allowBackup=\"false\". Base integration will flip it to true for Smartech reinstall tracking.",
            confidence: 0.3,
            module: "base"
        });
    }
    const fullBackupMatch = originalContent.match(/android:fullBackupContent=\"([^\"]+)\"/);
    if (fullBackupMatch && fullBackupMatch[1] !== "@xml/my_backup_file") {
        warnings.push({
            id: "android-manifest-backupcontent-warning",
            title: "fullBackupContent already set",
            filePath: manifestPath,
            kind: "insert",
            patch: "",
            summary: `Manifest already sets android:fullBackupContent to ${fullBackupMatch[1]}. Base integration will update it to @xml/my_backup_file.`,
            confidence: 0.3,
            module: "base"
        });
    }
    const dataRulesMatch = originalContent.match(/android:dataExtractionRules=\"([^\"]+)\"/);
    if (dataRulesMatch && dataRulesMatch[1] !== "@xml/my_backup_file_31") {
        warnings.push({
            id: "android-manifest-datarules-warning",
            title: "dataExtractionRules already set",
            filePath: manifestPath,
            kind: "insert",
            patch: "",
            summary: `Manifest already sets android:dataExtractionRules to ${dataRulesMatch[1]}. Base integration will update it to @xml/my_backup_file_31.`,
            confidence: 0.3,
            module: "base"
        });
    }
    return warnings;
}
async function ensureManifestBackupAttributes(manifestPath) {
    if (!(await pathExists(manifestPath))) {
        return null;
    }
    const originalContent = await fs.readFile(manifestPath, "utf-8");
    let newContent = originalContent;
    if (!/<application/.test(newContent)) {
        return null;
    }
    if (!/android:allowBackup=/.test(newContent)) {
        newContent = newContent.replace(/<application/, `<application\n        android:allowBackup="true"`);
    }
    else {
        newContent = newContent.replace(/android:allowBackup="[^"]*"/, `android:allowBackup="true"`);
    }
    if (!/android:fullBackupContent=/.test(newContent)) {
        newContent = newContent.replace(/<application/, `<application\n        android:fullBackupContent="@xml/my_backup_file"`);
    }
    else {
        newContent = newContent.replace(/android:fullBackupContent="[^"]*"/, `android:fullBackupContent="@xml/my_backup_file"`);
    }
    if (!/android:dataExtractionRules=/.test(newContent)) {
        newContent = newContent.replace(/<application/, `<application\n        android:dataExtractionRules="@xml/my_backup_file_31"`);
    }
    else {
        newContent = newContent.replace(/android:dataExtractionRules="[^"]*"/, `android:dataExtractionRules="@xml/my_backup_file_31"`);
    }
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: "android-manifest-backup-attrs",
        title: "Configure Smartech backup attributes",
        filePath: manifestPath,
        kind: "update",
        originalContent,
        newContent,
        summary: "Ensure allowBackup true and register backup XML files in manifest.",
        confidence: 0.4
    });
}
async function ensureManifestDeeplinkIntent(manifestPath, activityName, scheme) {
    if (!(await pathExists(manifestPath)) || !scheme) {
        return null;
    }
    const originalContent = await fs.readFile(manifestPath, "utf-8");
    let newContent = originalContent;
    if (originalContent.includes(`android:host=\"smartech_sdk_td\"`)) {
        newContent = originalContent.replace(/android:scheme=\"[^\"]+\"\s*\n\s*android:host=\"smartech_sdk_td\"/, `android:scheme=\"${scheme}\"\n                android:host=\"smartech_sdk_td\"`);
    }
    const intentFilter = `        <intent-filter>\n            <action android:name=\"android.intent.action.VIEW\" />\n            <category android:name=\"android.intent.category.DEFAULT\" />\n            <category android:name=\"android.intent.category.BROWSABLE\" />\n            <data android:scheme=\"${scheme}\"\n                android:host=\"smartech_sdk_td\" />\n        </intent-filter>`;
    const activityPattern = new RegExp(`<activity[^>]*android:name=\\"${escapeRegex(activityName)}\\"[^>]*>`);
    if (!originalContent.includes(`android:host=\"smartech_sdk_td\"`)) {
        if (activityPattern.test(newContent)) {
            newContent = newContent.replace(activityPattern, (match) => `${match}\n${intentFilter}`);
        }
    }
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: "android-manifest-deeplink-intent",
        title: "Add Smartech deeplink intent filter",
        filePath: manifestPath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Add Smartech deeplink intent filter to launcher activity.",
        confidence: 0.4
    });
}
async function ensureMainActivityDeeplink(filePath) {
    const originalContent = await fs.readFile(filePath, "utf-8");
    if (originalContent.includes("isDeepLinkFromSmartech")) {
        return null;
    }
    const isKotlin = filePath.endsWith(".kt");
    const newContent = isKotlin
        ? injectKotlinDeeplink(originalContent)
        : injectJavaDeeplink(originalContent);
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: "android-mainactivity-deeplink",
        title: "Add Smartech deeplink handling in MainActivity",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Ensure Smartech deeplink handling runs after super.onCreate in the launcher activity.",
        confidence: 0.45
    });
}
function injectJavaDeeplink(source) {
    let updated = source;
    updated = ensureJavaImports(updated, [SMARTECH_IMPORT, SMARTECH_WEAKREF_IMPORT]);
    if (/void\s+onCreate\s*\(/.test(updated)) {
        return updated.replace(/super\.onCreate\s*\(\s*\)\s*;?/, (match) => `${match}\n        ${DEEPLINK_SNIPPET_JAVA.join("\n        ")}`);
    }
    return updated.replace(/class\s+\w+\s+extends\s+\w+\s*\{/, (match) => `${match}\n\n    @Override\n    protected void onCreate(android.os.Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        ${DEEPLINK_SNIPPET_JAVA.join("\n        ")}\n    }\n`);
}
function injectKotlinDeeplink(source) {
    let updated = source;
    updated = ensureKotlinImports(updated, [SMARTECH_IMPORT, SMARTECH_WEAKREF_IMPORT]);
    if (/fun\s+onCreate\s*\(/.test(updated)) {
        return updated.replace(/super\.onCreate\s*\(\s*\)/, (match) => `${match}\n        ${DEEPLINK_SNIPPET_KOTLIN.join("\n        ")}`);
    }
    return updated.replace(/class\s+\w+\s*:\s*\w+\s*\(\s*\)\s*\{/, (match) => `${match}\n\n    override fun onCreate(savedInstanceState: android.os.Bundle?) {\n        super.onCreate(savedInstanceState)\n        ${DEEPLINK_SNIPPET_KOTLIN.join("\n        ")}\n    }\n`);
}
async function ensureMavenRepo(rootPath) {
    const settingsKts = path.join(rootPath, SETTINGS_GRADLE_KTS);
    if (await pathExists(settingsKts)) {
        return ensureRepoInSettingsGradle(settingsKts);
    }
    const buildGradle = path.join(rootPath, PROJECT_BUILD_GRADLE);
    if (!(await pathExists(buildGradle))) {
        return null;
    }
    return ensureRepoInBuildGradle(buildGradle);
}
async function ensureRepoInSettingsGradle(filePath) {
    const originalContent = await fs.readFile(filePath, "utf-8");
    if (originalContent.includes(SMARTECH_MAVEN)) {
        return null;
    }
    const isKotlin = filePath.endsWith(".kts");
    const repoLine = isKotlin
        ? `maven { url = uri(\"${SMARTECH_MAVEN}\") }`
        : `maven { url '${SMARTECH_MAVEN}' }`;
    let newContent = originalContent;
    if (/dependencyResolutionManagement\s*\{/.test(originalContent)) {
        newContent = originalContent.replace(/repositories\s*\{/, (match) => `${match}\n        ${repoLine}`);
    }
    else if (/repositories\s*\{/.test(originalContent)) {
        newContent = originalContent.replace(/repositories\s*\{/, (match) => `${match}\n    ${repoLine}`);
    }
    else {
        const block = isKotlin
            ? `\n\ndependencyResolutionManagement {\n    repositories {\n        ${repoLine}\n    }\n}`
            : `\n\ndependencyResolutionManagement {\n    repositories {\n        ${repoLine}\n    }\n}`;
        newContent = `${originalContent}${block}`;
    }
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: "android-add-maven-repo",
        title: "Add Smartech Maven repository",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Add Smartech Maven repo to settings.gradle(.kts) repositories.",
        confidence: 0.4
    });
}
async function ensureRepoInBuildGradle(filePath) {
    const originalContent = await fs.readFile(filePath, "utf-8");
    if (originalContent.includes(SMARTECH_MAVEN)) {
        return null;
    }
    const repoLine = `maven { url '${SMARTECH_MAVEN}' }`;
    let newContent = originalContent;
    if (/repositories\s*\{/.test(originalContent)) {
        newContent = originalContent.replace(/repositories\s*\{/, (match) => `${match}\n        ${repoLine}`);
    }
    else {
        newContent = `${originalContent}\n\nrepositories {\n    ${repoLine}\n}`;
    }
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: "android-add-maven-repo-build-gradle",
        title: "Add Smartech Maven repository",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Add Smartech Maven repo to build.gradle repositories.",
        confidence: 0.35
    });
}
async function ensureGradleProperty(rootPath, version) {
    const filePath = path.join(rootPath, GRADLE_PROPERTIES_RELATIVE);
    if (!(await pathExists(filePath))) {
        return null;
    }
    const originalContent = await fs.readFile(filePath, "utf-8");
    let newContent = originalContent;
    if (/SMARTECH_BASE_SDK_VERSION\s*=/.test(originalContent)) {
        newContent = originalContent.replace(/SMARTECH_BASE_SDK_VERSION\s*=\s*[^\n]+/, `SMARTECH_BASE_SDK_VERSION=${version}`);
    }
    else {
        newContent = `${originalContent.trimEnd()}\nSMARTECH_BASE_SDK_VERSION=${version}\n`;
    }
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: "android-gradle-properties-smartech",
        title: "Add Smartech SDK version to gradle.properties",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Add SMARTECH_BASE_SDK_VERSION to gradle.properties.",
        confidence: 0.4
    });
}
async function ensureAppDependency(rootPath) {
    const groovyPath = path.join(rootPath, APP_BUILD_GRADLE);
    const kotlinPath = path.join(rootPath, APP_BUILD_GRADLE_KTS);
    const filePath = (await pathExists(kotlinPath)) ? kotlinPath : groovyPath;
    if (!(await pathExists(filePath))) {
        return null;
    }
    const originalContent = await fs.readFile(filePath, "utf-8");
    const isKotlin = filePath.endsWith(".kts");
    const depLine = isKotlin
        ? "implementation(\"com.netcore.android:smartech-sdk:${SMARTECH_BASE_SDK_VERSION}\")"
        : "implementation 'com.netcore.android:smartech-sdk:${SMARTECH_BASE_SDK_VERSION}'";
    let newContent = originalContent;
    if (originalContent.includes("com.netcore.android:smartech-sdk")) {
        newContent = originalContent.replace(/implementation\s*(\(|\s+)['"]com\.netcore\.android:smartech-sdk:[^'")]+['"]\)?/, depLine);
    }
    else if (/dependencies\s*\{/.test(originalContent)) {
        newContent = originalContent.replace(/dependencies\s*\{/, (match) => `${match}\n    ${depLine}`);
    }
    else {
        newContent = `${originalContent}\n\ndependencies {\n    ${depLine}\n}`;
    }
    if (newContent === originalContent) {
        return null;
    }
    return buildChange({
        id: "android-add-smartech-dependency",
        title: "Add Smartech SDK dependency",
        filePath,
        kind: "insert",
        originalContent,
        newContent,
        summary: "Add Smartech SDK dependency to app build.gradle(.kts).",
        confidence: 0.4
    });
}
async function ensureReactNativeDependency(rootPath) {
    const filePath = path.join(rootPath, "package.json");
    if (!(await pathExists(filePath))) {
        return null;
    }
    const originalContent = await fs.readFile(filePath, "utf-8");
    let parsed;
    try {
        parsed = JSON.parse(originalContent);
    }
    catch {
        return null;
    }
    const targetVersion = "^3.7.3";
    const dependencies = parsed.dependencies ?? {};
    const devDependencies = parsed.devDependencies ?? {};
    const currentVersion = dependencies["smartech-base-react-native"] ?? devDependencies["smartech-base-react-native"];
    if (currentVersion === targetVersion) {
        return null;
    }
    const nextDependencies = { ...dependencies, ["smartech-base-react-native"]: targetVersion };
    const nextParsed = { ...parsed, dependencies: nextDependencies };
    const newContent = JSON.stringify(nextParsed, null, 2) + "\n";
    return buildChange({
        id: "rn-add-smartech-base",
        title: "Add smartech-base-react-native dependency",
        filePath,
        kind: "update",
        originalContent,
        newContent,
        summary: "Ensure smartech-base-react-native is present in package.json dependencies.",
        confidence: 0.45
    });
}
async function findLauncherActivity(manifestPath, manifestPackage, javaRoot) {
    if (!(await pathExists(manifestPath))) {
        return null;
    }
    const manifest = await fs.readFile(manifestPath, "utf-8");
    const activityBlocks = manifest.match(/<activity[\s\S]*?<\/activity>/g) ?? [];
    for (const block of activityBlocks) {
        if (!block.includes("android.intent.action.MAIN") || !block.includes("android.intent.category.LAUNCHER")) {
            continue;
        }
        const nameMatch = block.match(/android:name=\"([^\"]+)\"/);
        if (!nameMatch) {
            continue;
        }
        const manifestName = nameMatch[1];
        const fqcn = resolveActivityClass(manifestName, manifestPackage);
        const found = await locateJavaOrKotlinFile(javaRoot, fqcn);
        if (found) {
            return { filePath: found, manifestName };
        }
    }
    return null;
}
function resolveActivityClass(name, manifestPackage) {
    if (name.startsWith(".")) {
        return `${manifestPackage ?? ""}${name}`;
    }
    if (name.includes(".")) {
        return name;
    }
    return `${manifestPackage ?? ""}.${name}`;
}
async function locateJavaOrKotlinFile(javaRoot, fqcn) {
    const pathSegments = fqcn.split(".");
    const className = pathSegments.pop() ?? "";
    const packagePath = pathSegments.join(path.sep);
    const javaPath = path.join(javaRoot, packagePath, `${className}.java`);
    const kotlinPath = path.join(javaRoot, packagePath, `${className}.kt`);
    if (await pathExists(javaPath))
        return javaPath;
    if (await pathExists(kotlinPath))
        return kotlinPath;
    const candidates = await walkFiles(javaRoot, [".java", ".kt"]);
    for (const file of candidates) {
        if (file.endsWith(`${className}.java`) || file.endsWith(`${className}.kt`)) {
            return file;
        }
    }
    return null;
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
