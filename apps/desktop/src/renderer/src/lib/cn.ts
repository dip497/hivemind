import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The theme's own names (styles.css @theme), so a size is not merged away as a colour. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["heading", "title", "row", "body", "label", "count", "chip"],
      spacing: ["control", "control-compact"],
      radius: ["keycap", "menu", "sheet"],
    },
  },
});

/** shadcn-style className helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
