import { IntegrationOptions, IntegrationPlan } from "@smartech/shared";

declare global {
  interface Window {
    smartech: {
      selectProjectDir: () => Promise<string | null>;
      planIntegration: (options: IntegrationOptions) => Promise<IntegrationPlan>;
    };
  }
}

export {};
