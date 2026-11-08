// Keep the source copy in sync with nexstore/token.js. fix_all.cjs restores
// this file into the persistent nexstore volume on every boot.
require('dotenv').config({ quiet: true });

function getBotToken() {
  return '';
}

function getStartupPassword() {
  return process.env.STARTUP_PASSWORD || 'mais';
}

module.exports = {
  getBotToken,
  getStartupPassword,
  get BOT_TOKEN() { return getBotToken(); },
  get startupPassword() { return getStartupPassword(); },
};
