import path from "node:path";
import { promises as fs } from "node:fs";
import type { Change, IntegrationOptions, ProjectScan } from "@smartech/shared";
import { pathExists } from "../utils/fs.js";
import { createUnifiedDiff } from "../utils/diff.js";
import { resolveAndroidProjectLayout, type AndroidProjectLayout } from "../utils/androidProject.js";

const DEFAULT_PUSH_SDK_VERSION = "3.5.13";

type NativePushContext = {
  scan: ProjectScan;
  rootPath: string;
  inputs?: IntegrationOptions["inputs"];
};

type MethodMatch = {
  signatureStart: number;
  openBraceIndex: number;
  closeBraceIndex: number;
  params: string;
};

export async function runNativePushRules(context: NativePushContext): Promise<Change[]> {
  const changes: Change[] = [];

  const rootPath = context.rootPath;
  const androidLayout = await resolveAndroidProjectLayout(rootPath, "native");
  const manifestPath = androidLayout.manifestPath;
  const inputs = context.inputs ?? {};
  const pushSdkVersion = inputs.pushSdkVersion ?? DEFAULT_PUSH_SDK_VERSION;

  const dependencyChange = await ensurePushDependency(androidLayout, pushSdkVersion);
  if (dependencyChange) changes.push(dependencyChange);

  const servicePathInput = inputs.firebaseMessagingServicePath?.trim() ?? "";
  const servicePath = servicePathInput ? resolveInputPath(rootPath, servicePathInput) : "";

  if (!servicePathInput || !(await pathExists(servicePath))) {
    changes.push({
      id: "native-push-firebase-service-missing",
      title: "Firebase Messaging service class not found",
      filePath: servicePath || androidLayout.mainDir,
      kind: "insert",
      patch: "",
      summary:
        "Provide a valid Firebase Messaging Service class path to inject onNewToken/onMessageReceived logic.",
      confidence: 0.2,
      module: "push"
    });
    return changes;
  }

  const serviceChange = await ensureFirebaseServiceLogic(servicePath);
  if (serviceChange) changes.push(serviceChange);

  const serviceRegisterChange = await ensureManifestFirebaseService(manifestPath, servicePath);
  if (serviceRegisterChange) changes.push(serviceRegisterChange);

  const conflictWarning = await detectMessagingServiceConflict(manifestPath);
  if (conflictWarning) changes.push(conflictWarning);

  const autoAsk = inputs.autoAskNotificationPermission;
  if (typeof autoAsk === "boolean") {
    const metaChange = await ensureManifestMetaData(
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

function resolveInputPath(rootPath: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.join(rootPath, inputPath);
}

async function ensurePushDependency(
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
    ? `implementation(\"com.netcore.android:smartech-push:${version}\")`
    : `implementation 'com.netcore.android:smartech-push:${version}'`;

  let newContent = originalContent;
  if (isKotlin) {
    if (/implementation\s*\(\s*["']com\.netcore\.android:smartech-push:[^"']+["']\s*\)/.test(originalContent)) {
      newContent = originalContent.replace(
        /implementation\s*\(\s*["']com\.netcore\.android:smartech-push:[^"']+["']\s*\)/,
        depLine
      );
    } else if (/dependencies\s*\{/.test(originalContent)) {
      newContent = originalContent.replace(/dependencies\s*\{/, (match) => `${match}\n    ${depLine}`);
    } else {
      newContent = `${originalContent.trimEnd()}\n\ndependencies {\n    ${depLine}\n}\n`;
    }
  } else {
    if (/implementation\s+["']com\.netcore\.android:smartech-push:[^"']+["']/.test(originalContent)) {
      newContent = originalContent.replace(
        /implementation\s+["']com\.netcore\.android:smartech-push:[^"']+["']/,
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
    id: "native-push-dependency",
    title: "Add Smartech Push dependency",
    filePath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Add or update Smartech Push dependency version in app Gradle file.",
    confidence: 0.45
  });
}

async function ensureFirebaseServiceLogic(filePath: string): Promise<Change | null> {
  const originalContent = await fs.readFile(filePath, "utf-8");
  const isKotlin = filePath.endsWith(".kt");

  let updated = originalContent;
  updated = isKotlin
    ? ensureKotlinImports(updated, [
        "java.lang.ref.WeakReference",
        "android.content.Context",
        "com.netcore.android.smartechpush.SmartPush",
        "com.google.firebase.messaging.RemoteMessage"
      ])
    : ensureJavaImports(updated, [
        "java.lang.ref.WeakReference",
        "android.content.Context",
        "com.netcore.android.smartechpush.SmartPush",
        "com.google.firebase.messaging.RemoteMessage"
      ]);

  if (isKotlin) {
    updated = ensureKotlinOnNewToken(updated);
    updated = ensureKotlinOnMessageReceived(updated);
  } else {
    updated = ensureJavaOnNewToken(updated);
    updated = ensureJavaOnMessageReceived(updated);
  }

  if (updated === originalContent) return null;

  return buildChange({
    id: "native-push-firebase-service",
    title: "Inject Smartech push handling in Firebase service",
    filePath,
    kind: "update",
    originalContent,
    newContent: updated,
    summary: "Ensure onNewToken and onMessageReceived forward events to SmartPush without duplication.",
    confidence: 0.5
  });
}

function ensureJavaOnNewToken(source: string): string {
  const method = findMethodBlock(source, /onNewToken\s*\(([^)]*)\)\s*\{/g);
  if (!method) {
    const add = [
      "    @Override",
      "    public void onNewToken(String token) {",
      "        super.onNewToken(token);",
      "",
      "        SmartPush.getInstance(new WeakReference<Context>(this))",
      "                .setDevicePushToken(token);",
      "    }",
      ""
    ].join("\n");
    return insertBeforeClassEnd(source, add);
  }

  const methodText = source.slice(method.signatureStart, method.closeBraceIndex + 1);
  if (/setDevicePushToken\s*\(/.test(methodText)) return source;

  const paramName = extractParamName(method.params, "token");
  const body = source.slice(method.openBraceIndex + 1, method.closeBraceIndex);
  const snippet = [
    `SmartPush.getInstance(new WeakReference<Context>(this))`,
    `        .setDevicePushToken(${paramName});`
  ].join("\n");

  let newBody = body;
  if (/super\.onNewToken\s*\(\s*[^)]*\s*\)\s*;?/.test(body)) {
    newBody = body.replace(
      /super\.onNewToken\s*\(\s*[^)]*\s*\)\s*;?/,
      (match) => `${match}\n\n        ${snippet}`
    );
  } else {
    newBody = `\n        ${snippet}\n${body}`;
  }

  return replaceMethodBody(source, method, newBody);
}

function ensureJavaOnMessageReceived(source: string): string {
  const method = findMethodBlock(source, /onMessageReceived\s*\(([^)]*)\)\s*\{/g);
  if (!method) {
    const add = [
      "    @Override",
      "    public void onMessageReceived(RemoteMessage remoteMessage) {",
      "        super.onMessageReceived(remoteMessage);",
      "",
      "        boolean isPnHandledBySmartech =",
      "                SmartPush.getInstance(new WeakReference<Context>(this))",
      "                        .handleRemotePushNotification(remoteMessage);",
      "",
      "        if (!isPnHandledBySmartech) {",
      "            // Notification from other sources, handle yourself",
      "        }",
      "    }",
      ""
    ].join("\n");
    return insertBeforeClassEnd(source, add);
  }

  const methodText = source.slice(method.signatureStart, method.closeBraceIndex + 1);
  if (/handleRemotePushNotification\s*\(/.test(methodText)) return source;

  const paramName = extractParamName(method.params, "remoteMessage");
  const body = source.slice(method.openBraceIndex + 1, method.closeBraceIndex);
  const superRegex = /super\.onMessageReceived\s*\(\s*[^)]*\s*\)\s*;?/;

  const notificationBlock = [
    "boolean isPnHandledBySmartech =",
    "        SmartPush.getInstance(new WeakReference<Context>(this))",
    `                .handleRemotePushNotification(${paramName});`,
    "",
    "if (!isPnHandledBySmartech) {"
  ];

  let newBody = body;

  if (superRegex.test(body)) {
    const superMatch = body.match(superRegex);
    if (!superMatch) return source;
    const idx = body.indexOf(superMatch[0]) + superMatch[0].length;
    const prefix = body.slice(0, idx);
    const suffix = body.slice(idx).trim();
    const wrapped = suffix
      ? `\n${normalizeInnerCode(suffix, "            ")}\n`
      : "\n            // Notification from other sources, handle yourself\n";

    newBody = `${prefix}\n\n        ${notificationBlock.join("\n        ")}\n${wrapped}        }`;
  } else {
    const existing = body.trim();
    const wrapped = existing
      ? `\n${normalizeInnerCode(existing, "            ")}\n`
      : "\n            // Notification from other sources, handle yourself\n";

    newBody = `\n        ${notificationBlock.join("\n        ")}\n${wrapped}        }`;
  }

  return replaceMethodBody(source, method, newBody);
}

function ensureKotlinOnNewToken(source: string): string {
  const method = findMethodBlock(source, /onNewToken\s*\(([^)]*)\)\s*\{/g);
  if (!method) {
    const add = [
      "    override fun onNewToken(token: String) {",
      "        super.onNewToken(token)",
      "",
      "        SmartPush.getInstance(WeakReference<Context>(this))",
      "            .setDevicePushToken(token)",
      "    }",
      ""
    ].join("\n");
    return insertBeforeClassEnd(source, add);
  }

  const methodText = source.slice(method.signatureStart, method.closeBraceIndex + 1);
  if (/setDevicePushToken\s*\(/.test(methodText)) return source;

  const paramName = extractParamName(method.params, "token");
  const body = source.slice(method.openBraceIndex + 1, method.closeBraceIndex);
  const snippet = [
    "SmartPush.getInstance(WeakReference<Context>(this))",
    `    .setDevicePushToken(${paramName})`
  ].join("\n");

  let newBody = body;
  if (/super\.onNewToken\s*\(\s*[^)]*\s*\)\s*/.test(body)) {
    newBody = body.replace(
      /super\.onNewToken\s*\(\s*[^)]*\s*\)\s*/,
      (match) => `${match}\n\n        ${snippet}\n`
    );
  } else {
    newBody = `\n        ${snippet}\n${body}`;
  }

  return replaceMethodBody(source, method, newBody);
}

function ensureKotlinOnMessageReceived(source: string): string {
  const method = findMethodBlock(source, /onMessageReceived\s*\(([^)]*)\)\s*\{/g);
  if (!method) {
    const add = [
      "    override fun onMessageReceived(remoteMessage: RemoteMessage) {",
      "        super.onMessageReceived(remoteMessage)",
      "",
      "        val isPnHandledBySmartech =",
      "            SmartPush.getInstance(WeakReference<Context>(this))",
      "                .handleRemotePushNotification(remoteMessage)",
      "",
      "        if (!isPnHandledBySmartech) {",
      "            // Notification from other sources, handle yourself",
      "        }",
      "    }",
      ""
    ].join("\n");
    return insertBeforeClassEnd(source, add);
  }

  const methodText = source.slice(method.signatureStart, method.closeBraceIndex + 1);
  if (/handleRemotePushNotification\s*\(/.test(methodText)) return source;

  const paramName = extractParamName(method.params, "remoteMessage");
  const body = source.slice(method.openBraceIndex + 1, method.closeBraceIndex);
  const superRegex = /super\.onMessageReceived\s*\(\s*[^)]*\s*\)\s*/;

  const notificationBlock = [
    "val isPnHandledBySmartech =",
    "    SmartPush.getInstance(WeakReference<Context>(this))",
    `        .handleRemotePushNotification(${paramName})`,
    "",
    "if (!isPnHandledBySmartech) {"
  ];

  let newBody = body;

  if (superRegex.test(body)) {
    const superMatch = body.match(superRegex);
    if (!superMatch) return source;
    const idx = body.indexOf(superMatch[0]) + superMatch[0].length;
    const prefix = body.slice(0, idx);
    const suffix = body.slice(idx).trim();
    const wrapped = suffix
      ? `\n${normalizeInnerCode(suffix, "            ")}\n`
      : "\n            // Notification from other sources, handle yourself\n";

    newBody = `${prefix}\n        ${notificationBlock.join("\n        ")}\n${wrapped}        }`;
  } else {
    const existing = body.trim();
    const wrapped = existing
      ? `\n${normalizeInnerCode(existing, "            ")}\n`
      : "\n            // Notification from other sources, handle yourself\n";

    newBody = `\n        ${notificationBlock.join("\n        ")}\n${wrapped}        }`;
  }

  return replaceMethodBody(source, method, newBody);
}

function normalizeInnerCode(code: string, indent: string): string {
  const lines = code.split("\n");
  let minIndent = Number.MAX_SAFE_INTEGER;
  for (const line of lines) {
    if (!line.trim()) continue;
    const count = line.match(/^\s*/)?.[0].length ?? 0;
    minIndent = Math.min(minIndent, count);
  }
  if (!Number.isFinite(minIndent) || minIndent === Number.MAX_SAFE_INTEGER) {
    minIndent = 0;
  }

  return lines
    .map((line) => {
      if (!line.trim()) return "";
      return indent + line.slice(minIndent);
    })
    .join("\n");
}

function insertBeforeClassEnd(source: string, snippet: string): string {
  const idx = source.lastIndexOf("}");
  if (idx < 0) return source;
  return `${source.slice(0, idx)}\n${snippet}${source.slice(idx)}`;
}

function replaceMethodBody(source: string, method: MethodMatch, newBody: string): string {
  return (
    source.slice(0, method.openBraceIndex + 1) +
    newBody +
    source.slice(method.closeBraceIndex)
  );
}

function findMethodBlock(source: string, pattern: RegExp): MethodMatch | null {
  const regex = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const signatureStart = match.index;
    const openBraceIndex = source.indexOf("{", regex.lastIndex - 1);
    if (openBraceIndex < 0) continue;

    let depth = 0;
    let closeBraceIndex = -1;
    for (let i = openBraceIndex; i < source.length; i += 1) {
      const char = source[i];
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          closeBraceIndex = i;
          break;
        }
      }
    }

    if (closeBraceIndex < 0) continue;

    return {
      signatureStart,
      openBraceIndex,
      closeBraceIndex,
      params: match[1] ?? ""
    };
  }

  return null;
}

function extractParamName(params: string, fallback: string): string {
  const match = params.trim().match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  return match ? match[1] : fallback;
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

async function ensureManifestFirebaseService(
  manifestPath: string,
  serviceFilePath: string
): Promise<Change | null> {
  if (!(await pathExists(manifestPath)) || !(await pathExists(serviceFilePath))) return null;

  const originalContent = await fs.readFile(manifestPath, "utf-8");
  const serviceSource = await fs.readFile(serviceFilePath, "utf-8");

  const manifestPackage = readManifestPackage(originalContent);
  const servicePackage = readPackageName(serviceSource);
  const serviceClassName = path.basename(serviceFilePath, path.extname(serviceFilePath));

  const fqcn = servicePackage ? `${servicePackage}.${serviceClassName}` : serviceClassName;
  const dotName = manifestPackage && servicePackage === manifestPackage ? `.${serviceClassName}` : fqcn;

  const possibleNames = [dotName, fqcn].filter(Boolean);

  let newContent = originalContent;

  const existingServiceRegex = new RegExp(
    `<service[^>]*android:name=\\"(?:${possibleNames.map(escapeRegex).join("|")})\\"[^>]*>[\\s\\S]*?<\\/service>`
  );
  const selfClosingServiceRegex = new RegExp(
    `<service[^>]*android:name=\\"(?:${possibleNames.map(escapeRegex).join("|")})\\"[^>]*/>`
  );

  if (existingServiceRegex.test(newContent)) {
    newContent = newContent.replace(existingServiceRegex, (block) => {
      if (/com\.google\.firebase\.MESSAGING_EVENT/.test(block)) return block;
      return block.replace(
        /<\/service>/,
        `    <intent-filter>\n        <action android:name=\"com.google.firebase.MESSAGING_EVENT\" />\n    </intent-filter>\n</service>`
      );
    });
  } else if (selfClosingServiceRegex.test(newContent)) {
    newContent = newContent.replace(selfClosingServiceRegex, (tag) => {
      const openTag = tag.replace(/\/>$/, ">");
      return `${openTag}\n        <intent-filter>\n            <action android:name=\"com.google.firebase.MESSAGING_EVENT\" />\n        </intent-filter>\n    </service>`;
    });
  } else if (/<application[^>]*>/.test(newContent)) {
    const serviceBlock = `    <service\n        android:exported=\"false\"\n        android:name=\"${dotName}\">\n        <intent-filter>\n            <action android:name=\"com.google.firebase.MESSAGING_EVENT\" />\n        </intent-filter>\n    </service>`;
    newContent = newContent.replace(/<application[^>]*>/, (match) => `${match}\n${serviceBlock}`);
  }

  if (newContent === originalContent) return null;

  return buildChange({
    id: "native-push-manifest-service",
    title: "Register Firebase Messaging service",
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: "Ensure Firebase Messaging service is registered with MESSAGING_EVENT intent-filter.",
    confidence: 0.45
  });
}

async function detectMessagingServiceConflict(manifestPath: string): Promise<Change | null> {
  if (!(await pathExists(manifestPath))) return null;
  const content = await fs.readFile(manifestPath, "utf-8");
  const count = (content.match(/com\.google\.firebase\.MESSAGING_EVENT/g) ?? []).length;
  if (count <= 1) return null;

  return {
    id: "native-push-messaging-service-warning",
    title: "Multiple Firebase messaging services detected",
    filePath: manifestPath,
    kind: "insert",
    patch: "",
    summary:
      "More than one MESSAGING_EVENT service exists. Only one Firebase messaging service is recommended to avoid push conflicts.",
    confidence: 0.25,
    module: "push"
  };
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
    id: `native-push-meta-${name.toLowerCase()}`,
    title: `Set ${name} meta-data`,
    filePath: manifestPath,
    kind: "insert",
    originalContent,
    newContent,
    summary: `Add or update ${name} in AndroidManifest.xml.`,
    confidence: 0.4
  });
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
