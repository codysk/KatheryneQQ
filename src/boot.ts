/**
 * KatheryneQQ — OneBot v11 framework for QQNT Linux.
 *
 * Boot entry. The QQ launcher loads this file instead of its own app_launcher
 * after `install-katheryne` rewrites resources/app/package.json.
 *
 * Design notes (differentiation from NapCat / LiteLoader patterns):
 *  - No dlopen interception of wrapper.node: we load it ourselves once, in
 *    this file, under our own module namespace. Nothing is patched into QQ's
 *    own JS bundle.
 *  - No modification of the encrypted application.asar. Only the plaintext
 *    resources/app/package.json "main" field changes.
 *  - The OneBot runtime runs in-process next to the NT kernel; QQ's renderer
 *    is never started (we drive the kernel headlessly), so no preload
 *    scripts and no renderer-side hooks exist at all.
 */
import { initRuntime } from './core/runtime.js';

initRuntime().catch((err) => {
    // Last-resort sink: the QQ process must not die with a dialog box.
    console.error('[katheryne] fatal boot error', err);
    process.exit(1);
});
