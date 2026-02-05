export type IntegrationPart = "base" | "push" | "px";

export type Platform = "android" | "ios";

export type AppPlatform = "react-native" | "flutter";

export type ChangeKind = "create" | "update" | "insert";

export type Change = {
  id: string;
  title: string;
  filePath: string;
  kind: ChangeKind;
  patch: string;
  summary: string;
  confidence: number;
  originalContent?: string;
  newContent?: string;
  module?: IntegrationPart;
};

export type ProjectScan = {
  rootPath: string;
  reactNativeVersion?: string;
  platforms: Platform[];
  notes: string[];
};

export type IntegrationPlan = {
  scan: ProjectScan;
  parts: IntegrationPart[];
  changes: Change[];
};

export type IntegrationOptions = {
  rootPath: string;
  parts: IntegrationPart[];
  dryRun?: boolean;
  appPlatform?: AppPlatform;
  inputs?: {
    smartechAppId?: string;
    deeplinkScheme?: string;
    baseSdkVersion?: string;
    flutterBaseSdkVersion?: string;
    flutterPushSdkVersion?: string;
    mainDartPath?: string;
    pushSdkVersion?: string;
    rnPushVersion?: string;
    firebaseVersion?: string;
    autoAskNotificationPermission?: boolean;
    autoFetchLocation?: boolean;
    pxSdkVersion?: string;
    rnPxVersion?: string;
    hanselAppId?: string;
    hanselAppKey?: string;
    pxScheme?: string;
  };
};
