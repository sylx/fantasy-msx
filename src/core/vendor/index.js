// Loads the vendored WebMSX chip emulators in dependency order and hands back
// the populated `wmsx` namespace. Import order matters: each file registers
// itself on the global namespace at load time, and some read others' tables.

import "../env/globals.js";

import "./Util.js";
import "./DeviceMissing.js";
import "./ColorCache.js";
import "./VideoStandard.js";
import "./VideoSignal.js";
import "./VDPCommandProcessor.js";
import "./VDP.js";
import "./AudioTables.js";
import "./AudioSignal.js";
import "./PSGAudio.js";
import "./YM2413Tables.js";
import "./YM2413Audio.js";

/** @type {any} */
export const wmsx = globalThis.wmsx;
export default wmsx;
