import { BRAND, brandedName, saveBlob } from "@/lib/download";

// Download / snapshot the network SVG, cropped and centred on its content.
const NS = "http://www.w3.org/2000/svg";
const PAD = 28, HEAD = 34;

const attrs = (el, o) => { Object.entries(o).forEach(([k, v]) => el.setAttribute(k, v)); return el; };

export function serialise(svg, title) {
  const content = svg.querySelector("[data-content]");
  const bb = content.getBBox();
  const W = Math.max(Math.ceil(bb.width + PAD * 2), 420), H = Math.ceil(bb.height + PAD * 2) + HEAD;
  const c = attrs(document.createElementNS(NS, "svg"), { xmlns: NS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  c.appendChild(attrs(document.createElementNS(NS, "rect"), { width: W, height: H, fill: "#FFFFFF" }));
  const t = attrs(document.createElementNS(NS, "text"), {
    x: 16, y: 22, "font-size": 13, "font-weight": 600, fill: "#1D1D1F", "font-family": "Helvetica, Arial, sans-serif" });
  t.textContent = title;
  c.appendChild(t);
  const ft = attrs(document.createElementNS(NS, "text"), {
    x: W - 12, y: H - 8, "font-size": 9, fill: "#86868B", "text-anchor": "end", "font-family": "Helvetica, Arial, sans-serif" });
  ft.textContent = BRAND;
  const g = content.cloneNode(true);
  g.removeAttribute("data-content");
  g.querySelectorAll("[opacity]").forEach((e) => e.removeAttribute("opacity"));
  g.setAttribute("transform", `translate(${(W - bb.width) / 2 - bb.x},${HEAD + PAD - bb.y})`);
  c.appendChild(g);
  c.appendChild(ft);
  return { xml: new XMLSerializer().serializeToString(c), W, H };
}

export function exportSvg(svg, title, roomName) {
  const { xml } = serialise(svg, title);
  saveBlob(new Blob([xml], { type: "image/svg+xml" }), brandedName(roomName, "network", "svg"));
}

export function exportPng(svg, title, roomName) {
  const { xml, W, H } = serialise(svg, title);
  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = W * 2; cv.height = H * 2;
      const ctx = cv.getContext("2d");
      ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
      cv.toBlob((b) => { saveBlob(b, brandedName(roomName, "network", "png")); resolve(); }, "image/png");
    };
    img.onerror = reject;
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  });
}
