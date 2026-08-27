/**
 * dsh-conversation-toc — host half.
 *
 * This is a browser-only surface plugin: everything lives in the client half
 * (exports "./client"). The host half exists only so the cordis loader can
 * mount the plugin row by package name; it contributes no services, no routes,
 * and no settings.
 */

/** Required host services: none. */
const inject = [];

/** Host plugin body: nothing to do. */
function apply(_ctx) {}

export { apply, inject };
