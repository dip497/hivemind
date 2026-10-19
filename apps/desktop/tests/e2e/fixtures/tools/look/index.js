// A test tool that draws something an agent can see in a picture, and logs that it did.
import React, { useEffect } from "hm-plugin://host/react.js";

const h = React.createElement;

function Look() {
  useEffect(() => { console.log("look: drawn"); }, []);
  return h("div", { style: { height: "100%", background: "rgb(220, 40, 40)", color: "white", padding: 16 } }, "A red box");
}

export default { tiles: { look: Look } };
