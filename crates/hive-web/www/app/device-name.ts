/** A paired browser's name in the person's device list, from its user agent: "Chrome on Android". */
export function deviceName(ua: string): string {
  const browser = first(ua, BROWSERS);
  const system = first(ua, SYSTEMS);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Browser";
}

// In this order: each browser's agent also names the ones it was built on.
const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(A|iOS)?\//, "Edge"],
  [/OPR\/|OPiOS\//, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS: Array<[RegExp, string]> = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Macintosh/, "Mac"],
  [/Linux/, "Linux"],
];

const first = (ua: string, names: Array<[RegExp, string]>): string | undefined => names.find(([re]) => re.test(ua))?.[1];
