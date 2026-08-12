/**
 * A stand-in for `react-devtools-core`.
 *
 * ink imports it at the top of its own `devtools.js`, and that module is only
 * ever loaded when `DEV=true` — but a static import is a static import, so
 * bundling doet without something here fails at *load* with
 * ERR_MODULE_NOT_FOUND for a package that would never have been called.
 *
 * Marking it external does not help for the same reason: the import survives
 * into the bundle and Node resolves it eagerly. So it is aliased to this, which
 * satisfies the import and does nothing, because nothing is what doet wants
 * from the React developer tools.
 */
export default { connectToDevTools() {} };
