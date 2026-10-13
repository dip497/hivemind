// The keyboard takes the bottom of the screen on a phone. Chrome on Android shrinks the page to what
// is left (index.html's interactive-widget); Safari on iOS keeps the page and moves what is seen
// down over it, by visualViewport.offsetTop. A screen with a reply box is placed in what is seen,
// so the box sits on the keyboard either way.

/** Keep `--vh` and `--vv-top` the height and top of what is seen. */
export function followViewport(): void {
  const v = visualViewport;
  if (!v) return;
  const root = document.documentElement.style;
  const follow = () => {
    root.setProperty("--vh", `${v.height}px`);
    root.setProperty("--vv-top", `${v.offsetTop}px`);
  };
  v.addEventListener("resize", follow);
  v.addEventListener("scroll", follow);
}
