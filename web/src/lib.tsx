import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

const configuredApiBase = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
const API_BASE = configuredApiBase || (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:8789"
  : "https://quick-api.querysalon.com");
const STORAGE_KEY = "query-quick.session";

export type Role = "writer" | "agent";

export type Session = {
  token: string;
  user: {
    id: string;
    email: string;
    role: Role;
    display_name: string;
  };
};

export type PublicStats = {
  represented_count: number;
  live_count: number;
};

type AuthContextValue = {
  session: Session | null;
  setSession: (value: Session | null) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      setSessionState(JSON.parse(raw));
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      setSession(next) {
        setSessionState(next);
        if (next) {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } else {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      },
      logout() {
        setSessionState(null);
        window.localStorage.removeItem(STORAGE_KEY);
      },
    }),
    [session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is missing.");
  return value;
}

export async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set("content-type", headers.get("content-type") || "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error || data?.message || `Request failed: ${response.status}`);
  }
  return data;
}

export async function uploadFile<T>(path: string, formData: FormData, token?: string): Promise<T> {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { method: "POST", body: formData, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error || data?.message || `Upload failed: ${response.status}`);
  }
  return data;
}
