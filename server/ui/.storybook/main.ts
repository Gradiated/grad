import type { StorybookConfig } from "@storybook/react-vite";

// Dev-only component and page-state catalogue, built from ../vite.config.ts
// (so the @sdk alias and JSX settings match the app). `pnpm storybook`.
const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../stories/**/*.stories.tsx"],
  core: { disableTelemetry: true },
};

export default config;
