/**
 * ═══════════════════════════════════════════════════════════════════════
 *  MIAS LITE MDX — High-Performance WhatsApp Multi-Device Automation Bot
 * ═══════════════════════════════════════════════════════════════════════
 *  Lead Developer: Precious
 *  Architecture: Resilient Multi-Process Microservices & Web Pairing
 *  License: MIT
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

console.log('⚡ [MIAS LITE MDX] Initializing environment...');

// Safe bootstrap runner that restores credentials, validates environment, and spawns server/bot
const bootstrapScript = path.join(__dirname, 'scripts', 'start-with-session-migration.cjs');

if (fs.existsSync(bootstrapScript)) {
    require(bootstrapScript).main().catch((error) => {
        console.error("[session-startup] Startup failed:", error.code || error.name);
        process.exitCode = 1;
    });
} else {
    console.log('⚡ [MIAS LITE MDX] Launching server dashboard...');
    require('./server.js');
}
