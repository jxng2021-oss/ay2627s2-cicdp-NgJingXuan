const ALLOWED = /^\/(workspaces(\/[A-Za-z0-9-]+(\/[a-z-]+)?)?|account)\/?$/;

export function safeNext(next: string | null | undefined): string {
  if (!next) return "/";
  if (!ALLOWED.test(next)) return "/";
  return next;
}

export function loginUrl(currentPath: string): string {
  const next = safeNext(currentPath);
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}
