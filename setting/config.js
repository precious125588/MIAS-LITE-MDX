const fs = require('fs');

global.owner = [process.env.OWNER_NUMBER ? process.env.OWNER_NUMBER.replace(/[^0-9]/g, '') : "234"];
global.footer = process.env.BOT_NAME || "MIAS MDX";
global.status = false;
global.prefa = ['', '!', '.', ',', '🐤', '🗿'];
global.xprefix = process.env.PREFIX || '.';
global.gambar = "https://i.ibb.co/hRxLvCWb/RD32333335343832373039383440732e77686174736170702e6e6574-499562.jpg";
global.OWNER_NAME = process.env.OWNER_NAME || process.env.BOT_ACTIVE_USER || "Owner";
global.DEVELOPER = [process.env.OWNER_NUMBER ? process.env.OWNER_NUMBER.replace(/[^0-9]/g, '') : ""];
global.BOT_NAME = process.env.BOT_NAME || "MIAS MDX";
global.bankowner = process.env.BOT_NAME || "MIAS MDX";
global.creatorName = process.env.OWNER_NAME || "Owner";
global.ownernumber = process.env.OWNER_NUMBER ? process.env.OWNER_NUMBER.replace(/[^0-9]/g, '') : '';
global.location = "Nigeria";
global.prefa = ['', '!', '.', '#', '&'];
//================DO NOT CHANGE OR YOU'LL GET AN ERROR=============global.link = "https://chat.whatsapp.com/Bnrx29Li2mZDS2LKxI9LYM";
global.autobio = true;
global.botName = process.env.BOT_NAME || "MIAS MDX";
global.version = "1.0.1";
global.botname = process.env.BOT_NAME || "MIAS MDX";
global.author = process.env.BOT_NAME || "DEV MAIS";
global.themeemoji = "🥷";
global.wagc = 'https://chat.whatsapp.com/Bnrx29Li2mZDS2LKxI9LYMt';
global.thumbnail = 'https://i.ibb.co/hRxLvCWb/RD32333335343832373039383440732e77686174736170702e6e6574-499562.jpg';
global.richpp = ' ';
global.packname = "Sticker By " + (process.env.BOT_NAME || "MIAS MDX");
global.creator = (process.env.OWNER_NUMBER ? process.env.OWNER_NUMBER.replace(/[^0-9]/g, '') : '') + "@s.whatsapp.net";
global.ownername = process.env.OWNER_NAME || process.env.BOT_ACTIVE_USER || "Owner";
global.onlyowner = `Only the bot owner can use this command 🥶🥷`;
global.database = `*To Exist In The Database Contact The Owner of this bot*`;
global.mess = {
  wait: "*Configurating.......*",
  success: "*Successfully acknowledged ☑️*",
  on: "*Activated ✅*", 
  prem: "*Feature For Premium Users only*", 
  off: "*Deactivated 📛*",
  query: {
    text: "*Please, Provide A Text Query 📑*",
    link: "Please, provide a valid link 🔗*",
  },
  error: {
    fitur: "*Status 🌐: Feature Or Command error ❌*",
  },
  only: {
    group: "*Group only feature ❌*",
    private: "*Private chat feature only ❌*",
    owner: "*Owner feature only ❌*",
    admin: "*bot owner feature only ❌*",
    badmin: "*Seek admin privilege's to use this command ❌*",
    premium: "*Availabe for premium users only ❌*",
  }
};

global.hituet = 0;
global.autoviewstatus = false;
global.autoread = false;
global.autobio = true;
global.anti92 = true;
global.autoswview = true;
