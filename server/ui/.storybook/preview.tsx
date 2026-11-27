import type { Preview } from "@storybook/react-vite";

import { applyTheme, type Theme } from "../src/lib/theme.js";
import "../src/styles.css";

const preview: Preview = {
  parameters: { layout: "fullscreen" },
  globalTypes: {
    theme: {
      description: "grad UI theme",
      toolbar: { title: "Theme", icon: "mirror", items: ["dark", "light"], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: "dark" },
  decorators: [
    (Story, ctx) => {
      applyTheme(ctx.globals.theme as Theme);
      return <Story />;
    },
  ],
};

export default preview;
