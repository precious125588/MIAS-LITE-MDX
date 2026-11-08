'use strict';
// Single switch for every TikWM (tikwm.com) call.
// TikWM sits behind Cloudflare and blocks most server IPs, so it is OFF by default.
// Set TIKWM_ENABLED=1 to bring it back as a last-resort source.
function isTikwmEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.TIKWM_ENABLED || '').trim());
}
module.exports = { isTikwmEnabled };
