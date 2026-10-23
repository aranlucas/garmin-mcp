export function htmlHeaders(formAction = "'self'"): Headers {
  const headers = new Headers();

  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
  );
  headers.set("X-Content-Type-Options", "nosniff");
  // Not no-referrer: browsers then send `Origin: null` on form posts, failing the Origin check.
  headers.set("Referrer-Policy", "same-origin");

  return headers;
}

// The separate business Training API still serves its own static consent documents.
export function html(
  body: string,
  status = 200,
  headers = new Headers(),
  formAction = "'self'",
): Response {
  for (const [name, value] of htmlHeaders(formAction)) {
    headers.set(name, value);
  }

  return new Response(body, { status, headers });
}

/** Browsers apply form-action to the redirect after a form post, so allow the validated client redirect. */
export function consentFormAction(redirectUri: string): string {
  const url = new URL(redirectUri);

  return `'self' ${url.origin === "null" ? url.protocol : url.origin}`;
}
