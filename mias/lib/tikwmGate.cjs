'use strict';
// Single switch for every TikWM (tikwm.com) call.
// Enabled by default; set TIKWM_ENABLED=0 or TIKWM_DISABLED=1 to disable.
function isTikwmEnabled() {
  if (process.env.TIKWM_ENABLED !== undefined) {
    return !/^(0|false|no|off)$/i.test(String(process.env.TIKWM_ENABLED || "").trim());
  }
  if (process.env.TIKWM_DISABLED !== undefined) {
    return !/^(1|true|yes|on)$/i.test(String(process.env.TIKWM_DISABLED || "").trim());
  }
  return true;
}
module.exports = { isTikwmEnabled };
