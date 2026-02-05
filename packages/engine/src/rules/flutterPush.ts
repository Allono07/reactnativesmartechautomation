import path from "node:path";
import { promises as fs } from "node:fs";
import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
import { pathExists } from "../utils/fs.js";
import { createUnifiedDiff } from "../utils/diff.js";

const ANDROID_SRC = path.join("android", "app", "src", "main");
const JAVA_SRC = path.join(ANDROID_SRC, "java");
const KOTLIN_SRC = path.join(ANDROID_SRC, "kotlin");
const MANIFEST_RELATIVE = path.join(ANDROID_SRC, "AndroidManifest.xml");
const GRADLE_PROPERTIES_RELATIVE = path.join("android", "gradle.properties");
const APP_BUILD_GRADLE = path.join("android", "app", "build.gradle");
const APP_BUILD_GRADLE_KTS = path.join("android", "app", "build.gradle.kts");

const DEFAULT_FLUTTER_PUSH_VERSION = "^3.5.0";
const DEFAULT_ANDROID_PUSH_VERSION = "3.5.13";

const PUSH_DEP_GROOVY = "api \"com.netcore.android:smartech-push:${SMARTECH_PUSH_SDK_VERSION}\"";
const PUSH_DEP_KTS = "api(\"com.netcore.android:smartech-push:${SMARTECH_PUSH_SDK_VERSION}\")";

// const SMARTECH_BASE_IMPORT = "com.netcore.android.smartech_flutter.SmartechBasePlugin";
const SMARTECH_PUSH_IMPORT = "com.netcore.android.smartech_push.SmartechPushPlugin";

type FlutterPushContext = {
  scan: ProjectScan;
  rootPath: string;
  inputs?: IntegrationOptions["inputs"];
};

export async function runFlutterPushRules(context: FlutterPushContext): Promise<Change[]> {
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
      id: "flutter-push-android-no-src",
      title: "Android source root not found",
      filePath: androidMain,
      kind: "insert",
      patch: "",
      summary: "Expected android/app/src/main/java or kotlin to exist. Push integration requires Android sources.",
      confidence: 0.2,
      module: "push"
    });
    return changes;
  }

  const flutterPushVersion = context.inputs?.flutterPushSdkVersion ?? DEFAULT_FLUTTER_PUSH_VERSION;
  const androidPushVersion = context.inputs?.pushSdkVersion ?? DEFAULT_ANDROID_PUSH_VERSION;
  const mainDartPath = context.inputs?.mainDartPath ?? path.join(rootPath, "lib", "main.dart");

  const gradlePropChange = await ensureGradleProperty(rootPath, androidPushVersion);
  if (gradlePropChange) changes.push(gradlePropChange);

  const depChange = await ensurePushDependency(rootPath);
  if (depChange) changes.push(depChange);

  const pubspecChange = await ensurePubspecDependency(rootPath, flutterPushVersion);
  if (pubspecChange) changes.push(pubspecChange);

  const appClass = await findFlutterApplicationClass(sourceRoots);
  if (appClass) {
    const initChange = await ensurePushPluginInit(appClass.filePath);
    if (initChange) changes.push(initChange);
  } else {
    changes.push({
      id: "flutter-push-app-missing",
      title: "Application class not found",
      filePath: androidMain,
      kind: "insert",
      patch: "",
      summary: "Push plugin init requires an Application/FlutterApplication class. Integrate Base SDK first.",
      confidence: 0.2,
      module: "push"
    });
  }

  const autoAskPermission = context.inputs?.autoAskNotificationPermission;
  if (typeof autoAskPermission === "boolean") {
    const metaChange = await ensureManifestFlagMeta(
      manifestPath,
      "SMT_IS_AUTO_ASK_NOTIFICATION_PERMISSION",
      autoAskPermission ? "1" : "0"
    );
    if (metaChange) changes.push(metaChange);
  }

  const mainDartChange = await ensureMainDartPush(mainDartPath);
  if (mainDartChange) changes.push(mainDartChange);

  return changes;
}

function buildChange(input: Omit<Change, "patch">): Change {
  const patch = createUnifiedDiff(input.filePath, input.originalContent ?? "", input.newContent ?? "");
  return { module: "push", ...input, patch };
}

async function ensureGradleProperty(rootPath: string, version: string): Promise<Change | null> {
  const filePath = path.join(rootPath, GRADLE_PROPERTIES_RELATIVE);
  if (!(await pathExists(filePath))) return null;

  const originalContent = await fs.readFile(filePath, "utf-8");
  let newContent = originalContent;

  if (/SMARTECH_PUSH_SDK_VERSION\s*=/.test(originalContent)) {
    newContent = originalContent.replace(
      /SMARTECH_PUSH_SDK_VERSION\s*=\s*[^\n]+/,
      `SMARTECH_PUSH_SDK_VERSION=${version}`
    );
  } else {
    newContent = `${originalContent.trimEnd()}\nSMARTECH_PUSH_SDK_VERSION=${version}\n`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-gradle-properties-smartech-push",
    title: "Add Smartech Push SDK version to gradle.properties",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add or update SMARTECH_PUSH_SDK_VERSION in gradle.properties.",
    confidence: 0.4
  });
}

async function ensurePushDependency(rootPath: string): Promise<Change | null> {
  const groovyPath = path.join(rootPath, APP_BUILD_GRADLE);
  const kotlinPath = path.join(rootPath, APP_BUILD_GRADLE_KTS);
  const filePath = (await pathExists(kotlinPath)) ? kotlinPath : groovyPath;
  if (!(await pathExists(filePath))) return null;

  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kts");
  const depLine = isKotlin ? PUSH_DEP_KTS : PUSH_DEP_GROOVY;

  let newContent = originalContent;
  if (originalContent.includes("com.netcore.android:smartech-push")) {
    newContent = originalContent.replace(
      /(api|implementation)\s*(\(|\s+)['\"]com\.netcore\.android:smartech-push:[^'\")]+['\"]\)?/,
      depLine
    );
  } else if (/dependencies\s*\{/.test(originalContent)) {
    newContent = originalContent.replace(/dependencies\s*\{/, (match) => `${match}\n    ${depLine}`);
  } else {
    newContent = `${originalContent}\n\ndependencies {\n    ${depLine}\n}`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-add-smartech-push-dependency",
    title: "Add Smartech Push dependency",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add or update Smartech Push dependency in app build.gradle(.kts).",
    confidence: 0.4
  });
}

async function ensurePubspecDependency(rootPath: string, version: string): Promise<Change | null> {
  const filePath = path.join(rootPath, "pubspec.yaml");
  if (!(await pathExists(filePath))) return null;

  const originalContent = await fs.readFile(filePath, "utf-8");
  if (/smartech_push\s*:/.test(originalContent)) {
    const newContent = originalContent.replace(
      /smartech_push\s*:\s*[^\n]+/,
      `smartech_push: ${version}`
    );
    if (newContent === originalContent) return null;
    return buildChange({
      id: "flutter-pubspec-smartech-push",
      title: "Update smartech_push dependency",
      filePath,
      kind: "update",
      originalContent,
      newContent,
      summary: "Update smartech_push dependency in pubspec.yaml.",
      confidence: 0.4
    });
  }

  const lines = originalContent.split("\n");
  const depIndex = lines.findIndex((line) => /^dependencies:\s*$/.test(line));
  if (depIndex === -1) return null;

  const indent = "  ";
  lines.splice(depIndex + 1, 0, `${indent}smartech_push: ${version}`);
  const newContent = lines.join("\n");

  return buildChange({
    id: "flutter-pubspec-smartech-push",
    title: "Add smartech_push dependency",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add smartech_push dependency to pubspec.yaml.",
    confidence: 0.4
  });
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

async function ensurePushPluginInit(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kt");
  const baseLine = isKotlin
    ? "SmartechBasePlugin.initializePlugin(this)"
    : "SmartechBasePlugin.initializePlugin(this);";
  const pushLine = isKotlin
    ? "SmartechPushPlugin.initializePlugin(this)"
    : "SmartechPushPlugin.initializePlugin(this);";
  const importLine = isKotlin
    ? `import ${SMARTECH_PUSH_IMPORT}`
    : `import ${SMARTECH_PUSH_IMPORT};`;
  // const baseImportLine = isKotlin
    // ? `import ${SMARTECH_BASE_IMPORT}`
    // : `import ${SMARTECH_BASE_IMPORT};`;

  let newContent = originalContent;

  // if (!newContent.includes(baseImportLine)) {
  //   newContent = newContent.replace(/(package\s+[^\n]+\n)/, `$1${baseImportLine}\n`);
  // }
  if (!newContent.includes(importLine)) {
    newContent = newContent.replace(/(package\s+[^\n]+\n)/, `$1${importLine}\n`);
  }

  if (newContent.includes(pushLine)) {
    return null;
  }

  if (!newContent.includes(baseLine)) {
    return buildChange({
      id: "flutter-push-app-base-missing",
      title: "Base SDK init not found",
      filePath,
      kind: "insert",
      originalContent,
      newContent: originalContent,
      summary: "SmartechBasePlugin.initializePlugin not found. Integrate Base SDK first.",
      confidence: 0.2
    });
  }

  newContent = newContent.replace(baseLine, `${baseLine}\n        ${pushLine}`);

  if (newContent === originalContent) return null;

  return buildChange({
    id: "flutter-application-push-init",
    title: "Initialize Smartech Push plugin",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add SmartechPushPlugin initialization after Base plugin init.",
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

async function ensureMainDartPush(filePath: string): Promise<Change | null> {
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

  newContent = ensureDartImports(newContent, [
    "package:firebase_core/firebase_core.dart",
    "package:firebase_messaging/firebase_messaging.dart",
    "package:smartech_push/smartech_push.dart",
    "package:smartech_base/smartech_base.dart"
  ]);

  newContent = ensureBackgroundHandler(newContent);
  newContent = ensureMainRegistration(newContent);

  const stateChange = ensureStatefulPushSetup(newContent);
  if (stateChange.updated) {
    newContent = stateChange.content;
  }

  if (newContent === originalContent) {
    const missingSignals =
      !originalContent.includes("_registerPushToken") ||
      !originalContent.includes("FirebaseMessaging.onMessage") ||
      !originalContent.includes("onHandleDeeplink");
    if (missingSignals) {
      return buildChange({
        id: "flutter-main-dart-stateful-missing",
        title: "Stateful widget not found",
        filePath,
        kind: "insert",
        originalContent,
        newContent: originalContent,
        summary:
          "Could not locate a StatefulWidget State class to inject initState push setup. Add push hooks manually.",
        confidence: 0.2
      });
    }
    return null;
  }

  return buildChange({
    id: "flutter-main-dart-push",
    title: "Add Smartech Push setup in main.dart",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Inject Smartech Push token registration, handlers, and deeplink callback.",
    confidence: 0.35
  });
}

function ensureDartImports(source: string, imports: string[]): string {
  let updated = source;
  const missing = imports.filter((imp) => !updated.includes(`import '${imp}';`));
  if (missing.length === 0) return updated;

  const importBlock = missing.map((imp) => `import '${imp}';`).join("\n");
  const lastImportMatch = [...updated.matchAll(/import\s+['"][^'"]+['"];\n/g)].pop();
  if (lastImportMatch) {
    const index = lastImportMatch.index ?? 0;
    const end = index + lastImportMatch[0].length;
    updated = `${updated.slice(0, end)}${importBlock}\n${updated.slice(end)}`;
  } else {
    updated = `${importBlock}\n\n${updated}`;
  }
  return updated;
}

function ensureBackgroundHandler(source: string): string {
  if (source.includes("firebaseMessagingBackgroundHandler")) return source;

  const handlerBlock = `@pragma('vm:entry-point')\nFuture<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {\n  await Firebase.initializeApp();\n\n  bool isFromSmt =\n      await SmartechPush().isNotificationFromSmartech(message.data.toString());\n\n  if (isFromSmt) {\n    SmartechPush().handlePushNotification(message.data.toString());\n    return;\n  }\n\n  // Handle non-Smartech notification\n}\n\n`;

  const lastImportMatch = [...source.matchAll(/import\s+['"][^'"]+['"];\n/g)].pop();
  if (lastImportMatch) {
    const index = lastImportMatch.index ?? 0;
    const end = index + lastImportMatch[0].length;
    return `${source.slice(0, end)}\n${handlerBlock}${source.slice(end)}`;
  }

  return `${handlerBlock}${source}`;
}

function ensureMainRegistration(source: string): string {
  const mainMatch = source.match(/(Future<void>\s+main\(\)\s*(async\s*)?\{|void\s+main\(\)\s*(async\s*)?\{)/);
  if (!mainMatch) return source;

  const mainStart = mainMatch.index ?? 0;
  const braceIndex = source.indexOf("{", mainStart);
  if (braceIndex === -1) return source;

  if (source.includes("FirebaseMessaging.onBackgroundMessage")) return source;

  const insertLine = "  FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);";
  return `${source.slice(0, braceIndex + 1)}\n${insertLine}\n${source.slice(braceIndex + 1)}`;
}

function ensureStatefulPushSetup(source: string): { updated: boolean; content: string } {
  const classMatch = source.match(/class\s+\w+\s+extends\s+State<[^>]+>\s*\{/);
  if (!classMatch || classMatch.index === undefined) {
    return { updated: false, content: source };
  }

  const classStart = classMatch.index;
  const bodyStart = source.indexOf("{", classStart);
  if (bodyStart === -1) return { updated: false, content: source };

  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) {
      bodyEnd = i;
      break;
    }
  }
  if (bodyEnd === -1) return { updated: false, content: source };

  const before = source.slice(0, bodyStart + 1);
  const body = source.slice(bodyStart + 1, bodyEnd);
  const after = source.slice(bodyEnd);

  let updatedBody = body;
  const hasRegisterMethod = /_registerPushToken\s*\(/.test(body);
  const hasInitState = /initState\s*\(\s*\)/.test(body);
  const hasOnMessage = /FirebaseMessaging\.onMessage/.test(body);
  const hasDeeplink = /onHandleDeeplink/.test(body);

  const initLines: string[] = [];
  if (!hasRegisterMethod) {
    initLines.push("    _registerPushToken();");
  }
  if (!hasOnMessage) {
    initLines.push(
      "    FirebaseMessaging.onMessage.listen((RemoteMessage message) async {",
      "      bool isFromSmt =",
      "          await SmartechPush().isNotificationFromSmartech(message.data.toString());",
      "",
      "      if (isFromSmt) {",
      "        SmartechPush().handlePushNotification(message.data.toString());",
      "        return;",
      "      }",
      "",
      "      // Handle non-Smartech notification",
      "    });"
    );
  }
  if (!hasDeeplink) {
    initLines.push(
      "    Smartech().onHandleDeeplink((",
      "      String? smtDeeplinkSource,",
      "      String? smtDeeplink,",
      "      Map<dynamic, dynamic>? smtPayload,",
      "      Map<dynamic, dynamic>? smtCustomPayload,",
      "    ) async {",
      "      // Perform action on notification click",
      "    });"
    );
  }

  if (hasInitState) {
    if (initLines.length > 0) {
      updatedBody = updatedBody.replace(
        /super\.initState\s*\(\s*\);\s*/g,
        (match) => `${match}\n${initLines.join("\n")}\n`
      );
    }
  } else {
    if (initLines.length > 0) {
      const initBlock = `\n  @override\n  void initState() {\n    super.initState();\n${initLines.join(
        "\n"
      )}\n  }\n`;
      updatedBody = `${initBlock}${updatedBody}`;
    }
  }

  if (!hasRegisterMethod) {
    const methodBlock = `\n  Future<void> _registerPushToken() async {\n    final androidToken = await FirebaseMessaging.instance.getToken();\n    if (androidToken != null) {\n      SmartechPush().setDevicePushToken(androidToken);\n    }\n  }\n`;
    updatedBody = `${updatedBody}${methodBlock}`;
  }

  const updated = `${before}${updatedBody}${after}`;
  return { updated: updated !== source, content: updated };
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
