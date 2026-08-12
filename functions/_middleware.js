// Send the old pages.dev hostname to the canonical custom domain.
//
// Why this exists: formspeak.pages.dev was flagged as malicious when shared on
// LinkedIn. Free-hosting subdomains carry the aggregate reputation of everything
// else on them, and *.pages.dev has seen heavy phishing abuse. Moving to
// formspeak.paulgale.dev only helps if the flagged hostname stops serving the
// same content — otherwise the reputation problem just runs in parallel, and
// every link already in the wild keeps landing on the bad host.
//
// Matches the production hostname EXACTLY so preview deployments
// (<hash>.formspeak.pages.dev) still work for testing.
const LEGACY_HOST = "formspeak.pages.dev";
const CANONICAL_HOST = "formspeak.paulgale.dev";

export const onRequest = async (ctx) => {
  const url = new URL(ctx.request.url);
  if (url.hostname === LEGACY_HOST) {
    url.hostname = CANONICAL_HOST;
    // 301: permanent, so scanners and search engines transfer to the new host
    // rather than keeping both in their index.
    return Response.redirect(url.toString(), 301);
  }
  return ctx.next();
};
