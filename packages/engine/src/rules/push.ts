import path from "node:path";
import { promises as fs } from "node:fs";
import type { Change, ProjectScan, IntegrationOptions } from "@smartech/shared";
import { pathExists } from "../utils/fs.js";
import { createUnifiedDiff } from "../utils/diff.js";

const GRADLE_PROPERTIES_RELATIVE = path.join("android", "gradle.properties");
const APP_BUILD_GRADLE = path.join("android", "app", "build.gradle");
const APP_BUILD_GRADLE_KTS = path.join("android", "app", "build.gradle.kts");

const DEFAULT_PUSH_SDK_VERSION = "3.5.13";
const DEFAULT_RN_PUSH_VERSION = "^3.7.2";
const DEFAULT_FIREBASE_VERSION = "^18.6.0";

const RN_PUSH_LIB = "smartech-push-react-native";
const RN_BASE_LIB = "smartech-base-react-native";
const FIREBASE_APP = "@react-native-firebase/app";
const FIREBASE_MESSAGING = "@react-native-firebase/messaging";

const PUSH_DEP_GROOVY = "implementation 'com.netcore.android:smartech-push:${SMARTECH_PUSH_SDK_VERSION}'";
const PUSH_DEP_KTS =
  "implementation(\"com.netcore.android:smartech-push:\" + project.property(\"SMARTECH_PUSH_SDK_VERSION\"))";

const PUSH_IMPORTS = [
  "import messaging from '@react-native-firebase/messaging';",
  "import SmartechPushReact from 'smartech-push-react-native';",
  "import SmartechReact from 'smartech-base-react-native';"
];

const PUSH_TOKEN_FUNC = `const getFCMToken = async () => {\n  try {\n    const token = await messaging().getToken();\n    SmartechPushReact.setDevicePushToken(token);\n  } catch (e) {\n    console.log(error);\n  }\n};`;

const DEEPLINK_HANDLER = `const handleDeeplinkWithPayload = (smartechData) => {\n  console.log('Smartech Data :: ', smartechData);\n  console.log('Smartech Deeplink :: ', smartechData.smtDeeplink);\n  console.log('Smartech CustomPayload:: ', smartechData.smtCustomPayload);\n  // Handle the deeplink and custom payload as needed\n};`;

const FOREGROUND_HANDLER = `// For foreground state\nconst unsubscribe = messaging().onMessage(async remoteMessage => {\n  SmartechPushReact.handlePushNotification(remoteMessage.data, (result) => {\n    console.log('isNotificationHandled by smartech :: ', result);\n    // if result is false then notification is from other sources\n    //also check if this listener is used anywhere else in the app\n  });\n});`;

const BACKGROUND_HANDLER = `// For background/terminated state\nmessaging().setBackgroundMessageHandler(async remoteMessage => {\n  SmartechPushReact.handlePushNotification(remoteMessage.data, (result) => {\n    console.log('isNotificationHandled by smartech :: ', result);\n    // if result is false then notification is from other sources\n  });\n});`;

const RN_PUSH_MANUAL_SNIPPET = `import messaging from '@react-native-firebase/messaging';
import SmartechPushReact from 'smartech-push-react-native';
import SmartechReact from 'smartech-base-react-native';

useEffect(() => {
  const getFCMToken = async () => {
    try {
      const token = await messaging().getToken();
      SmartechPushReact.setDevicePushToken(token);
    } catch (e) {
      console.log(error);
    }
  };

  const handleDeeplinkWithPayload = (smartechData) => {
    console.log('Smartech Data :: ', smartechData);
    console.log('Smartech Deeplink :: ', smartechData.smtDeeplink);
    console.log('Smartech CustomPayload:: ', smartechData.smtCustomPayload);
    // Handle the deeplink and custom payload as needed
  };

  getFCMToken();
  SmartechReact.addListener(SmartechReact.SmartechDeeplink, handleDeeplinkWithPayload);

  // For foreground state
  const unsubscribe = messaging().onMessage(async remoteMessage => {
    SmartechPushReact.handlePushNotification(remoteMessage.data, (result) => {
      console.log('isNotificationHandled by smartech :: ', result);
      // if result is false then notification is from other sources
      //also check if this listener is used anywhere else in the app
    });
  });

  return () => {
    SmartechReact.removeListener(SmartechReact.SmartechDeeplink);
    unsubscribe();
  };
}, []);
`;

const RN_PUSH_BACKGROUND_MANUAL_SNIPPET = `import messaging from '@react-native-firebase/messaging';
import SmartechPushReact from 'smartech-push-react-native';

// For background/terminated state
messaging().setBackgroundMessageHandler(async remoteMessage => {
  SmartechPushReact.handlePushNotification(remoteMessage.data, (result) => {
    console.log('isNotificationHandled by smartech :: ', result);
    // if result is false then notification is from other sources
  });
});
`;

type PushRuleContext = {
  scan: ProjectScan;
  rootPath: string;
  inputs?: IntegrationOptions["inputs"];
};

export async function runPushRules(context: PushRuleContext): Promise<Change[]> {
  const changes: Change[] = [];
  if (!context.scan.platforms.includes("android")) {
    return changes;
  }

  const pushSdkVersion = context.inputs?.pushSdkVersion ?? DEFAULT_PUSH_SDK_VERSION;
  const rnPushVersion = context.inputs?.rnPushVersion ?? DEFAULT_RN_PUSH_VERSION;
  const firebaseVersion = context.inputs?.firebaseVersion ?? DEFAULT_FIREBASE_VERSION;

  const gradlePropChange = await ensureGradleProperty(context.rootPath, pushSdkVersion);
  if (gradlePropChange) changes.push(gradlePropChange);

  const dependencyChange = await ensurePushDependency(context.rootPath);
  if (dependencyChange) changes.push(dependencyChange);

  const rnDependencyChange = await ensureReactNativePushDependencies(
    context.rootPath,
    rnPushVersion,
    firebaseVersion
  );
  if (rnDependencyChange) changes.push(rnDependencyChange);

  const appFile = await findAppEntryFile(context.rootPath);
  if (appFile) {
    const appChange = await ensureAppPushLogic(appFile);
    if (appChange) changes.push(appChange);
  } else {
    changes.push({
      id: "rn-app-push-manual",
      title: "Push hooks not injected",
      filePath: path.join(context.rootPath, "App.js"),
      kind: "insert",
      patch: "",
      summary:
        "App entry file not found. Add push token, deeplink listener, and foreground handler manually.",
      confidence: 0.2,
      manualSnippet: RN_PUSH_MANUAL_SNIPPET,
      module: "push"
    });
  }

  const indexFile = await findIndexFile(context.rootPath);
  if (indexFile) {
    const indexChange = await ensureIndexPushLogic(indexFile);
    if (indexChange) changes.push(indexChange);
  } else {
    changes.push({
      id: "rn-index-push-manual",
      title: "Background push handler not injected",
      filePath: path.join(context.rootPath, "index.js"),
      kind: "insert",
      patch: "",
      summary: "Index entry file not found. Add background push handler manually.",
      confidence: 0.2,
      manualSnippet: RN_PUSH_BACKGROUND_MANUAL_SNIPPET,
      module: "push"
    });
  }

  const manifestPath = path.join(
    context.rootPath,
    "android",
    "app",
    "src",
    "main",
    "AndroidManifest.xml"
  );
  const autoAsk = context.inputs?.autoAskNotificationPermission;
  if (typeof autoAsk === "boolean") {
    const metaChange = await ensureManifestFlagMeta(
      manifestPath,
      "SMT_IS_AUTO_ASK_NOTIFICATION_PERMISSION",
      autoAsk ? "1" : "0"
    );
    if (metaChange) changes.push(metaChange);
  }

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
    id: "android-gradle-properties-smartech-push",
    title: "Add Smartech push SDK version to gradle.properties",
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
    newContent = originalContent
      .replace(/[A-Za-z_]+\s*\([^\n]*com\.netcore\.android:smartech-push[^\n]*\)/, depLine)
      .replace(
        /implementation\s*(\(|\s+)['\"]com\.netcore\.android:smartech-push:[^'\")]+['\"]\)?/,
        depLine
      );
  } else if (/dependencies\s*\{/.test(originalContent)) {
    newContent = originalContent.replace(/dependencies\s*\{/, (match) => `${match}\n    ${depLine}`);
  } else {
    newContent = `${originalContent}\n\ndependencies {\n    ${depLine}\n}`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "android-add-smartech-push-dependency",
    title: "Add Smartech push SDK dependency",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add or update Smartech push SDK dependency in app build.gradle(.kts).",
    confidence: 0.4
  });
}

async function ensureReactNativePushDependencies(
  rootPath: string,
  rnPushVersion: string,
  firebaseVersion: string
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
  const devDependencies = parsed.devDependencies ?? {};

  const nextDependencies = { ...dependencies };

  if (!nextDependencies[RN_PUSH_LIB] || nextDependencies[RN_PUSH_LIB] !== rnPushVersion) {
    nextDependencies[RN_PUSH_LIB] = rnPushVersion;
  }

  if (!nextDependencies[RN_BASE_LIB] && devDependencies[RN_BASE_LIB]) {
    nextDependencies[RN_BASE_LIB] = devDependencies[RN_BASE_LIB];
  }

  if (!nextDependencies[FIREBASE_APP]) nextDependencies[FIREBASE_APP] = firebaseVersion;
  if (!nextDependencies[FIREBASE_MESSAGING]) nextDependencies[FIREBASE_MESSAGING] = firebaseVersion;

  const nextParsed = { ...parsed, dependencies: nextDependencies };
  const newContent = JSON.stringify(nextParsed, null, 2) + "\n";

  if (newContent === originalContent) return null;

  return buildChange({
    id: "rn-add-smartech-push",
    title: "Add Smartech push React Native dependencies",
    filePath,
    kind: "update",
    originalContent,
    newContent,
    summary: "Ensure smartech-push-react-native and Firebase deps are present.",
    confidence: 0.45
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

async function findIndexFile(rootPath: string): Promise<string | null> {
  const candidates = [
    path.join(rootPath, "index.tsx"),
    path.join(rootPath, "index.js")
  ];

  for (const file of candidates) {
    if (await pathExists(file)) return file;
  }

  return null;
}

async function ensureAppPushLogic(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  let newContent = originalContent;

  newContent = ensureImports(newContent, PUSH_IMPORTS);
  newContent = ensureReactUseEffectImport(newContent);

  const needsToken = !/setDevicePushToken/.test(newContent);
  const needsDeeplink = !/SmartechReact\.SmartechDeeplink/.test(newContent);
  const needsForeground = !/handlePushNotification\(/.test(newContent);

  if (!needsToken && !needsDeeplink && !needsForeground) {
    return null;
  }

  const block = buildUseEffectBlock(needsToken, needsDeeplink, needsForeground);

  if (/return\s*\(/.test(newContent)) {
    newContent = newContent.replace(/return\s*\(/, `${block}\n\n  return (`);
  } else {
    newContent = `${newContent}\n\n${block}`;
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "rn-app-push-logic",
    title: "Add Smartech push logic to App",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Inject useEffect with token handling, deeplink listener, and foreground push handler.",
    confidence: 0.35
  });
}

async function ensureIndexPushLogic(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  let newContent = originalContent;

  newContent = ensureImports(newContent, [
    "import messaging from '@react-native-firebase/messaging';",
    "import SmartechPushReact from 'smartech-push-react-native';"
  ]);

  if (/setBackgroundMessageHandler/.test(newContent) && /handlePushNotification/.test(newContent)) {
    return null;
  }

  newContent = `${newContent.trimEnd()}\n\n${BACKGROUND_HANDLER}\n`;

  if (newContent === originalContent) return null;

  return buildChange({
    id: "rn-index-push-logic",
    title: "Add Smartech push background handler",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add messaging().setBackgroundMessageHandler to index entry.",
    confidence: 0.35
  });
}

function ensureImports(source: string, imports: string[]): string {
  let updated = source;
  for (const imp of imports) {
    if (!updated.includes(imp)) {
      updated = `${imp}\n${updated}`;
    }
  }
  return updated;
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

function buildUseEffectBlock(
  needsToken: boolean,
  needsDeeplink: boolean,
  needsForeground: boolean
): string {
  const lines: string[] = ["useEffect(() => {"];

  if (needsToken) {
    lines.push(`  ${PUSH_TOKEN_FUNC}`);
    lines.push("  getFCMToken();");
    lines.push("");
  }

  if (needsDeeplink) {
    lines.push(`  ${DEEPLINK_HANDLER}`);
    lines.push("");
    lines.push("  SmartechReact.addListener(SmartechReact.SmartechDeeplink, handleDeeplinkWithPayload);");
    lines.push("");
  }

  if (needsForeground) {
    lines.push(`  ${FOREGROUND_HANDLER}`);
    lines.push("");
  }

  lines.push("  return () => {");
  if (needsDeeplink) {
    lines.push("    SmartechReact.removeListener(SmartechReact.SmartechDeeplink);");
  }
  if (needsForeground) {
    lines.push("    unsubscribe();");
  }
  lines.push("  };");
  lines.push("}, []);");
  return lines.join("\n");
}

async function ensureManifestFlagMeta(
  manifestPath: string,
  name: string,
  value: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath))) {
    return null;
  }

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
