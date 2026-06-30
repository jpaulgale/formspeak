// ============================================================================
// config.js — extension configuration via the interface SDK's custom properties
// (this replaces useGlobalConfig / useSettingsButton, which don't exist here).
//
// getCustomProperties MUST be defined at module scope (stable identity) or it
// causes infinite re-renders — see SKILL §3.
//
// Properties:
//   • sourceTable  — the table whose fields (in field order) become the form.
//   • submitTable  — where a submitted record is created. Defaults to the
//                    source table; if different, fields map by NAME.
//   • tokenEndpoint — server URL that mints Gemini Live ephemeral tokens. The
//                    API key lives on that server and never enters the browser.
// ============================================================================

// The deployed FormSpeak token-minting endpoint (Cloudflare Pages function).
// Override per interface page in the properties panel to use your own server.
export const DEFAULT_TOKEN_ENDPOINT = "https://formspeak.pages.dev/api/token";

export function getCustomProperties(base) {
    const first = base.tables[0] || null;
    return [
        {
            key: "sourceTable",
            label: "Form source table",
            type: "table",
            defaultValue: first,
        },
        {
            key: "submitTable",
            label: "Submission table (defaults to the source table)",
            type: "table",
            defaultValue: null,
        },
        {
            key: "tokenEndpoint",
            label: "Gemini token endpoint",
            type: "string",
            defaultValue: DEFAULT_TOKEN_ENDPOINT,
        },
    ];
}
