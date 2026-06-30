// ============================================================================
// settings.js — extension configuration, stored in globalConfig so it's shared
// across everyone who opens the extension (and synced live).
//
// What's configurable:
//   • sourceTableId / sourceViewId — the view whose field schema + order drives
//     the form. "Each field in a view, in the order it's in the view."
//   • submitTableId — where a submitted record is created. Defaults to the
//     source view's own table (the common case: read schema + write back to the
//     same table). If set to a different table, fields map by NAME.
//   • tokenEndpoint — the server URL that mints Gemini Live ephemeral tokens.
//     Defaults to the deployed FormSpeak token endpoint. The API key lives on
//     that server and never enters the browser.
// ============================================================================

import React from "react";
import {
    useBase,
    useGlobalConfig,
    Box,
    Heading,
    Text,
    FormField,
    TablePickerSynced,
    ViewPickerSynced,
    InputSynced,
} from "@airtable/blocks/ui";

export const KEYS = {
    sourceTableId: "sourceTableId",
    sourceViewId: "sourceViewId",
    submitTableId: "submitTableId",
    tokenEndpoint: "tokenEndpoint",
};

// The deployed FormSpeak token-minting endpoint (Cloudflare Pages function).
// Override per-base in settings if you host your own.
export const DEFAULT_TOKEN_ENDPOINT = "https://formspeak.pages.dev/api/token";

// Resolve the configured models from globalConfig. Returns plain objects/null
// so callers can render a "needs setup" state cleanly.
export function useSettings() {
    const base = useBase();
    const globalConfig = useGlobalConfig();

    const sourceTableId = globalConfig.get(KEYS.sourceTableId);
    const sourceViewId = globalConfig.get(KEYS.sourceViewId);
    const submitTableId = globalConfig.get(KEYS.submitTableId);
    const tokenEndpoint =
        globalConfig.get(KEYS.tokenEndpoint) || DEFAULT_TOKEN_ENDPOINT;

    const sourceTable = sourceTableId
        ? base.getTableByIdIfExists(sourceTableId)
        : null;
    const sourceView =
        sourceTable && sourceViewId
            ? sourceTable.getViewByIdIfExists(sourceViewId)
            : null;
    // Submission target defaults to the source view's table.
    const submitTable = submitTableId
        ? base.getTableByIdIfExists(submitTableId)
        : sourceTable;

    const canEditConfig = globalConfig.hasPermissionToSet();

    return {
        sourceTable,
        sourceView,
        submitTable,
        tokenEndpoint,
        canEditConfig,
        isConfigured: !!sourceView,
    };
}

export function Settings() {
    const base = useBase();
    const globalConfig = useGlobalConfig();
    const sourceTableId = globalConfig.get(KEYS.sourceTableId);
    const sourceTable = sourceTableId
        ? base.getTableByIdIfExists(sourceTableId)
        : null;
    const canEdit = globalConfig.hasPermissionToSet();

    return (
        <Box padding={3}>
            <Heading size="small">FormSpeak settings</Heading>
            {!canEdit && (
                <Text textColor="light" marginTop={2}>
                    You don't have permission to change these settings. Ask a base
                    collaborator with edit access.
                </Text>
            )}
            <FormField
                label="Form source view"
                description="Its visible fields — in view order — become the form."
                marginTop={3}
            >
                <TablePickerSynced
                    globalConfigKey={KEYS.sourceTableId}
                    disabled={!canEdit}
                />
            </FormField>
            {sourceTable && (
                <FormField label="View" marginTop={2}>
                    <ViewPickerSynced
                        table={sourceTable}
                        globalConfigKey={KEYS.sourceViewId}
                        disabled={!canEdit}
                    />
                </FormField>
            )}
            <FormField
                label="Submission table (optional)"
                description="Where a submitted record is created. Leave blank to write back to the source view's own table. If different, fields map by name."
                marginTop={3}
            >
                <TablePickerSynced
                    globalConfigKey={KEYS.submitTableId}
                    shouldAllowPickingNone={true}
                    disabled={!canEdit}
                />
            </FormField>
            <FormField
                label="Gemini token endpoint"
                description="Server URL that mints short-lived Gemini Live tokens. The API key stays on that server."
                marginTop={3}
            >
                <InputSynced
                    globalConfigKey={KEYS.tokenEndpoint}
                    placeholder={DEFAULT_TOKEN_ENDPOINT}
                    disabled={!canEdit}
                />
            </FormField>
        </Box>
    );
}
