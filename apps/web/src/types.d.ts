import { Change, IntegrationOptions, IntegrationPlan } from "@smartech/shared";

type ApplyIntegrationPayload = {
  changes: Change[];
  selectedChangeIds?: string[] | null;
  options?: IntegrationOptions;
};

type ApplyIntegrationResult = {
  results: { changeId: string; applied: boolean; message: string }[];
  retryResults: { changeId: string; applied: boolean; message: string }[];
  remaining: string[];
  remainingChanges: {
    id: string;
    title: string;
    summary: string;
    filePath: string;
    manualSnippet?: string;
    module?: string;
  }[];
};

declare global {
  interface Window {
    smartech?: {
      isDesktop?: boolean;
      selectProjectDir: () => Promise<string | null>;
      planIntegration: (options: IntegrationOptions) => Promise<IntegrationPlan>;
      applyIntegration: (payload: ApplyIntegrationPayload) => Promise<ApplyIntegrationResult>;
    };
  }
}

export {};
