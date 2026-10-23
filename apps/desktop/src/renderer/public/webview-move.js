// A custom element with a connectedMoveCallback is moved by Element.moveBefore
// instead of disconnected and reconnected, so a moved <webview> keeps its page.
// Electron defines <webview> after this classic script runs, and the callbacks
// are read at define time, so the hook must be in place first.
(() => {
  const define = CustomElementRegistry.prototype.define;
  CustomElementRegistry.prototype.define = function (name, ctor, options) {
    if (name === "webview") {
      ctor.prototype.connectedMoveCallback ??= function () {};
      CustomElementRegistry.prototype.define = define;
    }
    return define.call(this, name, ctor, options);
  };
})();
