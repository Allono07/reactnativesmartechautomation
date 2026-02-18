import type { ProjectScan } from "@smartech/shared";
import { pathExists, readJsonIfExists } from "./utils/fs.js";
import path from "node:path";

export async function scanProject(rootPath: string): Promise<ProjectScan> {
  const platforms = [] as ProjectScan["platforms"];
  const notes: string[] = [];

  const androidPath = path.join(rootPath, "android");
  const iosPath = path.join(rootPath, "ios");
  const nativeAndroidAppPath = path.join(rootPath, "app");
  const nativeAndroidManifestPath = path.join(
    rootPath,
    "app",
    "src",
    "main",
    "AndroidManifest.xml"
  );
  const nativeAndroidBuildGradlePath = path.join(rootPath, "build.gradle");
  const nativeAndroidBuildGradleKtsPath = path.join(rootPath, "build.gradle.kts");
  const nativeAndroidSettingsGradlePath = path.join(rootPath, "settings.gradle");
  const nativeAndroidSettingsGradleKtsPath = path.join(rootPath, "settings.gradle.kts");
  const androidModuleManifestPath = path.join(rootPath, "src", "main", "AndroidManifest.xml");
  const androidModuleBuildGradlePath = path.join(rootPath, "build.gradle");
  const androidModuleBuildGradleKtsPath = path.join(rootPath, "build.gradle.kts");

  const hasReactNativeAndroidRoot = await pathExists(androidPath);
  const hasNativeAndroidRoot =
    (await pathExists(nativeAndroidAppPath)) &&
    (await pathExists(nativeAndroidManifestPath)) &&
    ((await pathExists(nativeAndroidBuildGradlePath)) ||
      (await pathExists(nativeAndroidBuildGradleKtsPath)) ||
      (await pathExists(nativeAndroidSettingsGradlePath)) ||
      (await pathExists(nativeAndroidSettingsGradleKtsPath)));
  const hasAndroidModuleRoot =
    (await pathExists(androidModuleManifestPath)) &&
    ((await pathExists(androidModuleBuildGradlePath)) ||
      (await pathExists(androidModuleBuildGradleKtsPath)));

  if (hasReactNativeAndroidRoot || hasNativeAndroidRoot || hasAndroidModuleRoot) {
    platforms.push("android");
  }

  if (await pathExists(iosPath)) {
    platforms.push("ios");
  }

  const packageJson = await readJsonIfExists(path.join(rootPath, "package.json"));
  const reactNativeVersion =
    packageJson?.dependencies?.["react-native"] ??
    packageJson?.devDependencies?.["react-native"];

  if (packageJson && !reactNativeVersion) {
    notes.push("react-native dependency not found in package.json");
  }

  if (platforms.length === 0) {
    notes.push(
      "No Android/iOS project structure detected. Ensure rootPath points to project root (React Native root or Native Android root)."
    );
  }

  return {
    rootPath,
    reactNativeVersion,
    platforms,
    notes
  };
}
