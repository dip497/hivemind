// A test tool that frames the address its setting holds, as a tool showing its own local server does.
import React, { useEffect, useState } from "hm-plugin://host/react.js";

const h = React.createElement;

function Frames({ hm }) {
  const [url, setUrl] = useState(hm.settings.url ?? "");
  useEffect(() => hm.on("settings", (s) => setUrl(s.url ?? "")), [hm]);
  if (!url) return h("p", null, "No address yet.");
  return h("iframe", { src: url, title: "framed", style: { width: "100%", height: "100%", border: 0 } });
}

export default { tiles: { frames: Frames } };
