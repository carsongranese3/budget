import { useCallback, useEffect, useState } from "react";

export class ApiFail extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function api<T = void>(path: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api" + path, {
      method,
      headers: method === "GET" ? undefined : { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiFail("internal", "can't reach the server");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFail(data?.error?.code ?? "internal", data?.error?.message ?? "request failed");
  return data as T;
}

/** GET with loading/error state. Keeps the previous data while a new path loads. Pass null to skip. */
export function useGet<T>(path: string | null) {
  const [s, setS] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: path !== null,
  });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let live = true;
    setS((p) => ({ ...p, loading: true, error: null }));
    api<T>(path).then(
      (data) => live && setS({ data, error: null, loading: false }),
      (e: Error) => live && setS((p) => ({ ...p, error: e.message, loading: false })),
    );
    return () => {
      live = false;
    };
  }, [path, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  const set = useCallback((data: T) => setS((p) => ({ ...p, data })), []);
  return { ...s, reload, set };
}
