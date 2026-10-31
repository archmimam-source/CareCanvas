import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "@/lib/apiClient";

const AuthContext = createContext(null);

// Persist the JWT access token in localStorage as a fallback for endpoints
// (specifically the presence WebSocket) that can't reliably rely on cookies —
// Safari and several edge configurations drop SameSite=Lax cookies on the WS
// handshake, so we pass the JWT as a `?token=` query param instead. The
// helpers below keep localStorage in lock-step with every successful auth
// call so the fallback path actually works.
const TOKEN_KEY = "token";
const rememberToken = (payload) => {
  const t = payload?.token;
  if (!t) return;
  // Write to both storages. Some browsers (particularly Safari in ITP
  // mode, Firefox strict mode, and Chrome incognito with strict cookies)
  // silently drop `localStorage` for cross-site iframes / SDKs but still
  // allow `sessionStorage` for the current tab. Writing to both means
  // the token survives EITHER restriction.
  try { localStorage.setItem(TOKEN_KEY, t); } catch {}
  try { sessionStorage.setItem(TOKEN_KEY, t); } catch {}
};
const forgetToken = () => {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);      // null while loading, false when signed out, obj when signed in
  const [checked, setChecked] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const r = await api.get("/auth/me");
      setUser(r.data);
      // /auth/me doesn't reissue a token — we keep whatever we had cached.
    } catch {
      setUser(false);
      forgetToken();
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = async (email, password) => {
    const r = await api.post("/auth/login", { email, password });
    rememberToken(r.data);
    setUser(r.data);
    return r.data;
  };

  const register = async (email, password, name) => {
    const r = await api.post("/auth/register", { email, password, name });
    rememberToken(r.data);
    setUser(r.data);
    return r.data;
  };

  const guestLogin = async ({ name, role, organization, discipline } = {}) => {
    // Session-scoped guest id: each tab / manual sign-in gets a fresh id
    // so multiple people at different desks can hold independent sessions.
    // We keep a fallback to localStorage only when name/role aren't provided
    // (so hitting "Continue as guest" without the naming step still works).
    let gid = null;
    if (name || role || organization || discipline) {
      gid = "g_" + (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));
    } else {
      try { gid = localStorage.getItem("his_guest_id"); } catch {}
      if (!gid) {
        gid = "g_" + (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));
        try { localStorage.setItem("his_guest_id", gid); } catch {}
      }
    }
    const r = await api.post("/auth/guest", {
      guest_id: gid,
      label: name || undefined,
      role: role || undefined,
      organization: organization || undefined,
      discipline: discipline || undefined,
    });
    rememberToken(r.data);
    setUser(r.data);
    return r.data;
  };

  const logout = async () => {
    try { await api.post("/auth/logout"); } catch {}
    forgetToken();
    setUser(false);
  };

  return (
    <AuthContext.Provider value={{ user, setUser, login, register, guestLogin, logout, checked, refresh: checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
