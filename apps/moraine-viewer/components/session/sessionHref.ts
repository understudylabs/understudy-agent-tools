// Canonical link builder for the transcript view — other pages import this
// instead of hardcoding the route.
export function sessionHref(id: string): string {
  return `/session/${id}`;
}
