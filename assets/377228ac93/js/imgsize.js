// Photos and logos at the size the page draws them (2026-10-17, Lighthouse:
// the home page downloaded 6.4MB, nearly all of it full size ESPN photos drawn
// at 28px). Both image hosts resize on request: the NFL's by a transform in the
// path, ESPN's through its combiner (a 288KB photo comes back near 3KB). Twice
// the drawn size, for a sharp screen. Any other link comes back unchanged, and
// each page falls back to the original link if a sized one fails to load.
const NFL = /^(https:\/\/static\.www\.nfl\.com\/image\/upload\/)f_auto,q_auto(\/.+)$/;
const ESPN = /^https:\/\/a\.espncdn\.com(\/i\/(?:headshots|teamlogos)\/[^?#&]+\.(?:png|jpg))$/;

export function sizedImage(url, size) {
  const px = Math.round(size * 2);
  let m = NFL.exec(url || "");
  if (m) return `${m[1]}f_auto,q_auto,w_${px},h_${px},c_fill,g_face${m[2]}`;
  m = ESPN.exec(url || "");
  if (m) return `https://a.espncdn.com/combiner/i?img=${m[1]}&w=${px}&h=${px}&scale=crop&cquality=80`;
  return url;
}

// An <img> that tries the sized link, then the original, then calls `fail`.
export function retryOriginal(img, url, fail) {
  img.addEventListener("error", () => {
    if (img.getAttribute("src") !== url) img.setAttribute("src", url);
    else fail();
  });
  return img;
}
