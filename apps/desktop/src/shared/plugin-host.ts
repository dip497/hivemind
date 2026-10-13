/** What a tool plugin imports from the app, each at `hm-plugin://host/<name>.js` (tiles/host-sdk.tsx). */
export const HOST_MODULE_NAMES = ["react", "react-jsx-runtime", "sdk", "ui"] as const;
export type HostModuleName = (typeof HOST_MODULE_NAMES)[number];
