import axios from "axios";

export const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

export const api = axios.create({
  baseURL: API,
  // Auth is now carried explicitly via `Authorization: Bearer <token>` (see
  // the request interceptor below). We deliberately keep credentials OFF so
  // the browser never asks for CORS credentials — that's important because
  // the deployed frontend origin (the static site) is DIFFERENT from the
  // API origin (the backend service), and `Access-Control-Allow-Origin: *`
  // is incompatible with credentialed cross-origin requests. Setting
  // `withCredentials` false bypasses that constraint entirely.
  withCredentials: false,
});

// ─── Request interceptor: attach Authorization header from localStorage ───
// Cookies with `SameSite=Lax` DO NOT attach on cross-origin requests, which
// happens whenever the deployed frontend origin differs from the backend
// origin (e.g., the static frontend calling the separately hosted API).
// Without this header the browser silently drops the credentials → every API
// call returns 401 → the response interceptor below reloads the page → the
// user gets a refresh loop. Attaching the JWT explicitly bypasses the cookie
// path entirely and works from any origin.
api.interceptors.request.use((config) => {
  try {
    // Prefer localStorage but fall back to sessionStorage so tabs where
    // localStorage is silently blocked (Safari ITP, some incognito modes)
    // can still make authed requests.
    let token = null;
    try { token = localStorage.getItem("token"); } catch {}
    if (!token) { try { token = sessionStorage.getItem("token"); } catch {} }
    if (token) {
      config.headers = config.headers || {};
      if (!config.headers.Authorization) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
  } catch {}
  return config;
});

// ─── Response interceptor: on 401, redirect to /signin ────────────────────
// (except for auth endpoints and `/auth/me` check on first paint). We also
// keep a **persistent** circuit breaker via sessionStorage so that if MANY
// 401s fire in rapid succession across page reloads we don't create an
// infinite refresh loop — after 3 redirects inside 5 s we bail and let the
// user see whatever the current page has rather than reloading endlessly.
const REDIRECT_STAMPS_KEY = "__hc_redirect_stamps";
function shouldAllowRedirect() {
  const now = Date.now();
  let arr = [];
  try { arr = JSON.parse(sessionStorage.getItem(REDIRECT_STAMPS_KEY) || "[]"); } catch {}
  arr = arr.filter((t) => now - t < 5000);
  arr.push(now);
  try { sessionStorage.setItem(REDIRECT_STAMPS_KEY, JSON.stringify(arr)); } catch {}
  return arr.length <= 3;
}
api.interceptors.response.use(
  (r) => r,
  (error) => {
    const url = error.config?.url || "";
    const isAuthEndpoint = url.includes("/auth/");
    if (error.response?.status === 401 && !isAuthEndpoint) {
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/signin")) {
        if (shouldAllowRedirect()) {
          try { localStorage.removeItem("token"); } catch {}
          try { sessionStorage.removeItem("token"); } catch {}
          window.location.replace("/signin");
        }
        // else: silently drop, let the caller handle the 401 in-place —
        // this is what breaks any residual refresh loop dead in its tracks.
      }
    }
    return Promise.reject(error);
  }
);

export function formatApiError(detail) {
  if (detail == null) return "Something went wrong.";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail.map((e) => (e && typeof e.msg === "string" ? e.msg : JSON.stringify(e))).filter(Boolean).join(" ");
  if (detail && typeof detail.msg === "string") return detail.msg;
  return String(detail);
}
