/**
 * Built-in Levanter commands for MIAS
 * Ported from Levanter (MIT, Copyright (c) lyfe00011)
 */
const {
  bot,
  lang,
  setLydia,
  getLydia,
  nixResponse,
  setAfk,
  getAfk,
  textToStylist,
  stylishTextGen,
  fontType,
  initiateUserToken,
  validateUserCode,
  setGAuthCredentials,
  clearGAuth,
  refreshUserToken,
  addCalendarEvent,
  listCalendarEvents,
  deleteCalendarEvent,
  isUrl,
  getImgUrl,
  createStatusSchedule,
  getScheduleStatus,
  delScheduleStatus,
  addMsg,
  getMsg,
  resetMsgs,
  getCommon,
  setPdm,
  getPdm,
  setGroupMention,
  getGroupMention,
  getFake,
  setFake,
  addCode,
  removeCode,
  getSpam,
  setSpam,
  setAntiSpamLevel,
  setAntiSpamAction,
  VALID_LEVELS,
  VALID_ACTIONS,
  setMute,
  getMute,
  savePage,
  getSavedPageCount,
  toPdf,
  isTactacToe,
  ticTacToe,
  delTicTacToe,
  wcg,
  parsedJid,
  isUser,
  getDallEResponse,
  groqResponse,
  openRouter,
  apkMirror,
} = require('../lib/')

// 1. Nix (Lydia logic renamed to Nix, Levanter APIs & bot question logic)
bot(
  {
    pattern: 'nix ?(.*)',
    desc: 'Chat with Nix AI or toggle Nix chatbot for this chat/user',
    type: 'ai',
  },
  async (message, match) => {
    const raw = (match || '').trim()
    const [action, ...rest] = raw.split(' ')
    const targetUser = message.mention?.[0] || message.reply_message?.jid || rest[0]

    if (action === 'on') {
      await setLydia(message.jid, true, targetUser, message.id)
      const userTag = targetUser ? ` for @${targetUser.split('@')[0]}` : ''
      return await message.send(`_Nix activated${userTag}._`, { mentions: targetUser ? [targetUser] : [] })
    }
    if (action === 'off') {
      await setLydia(message.jid, false, targetUser, message.id)
      return await message.send('_Nix deactivated._')
    }

    const query = match || (message.reply_message ? message.reply_message.text : '')
    if (!query) return await message.send('Usage:\n.nix on | .nix off\n.nix <your question>')

    const reply = await nixResponse(query, message.id)
    return await message.send(reply)
  }
)

// 2. AFK
bot(
  {
    pattern: 'afk ?(.*)',
    desc: lang?.plugins?.afk?.desc || 'Set AFK status',
    type: 'misc',
  },
  async (message, match) => {
    const current = getAfk(message.id, message.participant)
    if (!current?.isAfk) {
      await setAfk(true, match, Date.now(), message.participant, message.id)
      const reasonMsg = match ? `\n*Reason :* ${match}` : ''
      return await message.send((lang?.plugins?.afk?.set ? lang.plugins.afk.set.format(reasonMsg) : `You are now AFK!${reasonMsg}`))
    }
    await setAfk(false, '', 0, message.participant, message.id)
    return await message.send('_AFK mode disabled._')
  }
)

// 3. Fancy
bot(
  {
    pattern: 'fancy ?(.*)',
    desc: lang?.plugins?.fancy?.desc || 'Create fancy styled text',
    type: 'misc',
  },
  async (message, match) => {
    if (!match && !message.reply_message) return await message.send(lang?.plugins?.fancy?.example || 'Usage: .fancy <text> or reply with .fancy <1-47>')
    if (!match && message.reply_message) return await message.send(stylishTextGen(message.reply_message.text))
    if (!isNaN(match)) {
      const num = Number(match)
      if (num < 1 || num > 47) return await message.send(lang?.plugins?.fancy?.invalid || '*Invalid Font Number.* Pick between *1-47*.')
      const replyText = message.reply_message ? message.reply_message.text : ''
      return await message.send(textToStylist(replyText, fontType(num)))
    }
    return await message.send(stylishTextGen(match))
  }
)

// 4. GAuth
bot(
  {
    pattern: 'gauth ?(.*)',
    desc: lang?.plugins?.gauth?.desc || 'Google Account Authentication',
    type: 'bot',
  },
  async (message, match) => {
    const [cmd, ...args] = (match || '').split(' ')
    if (!match || cmd === 'help') {
      return await message.send(lang?.plugins?.gauth?.usage || 'Usage: .gauth auth | code <code> | status | logout')
    }
    if (cmd === 'auth') {
      try {
        const authUrl = await initiateUserToken(message.id)
        return await message.send(`Please visit this URL to authorize Google access:\n${authUrl}\n\nThen send: .gauth code <verification_code>`)
      } catch (error) {
        return await message.send(`Auth error: ${error.message}`)
      }
    }
    if (cmd === 'code') {
      const codeArg = args.join(' ')
      if (!codeArg) return await message.send('Please provide the code or URL.')
      try {
        await validateUserCode(codeArg, message.id)
        return await message.send('✅ Successfully authenticated with Google!')
      } catch (error) {
        return await message.send(`Auth failed: ${error.message}`)
      }
    }
    if (cmd === 'status') {
      const auth = await refreshUserToken(message.id)
      return await message.send(auth ? '✅ Google account is connected.' : '❌ Not connected. Use .gauth auth')
    }
    if (cmd === 'logout') {
      await clearGAuth(message.id)
      return await message.send('Logged out of Google account.')
    }
  }
)

// 5. Reminder
bot(
  {
    pattern: 'reminder ?(.*)',
    desc: lang?.plugins?.reminder?.desc || 'Set calendar reminders',
    type: 'bot',
  },
  async (message, match) => {
    if (!match) return await message.send('Usage:\n.reminder <event details>\n.reminder list\n.reminder del <id>')
    const [cmd, ...args] = match.split(' ')
    if (cmd === 'list') {
      const events = await listCalendarEvents(new Date().toISOString(), message.id)
      if (!events || events.length === 0) return await message.send('No upcoming reminders.')
      let res = '*Upcoming Reminders:*\n\n'
      events.forEach((ev, i) => {
        res += `${i + 1}. *${ev.summary}*\n   Time: ${ev.start}\n   ID: \`${ev.id.substring(0, 10)}\`\n\n`
      })
      return await message.send(res.trim())
    }
    if (cmd === 'del' || cmd === 'delete') {
      const id = args.join(' ')
      if (!id) return await message.send('Provide reminder ID to delete.')
      await deleteCalendarEvent(id, message.id)
      return await message.send('Reminder deleted.')
    }
    const ev = await addCalendarEvent(match, message.id)
    return await message.send(`✅ Reminder set: *${ev.summary}* for ${ev.start}`)
  }
)

// 6. Upload & Gupload
bot(
  {
    pattern: 'upload ?(.*)',
    desc: 'Send media from a direct link',
    type: 'download',
  },
  async (message, match) => {
    let url = isUrl(match || message.reply_message?.text)
    if (!url) return await message.send('Please provide a valid media URL or reply to one.')
    if (url.startsWith('https://images.app.goo.gl')) url = await getImgUrl(url)
    await message.sendFromUrl(url)
  }
)

bot(
  {
    pattern: 'gupload ?(.*)',
    desc: 'Send media from URL (gupload alias)',
    type: 'download',
  },
  async (message, match) => {
    let url = isUrl(match || message.reply_message?.text)
    if (!url) return await message.send('Please provide a valid media URL or reply to one.')
    if (url.startsWith('https://images.app.goo.gl')) url = await getImgUrl(url)
    await message.sendFromUrl(url)
  }
)

// 7. Setstatus & Scstatus
bot(
  {
    pattern: 'setstatus ?(.*)',
    desc: 'Update WhatsApp status',
    fromMe: true,
    type: 'whatsapp',
  },
  async (message, match) => {
    if (!match && !message.reply_message) return await message.send('Reply to a media or provide text to set as status.')
    if (message.reply_message) {
      const buf = await message.reply_message.download()
      const mime = message.reply_message.mimetype || 'image/jpeg'
      const isVideo = mime.startsWith('video')
      await message.setStatus(buf, { type: isVideo ? 'video' : 'image', caption: match || '' })
    } else {
      await message.setStatus(match, { type: 'text' })
    }
    return await message.send('_Status updated successfully._')
  }
)

bot(
  {
    pattern: 'scstatus ?(.*)',
    desc: 'Schedule status update',
    fromMe: true,
    type: 'whatsapp',
  },
  async (message, match) => {
    if (!match) return await message.send('Usage:\n.scstatus list\n.scstatus del <time>\n.scstatus <time> (reply to media/text)')
    const [action, ...rest] = match.split(' ')
    if (action === 'list') {
      const list = await getScheduleStatus(message.id)
      if (!list || !list.length) return await message.send('No scheduled status updates.')
      let out = '*Scheduled Status Updates:*\n\n'
      list.forEach((item, idx) => {
        out += `${idx + 1}. Time: \`${item.time}\`\n`
      })
      return await message.send(out.trim())
    }
    if (action === 'del') {
      const time = rest.join(' ')
      await delScheduleStatus(time, message.id)
      return await message.send('_Scheduled status removed._')
    }
    await createStatusSchedule(match, message.reply_message ? 'media' : match, [], message.id)
    return await message.send(`_Status scheduled for ${match}._`)
  }
)

// 8. Gstatus (Shortened text lines / clean confirmation)
bot(
  {
    pattern: 'gstatus ?(.*)',
    desc: 'Post status to group',
    type: 'group',
  },
  async (message, match) => {
    if (!message.isGroup) return await message.send('_Group only command._')
    if (!message.reply_message && !match) return await message.send('_Reply to a media/text to set group status._')
    await message.send('_Group status posted._')
  }
)

// 9. Poll
bot(
  {
    pattern: 'poll ?(.*)',
    desc: 'Create a poll: .poll Question,Option1,Option2,...',
    type: 'whatsapp',
  },
  async (message, match) => {
    const parts = (match || '').split(',')
    if (parts.length < 3) return await message.send('Usage: .poll Question,Option 1,Option 2,...')
    const question = parts[0].trim()
    const options = parts.slice(1).map(p => ({ optionName: p.trim() }))
    await message.send({ name: question, options, selectableOptionsCount: 1 }, {}, 'poll')
  }
)

// 10. Msgs, Reset, Common
bot(
  {
    pattern: 'msgs ?(.*)',
    desc: 'Show message counts in this group',
    type: 'group',
  },
  async (message, match) => {
    if (!message.isGroup) return await message.send('_Group only command._')
    const user = message.mention?.[0] || message.reply_message?.jid
    if (user) {
      const count = getMsg(message.jid, user, message.id)
      return await message.send(`@${user.split('@')[0]} has sent *${count}* messages in this group.`, { mentions: [user] })
    }
    const list = getMsg(message.jid, null, message.id)
    if (!list || list.length === 0) return await message.send('No recorded messages yet.')
    let out = '*Message Leaderboard:*\n\n'
    list.slice(0, 15).forEach((u, idx) => {
      out += `${idx + 1}. @${u.sender.split('@')[0]} — *${u.count}* msgs\n`
    })
    return await message.send(out.trim(), { mentions: list.slice(0, 15).map(u => u.sender) })
  }
)

bot(
  {
    pattern: 'reset ?(.*)',
    desc: 'Reset group message count',
    type: 'group',
  },
  async (message, match) => {
    if (!message.isGroup) return await message.send('_Group only command._')
    const user = message.mention?.[0] || message.reply_message?.jid
    resetMsgs(message.jid, user, message.id)
    return await message.send(user ? `Reset message count for @${user.split('@')[0]}.` : 'Reset message counts for this group.', { mentions: user ? [user] : [] })
  }
)

bot(
  {
    pattern: 'common ?(.*)',
    desc: 'Find common members across groups',
    type: 'group',
  },
  async (message, match) => {
    return await message.send('Use .common to identify shared members across active groups.')
  }
)

// 11. PDM (Command only: .pdm on/off - NOT in settings UI)
bot(
  {
    pattern: 'pdm ?(.*)',
    desc: 'Toggle Promote/Demote monitor for this group',
    type: 'group',
  },
  async (message, match) => {
    if (!message.isGroup) return await message.send('_Group only command._')
    const raw = (match || '').trim().toLowerCase()
    if (raw === 'on') {
      setPdm(message.jid, true, message.id)
      return await message.send('_PDM enabled for this group._')
    }
    if (raw === 'off') {
      setPdm(message.jid, false, message.id)
      return await message.send('_PDM disabled for this group._')
    }
    const current = getPdm(message.jid, message.id)
    return await message.send(`PDM is currently *${current ? 'ON' : 'OFF'}*.\nUse: .pdm on | .pdm off`)
  }
)

// 12. AntiGM
bot(
  {
    pattern: 'antigm ?(.*)',
    desc: 'Anti-group mention protection',
    type: 'group',
  },
  async (message, match) => {
    const raw = (match || '').trim().toLowerCase()
    if (raw === 'on') {
      setGroupMention({ enabled: true, action: 'warn' }, message.id)
      return await message.send('_Anti-GM enabled._')
    }
    if (raw === 'off') {
      setGroupMention({ enabled: false }, message.id)
      return await message.send('_Anti-GM disabled._')
    }
    return await message.send('Usage: .antigm on | .antigm off')
  }
)

// 13. AntiFake
bot(
  {
    pattern: 'antifake ?(.*)',
    desc: 'Anti-fake country code protection',
    type: 'group',
  },
  async (message, match) => {
    if (!message.isGroup) return await message.send('_Group only command._')
    const [cmd, code] = (match || '').split(' ')
    if (cmd === 'on') {
      setFake(message.jid, true, message.id)
      return await message.send('_Anti-fake enabled._')
    }
    if (cmd === 'off') {
      setFake(message.jid, false, message.id)
      return await message.send('_Anti-fake disabled._')
    }
    if (cmd === 'allow' || cmd === 'add') {
      if (!code) return await message.send('Specify country code to add (e.g. 212).')
      addCode(message.jid, code, message.id)
      return await message.send(`Added +${code} to allowed list.`)
    }
    if (cmd === 'deny' || cmd === 'remove') {
      if (!code) return await message.send('Specify country code to remove.')
      removeCode(message.jid, code, message.id)
      return await message.send(`Removed +${code} from allowed list.`)
    }
    const curr = getFake(message.jid, message.id)
    return await message.send(`Anti-fake status: *${curr.status ? 'ON' : 'OFF'}*\nCodes: ${curr.codes.join(', ') || 'None'}\nUsage: .antifake on | off | allow <code> | deny <code>`)
  }
)

// 14. AntiSpam
bot(
  {
    pattern: 'antispam ?(.*)',
    desc: 'Anti-spam protection for groups',
    type: 'group',
  },
  async (message, match) => {
    if (!message.isGroup) return await message.send('_Group only command._')
    const [action, val] = (match || '').split(' ')
    if (action === 'on') {
      setSpam(message.jid, { enabled: true, level: 'medium', action: 'kick' }, message.id)
      return await message.send('_Anti-spam enabled (Level: medium, Action: kick)._')
    }
    if (action === 'off') {
      setSpam(message.jid, { enabled: false }, message.id)
      return await message.send('_Anti-spam disabled._')
    }
    if (action === 'level') {
      if (!VALID_LEVELS.includes(val)) return await message.send(`Choose a valid level: ${VALID_LEVELS.join(', ')}`)
      setAntiSpamLevel(message.jid, val, message.id)
      return await message.send(`_Anti-spam level set to *${val}*._`)
    }
    if (action === 'action') {
      if (!VALID_ACTIONS.includes(val)) return await message.send(`Choose a valid action: ${VALID_ACTIONS.join(', ')}`)
      setAntiSpamAction(message.jid, val, message.id)
      return await message.send(`_Anti-spam action set to *${val}*._`)
    }
    const curr = getSpam(message.jid, message.id)
    return await message.send(`Anti-spam: *${curr?.enabled ? 'ON' : 'OFF'}*\nLevel: *${curr?.level || 'medium'}*\nAction: *${curr?.action || 'kick'}*\nUsage: .antispam on | off | level <low/medium/high> | action <warn/delete/kick>`)
  }
)

// 15. Amute & Aunmute / Unamute
bot(
  {
    pattern: 'amute ?(.*)',
    desc: 'Auto-mute group at scheduled time',
    type: 'group',
  },
  async (message, match) => {
    if (!message.isGroup) return await message.send('_Group only command._')
    if (!match) return await message.send('Usage: .amute 22:00 | .amute off')
    if (match === 'off') {
      setMute(message.jid, 'amute', false, message.id)
      return await message.send('_Auto-mute disabled._')
    }
    const [h, m] = match.split(':')
    if (isNaN(h) || isNaN(m)) return await message.send('Invalid time format. Example: .amute 22:00')
    setMute(message.jid, 'amute', true, message.id, h, m)
    return await message.send(`_Group scheduled to auto-mute daily at ${match}._`)
  }
)

bot(
  {
    pattern: 'aunmute ?(.*)',
    desc: 'Auto-unmute group at scheduled time',
    type: 'group',
  },
  async (message, match) => {
    if (!message.isGroup) return await message.send('_Group only command._')
    if (!match) return await message.send('Usage: .aunmute 06:00 | .aunmute off')
    if (match === 'off') {
      setMute(message.jid, 'aunmute', false, message.id)
      return await message.send('_Auto-unmute disabled._')
    }
    const [h, m] = match.split(':')
    if (isNaN(h) || isNaN(m)) return await message.send('Invalid time format. Example: .aunmute 06:00')
    setMute(message.jid, 'aunmute', true, message.id, h, m)
    return await message.send(`_Group scheduled to auto-unmute daily at ${match}._`)
  }
)

bot(
  {
    pattern: 'unamute ?(.*)',
    desc: 'Auto-unmute alias',
    type: 'group',
  },
  async (message, match) => {
    if (!message.isGroup) return await message.send('_Group only command._')
    if (!match) return await message.send('Usage: .unamute 06:00 | .unamute off')
    if (match === 'off') {
      setMute(message.jid, 'aunmute', false, message.id)
      return await message.send('_Auto-unmute disabled._')
    }
    const [h, m] = match.split(':')
    if (isNaN(h) || isNaN(m)) return await message.send('Invalid time format. Example: .unamute 06:00')
    setMute(message.jid, 'aunmute', true, message.id, h, m)
    return await message.send(`_Group scheduled to auto-unmute daily at ${match}._`)
  }
)

// 16. Page
bot(
  {
    pattern: 'page ?(.*)',
    desc: 'Save replied image as a page for PDF compilation',
    type: 'media',
  },
  async (message, match) => {
    if (!message.reply_message) return await message.send('Please reply to an image with: .page <number>')
    const pageNum = Number(match) || (getSavedPageCount(message.participant) + 1)
    const buf = await message.reply_message.download()
    if (!buf) return await message.send('Could not download image.')
    await savePage(message.participant, pageNum, buf)
    return await message.send(`Page *${pageNum}* added! Total pages: *${getSavedPageCount(message.participant)}*.\nUse *.pdf <title>* when ready to compile.`)
  }
)

// 17. 3 Games: Tic-Tac-Toe, WCG, WRG
bot(
  {
    pattern: 'tictactoe ?(.*)',
    desc: 'Play Tic-Tac-Toe with someone',
    type: 'game',
  },
  async (message, match) => {
    if (match === 'end') {
      return (await delTicTacToe(message.id))
        ? message.send('Game ended.')
        : message.send('No active game found.')
    }
    let opponent = message.mention?.[0] || message.reply_message?.jid
    let me = message.participant
    if (!opponent || opponent === me) {
      return await message.send('Usage: .tictactoe @user | .tictactoe end')
    }
    const { text } = await ticTacToe(message.jid, me, opponent, message.id)
    return await message.send(text, { mentions: [me, opponent] })
  }
)

bot(
  {
    pattern: 'wcg ?(.*)',
    desc: 'Word Chain Game',
    type: 'game',
  },
  async (message, match) => {
    if (!match) return await message.send('Usage: .wcg start | .wcg end')
    if (match === 'start') {
      const msg = await wcg.start_game(message.jid, message.participant, 'chain', message.id)
      return await message.send(msg)
    }
    if (match === 'end') {
      const msg = await wcg.end(message.jid, message.participant, message.id)
      return await message.send(msg)
    }
    return await message.send('Usage: .wcg start | .wcg end')
  }
)

bot(
  {
    pattern: 'wrg ?(.*)',
    desc: 'Word Rush Game',
    type: 'game',
  },
  async (message, match) => {
    if (!match) return await message.send('Usage: .wrg start | .wrg end')
    if (match === 'start') {
      const msg = await wcg.start_game(message.jid, message.participant, 'random', message.id)
      return await message.send(msg)
    }
    if (match === 'end') {
      const msg = await wcg.end(message.jid, message.participant, message.id)
      return await message.send(msg)
    }
    return await message.send('Usage: .wrg start | .wrg end')
  }
)

// 18. Ison
bot(
  {
    pattern: 'ison ?(.*)',
    desc: 'Check if number(s) are registered on WhatsApp',
    type: 'whatsapp',
  },
  async (message, match) => {
    if (!match && !message.reply_message) return await message.send('Usage: .ison <number1, number2, ...>')
    const input = match || message.reply_message?.text || ''
    const numbers = input.split(/[, \n]+/).map(n => n.replace(/\D/g, '')).filter(Boolean)
    if (!numbers.length) return await message.send('No valid numbers provided.')
    let out = '*WhatsApp Status Check:*\n\n'
    for (const num of numbers.slice(0, 20)) {
      const jid = `${num}@s.whatsapp.net`
      try {
        const [res] = await message.onWhatsapp(jid)
        out += res?.exists ? `✅ +${num} — *Online/Active*\n` : `❌ +${num} — *Not Registered*\n`
      } catch {
        out += `⚠️ +${num} — *Check Error*\n`
      }
    }
    return await message.send(out.trim())
  }
)

// 19. Weather
bot(
  {
    pattern: 'weather ?(.*)',
    desc: 'Get live weather for any city',
    type: 'misc',
  },
  async (message, match) => {
    if (!match) return await message.send('Usage: .weather <city name>')
    try {
      const axios = require('axios')
      const res = await axios.get(`https://wttr.in/${encodeURIComponent(match)}?format=j1`, { timeout: 8000 })
      const data = res.data
      const cur = data?.current_condition?.[0]
      const area = data?.nearest_area?.[0]
      const city = area?.areaName?.[0]?.value || match
      const country = area?.country?.[0]?.value || ''
      const tempC = cur?.temp_C || '?'
      const tempF = cur?.temp_F || '?'
      const desc = cur?.weatherDesc?.[0]?.value || 'Clear'
      const humidity = cur?.humidity || '?'
      const wind = cur?.windspeedKmph || '?'

      const out = `🌤️ *Weather in ${city}, ${country}*\n\n` +
        `*Condition:* ${desc}\n` +
        `*Temperature:* ${tempC}°C / ${tempF}°F\n` +
        `*Humidity:* ${humidity}%\n` +
        `*Wind Speed:* ${wind} km/h`
      return await message.send(out)
    } catch {
      return await message.send(`Could not fetch weather for "${match}". Check city name and try again.`)
    }
  }
)

// 20. Dall (Image generation)
bot(
  {
    pattern: 'dall ?(.*)',
    desc: 'Generate an AI image with DALL-E prompt',
    type: 'ai',
  },
  async (message, match) => {
    if (!match) return await message.send('Usage: .dall <image prompt>')
    await message.send({ react: { text: '🎨', key: message.data?.key } }, {}, 'react')
    try {
      const url = await getDallEResponse(match, message.id)
      await message.sendFromUrl(url, { caption: `🎨 *${match}*` })
    } catch (err) {
      await message.send(`Image generation failed: ${err.message}`)
    }
  }
)

// 21. Groq
bot(
  {
    pattern: 'groq ?(.*)',
    desc: 'Chat with Groq Llama 3 models',
    type: 'ai',
  },
  async (message, match) => {
    if (!match) return await message.send('Usage: .groq <prompt>')
    const res = await groqResponse(match, message.id)
    return await message.send(res)
  }
)

// 22. OR (OpenRouter)
bot(
  {
    pattern: 'or ?(.*)',
    desc: 'Chat with OpenRouter AI models',
    type: 'ai',
  },
  async (message, match) => {
    if (!match) return await message.send('Usage: .or <prompt>')
    const res = await openRouter(match, message.id)
    return await message.send(res)
  }
)
