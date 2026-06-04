export const authHdr = (): Record<string, string> => ({
  Authorization: `Bearer ${localStorage.getItem('token') ?? ''}`,
});

export async function apiFetch<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: authHdr() });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch {
    return null;
  }
}
