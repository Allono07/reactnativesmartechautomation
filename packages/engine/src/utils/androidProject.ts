import path from "node:path";
import { pathExists } from "./fs.js";

export type AndroidProjectLayout = {
  style: "native" | "react-native";
  rootDir: string;
  appDir: string;
  appBuildGradle: string;
  appBuildGradleKts: string;
  rootBuildGradle: string;
  rootBuildGradleKts: string;
  settingsGradle: string;
  settingsGradleKts: string;
  manifestPath: string;
  mainDir: string;
  resXmlDir: string;
};

type LayoutCandidate = AndroidProjectLayout & {
  score: number;
};

function buildLayout(rootPath: string, style: "native" | "react-native"): AndroidProjectLayout {
  const rootDir = style === "react-native" ? path.join(rootPath, "android") : rootPath;
  const appDir = style === "react-native" ? path.join(rootDir, "app") : path.join(rootPath, "app");
  const mainDir = path.join(appDir, "src", "main");

  return {
    style,
    rootDir,
    appDir,
    appBuildGradle: path.join(appDir, "build.gradle"),
    appBuildGradleKts: path.join(appDir, "build.gradle.kts"),
    rootBuildGradle: path.join(rootDir, "build.gradle"),
    rootBuildGradleKts: path.join(rootDir, "build.gradle.kts"),
    settingsGradle: path.join(rootDir, "settings.gradle"),
    settingsGradleKts: path.join(rootDir, "settings.gradle.kts"),
    manifestPath: path.join(mainDir, "AndroidManifest.xml"),
    mainDir,
    resXmlDir: path.join(mainDir, "res", "xml")
  };
}

async function scoreLayout(layout: AndroidProjectLayout): Promise<number> {
  let score = 0;

  if (await pathExists(layout.rootDir)) score += 1;
  if (await pathExists(layout.appDir)) score += 1;
  if (await pathExists(layout.manifestPath)) score += 4;
  if ((await pathExists(layout.appBuildGradle)) || (await pathExists(layout.appBuildGradleKts))) score += 3;
  if (
    (await pathExists(layout.settingsGradle)) ||
    (await pathExists(layout.settingsGradleKts)) ||
    (await pathExists(layout.rootBuildGradle)) ||
    (await pathExists(layout.rootBuildGradleKts))
  ) {
    score += 2;
  }

  return score;
}

export async function resolveAndroidProjectLayout(
  rootPath: string,
  preferredStyle: "native" | "react-native" = "native"
): Promise<AndroidProjectLayout> {
  const nativeLayout = buildLayout(rootPath, "native");
  const reactNativeLayout = buildLayout(rootPath, "react-native");

  const candidates: LayoutCandidate[] = [
    { ...nativeLayout, score: await scoreLayout(nativeLayout) },
    { ...reactNativeLayout, score: await scoreLayout(reactNativeLayout) }
  ];

  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0].score > candidates[1].score) {
    const { score: _score, ...layout } = candidates[0];
    return layout;
  }

  const preferred = candidates.find((candidate) => candidate.style === preferredStyle) ?? candidates[0];
  const { score: _score, ...layout } = preferred;
  return layout;
}
